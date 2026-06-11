'use strict';

/**
 * backends/x86_64.js — x86_64 backend for the Yog compiler.
 *
 * Produces a Linux ELF64 executable that makes raw syscalls (System V AMD64 ABI).
 * Runs natively on Linux x86_64 or via `qemu-x86_64` on other platforms (macOS, ARM).
 *
 * Entry point contract: define `function main(): void`.
 * The _start stub calls main(), then exits with code 0.
 *
 * Key differences from the arm64/xtensa backends:
 *   - Instructions are variable-width (1–15 bytes), so this backend uses a
 *     byte-oriented emitter (X86_64Emitter) instead of fixed-word Emitter.
 *   - Patches reference a 4-byte signed displacement field within the byte stream.
 *   - Output is a fully-formed ELF64 executable, not a flat binary.
 *   - `uart_print` maps to the Linux write(1, buf, len) syscall on stdout.
 *   - `uart_init` is a no-op (stdout is already open).
 *
 * Instruction reference: Intel® 64 and IA-32 Architectures Software Developer's
 * Manual, Vol. 2 (Instruction Set Reference).
 * ELF reference: System V Application Binary Interface — AMD64 Architecture
 * Processor Supplement.
 */

// ─── ELF64 Layout Constants ───────────────────────────────────────────────────

const ELF_HEADER_SIZE  = 64;   // bytes
const PHDR_SIZE        = 56;   // bytes — one PT_LOAD program header entry
const CODE_FILE_OFFSET = ELF_HEADER_SIZE + PHDR_SIZE;   // 120 = 0x78

// Single LOAD segment: map entire file starting at 0x400000.
// Code (and string pool) live at file offset CODE_FILE_OFFSET → vaddr 0x400078.
const LOAD_VADDR  = 0x400000;
const CODE_VADDR  = LOAD_VADDR + CODE_FILE_OFFSET;  // 0x400078

// ─── Linux x86_64 Syscall Numbers ────────────────────────────────────────────

const SYS_write = 1;
const SYS_exit  = 60;

// ─── X86_64Emitter ────────────────────────────────────────────────────────────
//
// Byte-level emitter for variable-width x86_64 instructions.
// Patches record the file offset of a 4-byte displacement field and the label
// they should resolve to.  All offsets are code-relative (byte index in buf[]).

class X86_64Emitter {
  constructor() {
    this.buf      = [];   // flat byte array
    this.labels   = {};   // name → byte offset in buf
    this.patches  = [];   // { offset, labelName, type }
    this.strPool  = [];   // { label, str, bytes } — string literals
    this._strIdx  = 0;    // counter for unique string labels
  }

  /** Append one byte; returns its offset. */
  emitByte(b) {
    this.buf.push(b & 0xFF);
    return this.buf.length - 1;
  }

  /** Append multiple bytes (spread or array). */
  emitBytes(...bytes) {
    for (const b of bytes) this.buf.push(b & 0xFF);
  }

  /**
   * Append a 32-bit signed integer as 4 little-endian bytes.
   * Accepts negative values (two's complement).
   */
  emitI32LE(n) {
    const v = n | 0;  // signed int32
    this.buf.push( v         & 0xFF);
    this.buf.push((v >>>  8) & 0xFF);
    this.buf.push((v >>> 16) & 0xFF);
    this.buf.push((v >>> 24) & 0xFF);
  }

  /**
   * Emit a 4-byte zeroed placeholder and register a patch.
   * `type` tells resolveAndSerialize how to compute the final value.
   * Returns the byte offset of the placeholder's first byte.
   */
  placeholder32(labelName, type) {
    const offset = this.buf.length;
    this.emitI32LE(0);
    this.patches.push({ offset, labelName, type });
    return offset;
  }

  /** Define a label at the current byte position. */
  label(name) { this.labels[name] = this.buf.length; }

  /** Current byte position (useful for size calculations). */
  here() { return this.buf.length; }

  /**
   * Add a string literal to the pool; returns a stable label for LEA patching.
   * Deduplicates by content — the same string always gets the same label.
   */
  addString(str) {
    for (const entry of this.strPool) {
      if (entry.str === str) return entry.label;
    }
    const label = `__str_${this._strIdx++}`;
    this.strPool.push({ label, str, bytes: Buffer.from(str, 'utf8') });
    return label;
  }
}

// ─── x86_64 Instruction Emitters ─────────────────────────────────────────────
//
// Naming: emit<MNEMONIC>_<OPERANDS>(e, ...)
// All functions write directly into an X86_64Emitter.

/**
 * CALL rel32 — near call; pushes return address, jumps to target.
 * Encoding: E8 [rel32 LE]   (5 bytes)
 * rel32 = target_byte_offset − (patch_offset + 4)
 */
function emitCALL(e, targetLabel) {
  e.emitByte(0xE8);
  e.placeholder32(targetLabel, 'rel32');
}

/**
 * JMP rel32 — unconditional near jump.
 * Encoding: E9 [rel32 LE]   (5 bytes)
 */
function emitJMP(e, targetLabel) {
  e.emitByte(0xE9);
  e.placeholder32(targetLabel, 'rel32');
}

/**
 * RET — near return (pops return address from stack).
 * Encoding: C3   (1 byte)
 */
function emitRET(e) { e.emitByte(0xC3); }

/**
 * PUSH RBP — save caller's frame pointer; also re-aligns RSP to 16 bytes
 * (since a CALL pushed an 8-byte return address, breaking the 16-byte alignment
 * required by the System V AMD64 ABI before any nested CALL).
 * Encoding: 55   (1 byte)
 */
function emitPUSH_RBP(e) { e.emitByte(0x55); }

/**
 * POP RBP — restore frame pointer.
 * Encoding: 5D   (1 byte)
 */
function emitPOP_RBP(e) { e.emitByte(0x5D); }

/**
 * MOV RBP, RSP — set frame pointer (used in function prologue).
 * Encoding: REX.W (48) MOV r/m64,r64 (89) ModRM(RBP,RSP) (E5)   (3 bytes)
 */
function emitMOV_RBP_RSP(e) { e.emitBytes(0x48, 0x89, 0xE5); }

/**
 * MOV EAX, imm32 — load 32-bit immediate into EAX; zero-extends to RAX.
 * Used for syscall numbers (all ≤ 2^31).
 * Encoding: B8 [imm32 LE]   (5 bytes)
 */
function emitMOV_EAX_imm32(e, imm) {
  e.emitByte(0xB8);
  e.emitI32LE(imm);
}

/**
 * MOV EDI, imm32 — first syscall argument (fd, exit code, etc.).
 * Zero-extends to RDI.
 * Encoding: BF [imm32 LE]   (5 bytes)
 */
function emitMOV_EDI_imm32(e, imm) {
  e.emitByte(0xBF);
  e.emitI32LE(imm);
}

/**
 * MOV EDX, imm32 — third syscall argument (byte count, etc.).
 * Zero-extends to RDX.
 * Encoding: BA [imm32 LE]   (5 bytes)
 */
function emitMOV_EDX_imm32(e, imm) {
  e.emitByte(0xBA);
  e.emitI32LE(imm);
}

/**
 * LEA RSI, [RIP + disp32] — load a RIP-relative address into RSI.
 * Used to pass string addresses as the second syscall argument (buf pointer).
 *
 * Encoding: REX.W (48) LEA r64,m (8D) ModRM(RIP,RSI) (35) [disp32 LE]  (7 bytes)
 * disp32 = str_byte_offset − (patch_offset + 4)
 * (RIP at execution time = virtual address of the byte following the instruction)
 */
function emitLEA_RSI_rip(e, strLabel) {
  e.emitBytes(0x48, 0x8D, 0x35);
  e.placeholder32(strLabel, 'rip_rel32');
}

/**
 * SYSCALL — transfer control to the OS kernel.
 * On Linux x86_64: RAX=syscall nr, RDI/RSI/RDX/R10/R8/R9=args, RAX=return.
 * Encoding: 0F 05   (2 bytes)
 */
function emitSYSCALL(e) { e.emitBytes(0x0F, 0x05); }

// ─── Bootstrap (_start) ──────────────────────────────────────────────────────

/**
 * Emit the ELF entry stub (_start).
 *
 * The Linux kernel jumps to _start with RSP pointing to argc on the stack
 * and RSP 16-byte aligned. We call main() (which will push RBP, aligning
 * correctly), then exit(0) on return.
 *
 *   _start:
 *     call  main          // invoke user's main()
 *     mov   edi, 0        // exit code = 0
 *     mov   eax, 60       // SYS_exit
 *     syscall             // exit(0)
 */
function emitBootstrap(e) {
  e.label('_start');
  emitCALL(e, 'main');
  emitMOV_EDI_imm32(e, 0);           // exit code 0
  emitMOV_EAX_imm32(e, SYS_exit);    // SYS_exit = 60
  emitSYSCALL(e);                     // _exit(0)
}

// ─── Patch Resolution & ELF Serialisation ─────────────────────────────────────

/**
 * Resolve all patches, append the string pool, wrap in an ELF64 header,
 * and return the final Buffer to write to disk.
 *
 * Binary layout:
 *   [ ELF64 header  : 64 bytes ]
 *   [ PT_LOAD phdr  : 56 bytes ]  ← CODE_FILE_OFFSET = 120
 *   [ _start stub              ]
 *   [ compiled functions       ]
 *   [ string pool (no padding) ]
 *
 * Virtual address mapping:
 *   file offset 0   → vaddr 0x400000
 *   file offset 120 → vaddr 0x400078  (code starts here)
 *   code byte i     → vaddr CODE_VADDR + i
 *   string s at code-relative offset j → vaddr CODE_VADDR + j
 *
 * @param {X86_64Emitter} e
 * @returns {Buffer}
 */
function resolveAndSerialize(e) {
  const codeSize = e.buf.length;

  // ── 1. Register string pool labels (code-relative byte offsets) ────────────
  let strCursor = 0;
  for (const entry of e.strPool) {
    e.labels[entry.label] = codeSize + strCursor;
    strCursor += entry.bytes.length;
  }

  // ── 2. Resolve patches ─────────────────────────────────────────────────────
  for (const p of e.patches) {
    const target = e.labels[p.labelName];
    if (target === undefined) {
      throw new Error(`[yogc/x86_64] Unresolved label: "${p.labelName}"`);
    }

    let disp32;
    if (p.type === 'rel32') {
      // CALL/JMP rel32: displacement = target − (field_offset + 4)
      // At execution: RIP = CODE_VADDR + field_offset + 4
      //               target vaddr = CODE_VADDR + target
      //               disp32 = target − (field_offset + 4)
      disp32 = target - (p.offset + 4);
    } else if (p.type === 'rip_rel32') {
      // LEA RSI, [RIP+disp32]: same formula — RIP points past the 4-byte field
      disp32 = target - (p.offset + 4);
    } else {
      throw new Error(`[yogc/x86_64] Unknown patch type: "${p.type}"`);
    }

    // Write signed 32-bit LE into buf at p.offset
    const v = disp32 | 0;
    e.buf[p.offset]     =  v         & 0xFF;
    e.buf[p.offset + 1] = (v >>>  8) & 0xFF;
    e.buf[p.offset + 2] = (v >>> 16) & 0xFF;
    e.buf[p.offset + 3] = (v >>> 24) & 0xFF;
  }

  // ── 3. Assemble code + string pool ────────────────────────────────────────
  const strBufs = e.strPool.map(s => s.bytes);
  const codePlusData = Buffer.concat([Buffer.from(e.buf), ...strBufs]);
  const fileSize = CODE_FILE_OFFSET + codePlusData.length;
  const entryVAddr = CODE_VADDR + (e.labels['_start'] ?? 0);

  // ── 4. Build ELF64 header (64 bytes) ──────────────────────────────────────
  //
  // Offsets from the ELF64 spec (AMD64 psABI):
  //   0       e_ident[16]
  //   16  2   e_type
  //   18  2   e_machine
  //   20  4   e_version
  //   24  8   e_entry
  //   32  8   e_phoff
  //   40  8   e_shoff
  //   48  4   e_flags
  //   52  2   e_ehsize
  //   54  2   e_phentsize
  //   56  2   e_phnum
  //   58  2   e_shentsize
  //   60  2   e_shnum
  //   62  2   e_shstrndx
  const elf = Buffer.alloc(ELF_HEADER_SIZE, 0);

  // e_ident
  elf[0] = 0x7F; elf[1] = 0x45; elf[2] = 0x4C; elf[3] = 0x46;  // "\x7fELF"
  elf[4] = 2;   // ELFCLASS64
  elf[5] = 1;   // ELFDATA2LSB (little-endian)
  elf[6] = 1;   // EV_CURRENT
  elf[7] = 0;   // ELFOSABI_NONE
  // bytes 8–15 = padding zeros

  elf.writeUInt16LE(2,              16);  // e_type     = ET_EXEC
  elf.writeUInt16LE(0x3E,           18);  // e_machine  = EM_X86_64
  elf.writeUInt32LE(1,              20);  // e_version  = EV_CURRENT
  // e_entry (64-bit): write as two 32-bit halves
  elf.writeUInt32LE(entryVAddr,     24);  // e_entry lo
  elf.writeUInt32LE(0,              28);  // e_entry hi (< 4 GB)
  // e_phoff = 64
  elf.writeUInt32LE(ELF_HEADER_SIZE, 32); // e_phoff lo
  elf.writeUInt32LE(0,              36);  // e_phoff hi
  // e_shoff = 0 (no section headers — not needed for execution)
  elf.writeUInt32LE(0,              40);
  elf.writeUInt32LE(0,              44);
  elf.writeUInt32LE(0,              48);  // e_flags = 0
  elf.writeUInt16LE(ELF_HEADER_SIZE, 52); // e_ehsize
  elf.writeUInt16LE(PHDR_SIZE,      54);  // e_phentsize
  elf.writeUInt16LE(1,              56);  // e_phnum = 1
  elf.writeUInt16LE(64,             58);  // e_shentsize (conventional default)
  elf.writeUInt16LE(0,              60);  // e_shnum = 0
  elf.writeUInt16LE(0,              62);  // e_shstrndx = 0

  // ── 5. Build PT_LOAD program header (56 bytes) ────────────────────────────
  //
  // Offsets:
  //   0   4   p_type
  //   4   4   p_flags
  //   8   8   p_offset
  //   16  8   p_vaddr
  //   24  8   p_paddr
  //   32  8   p_filesz
  //   40  8   p_memsz
  //   48  8   p_align
  const phdr = Buffer.alloc(PHDR_SIZE, 0);

  phdr.writeUInt32LE(1,          0);  // p_type  = PT_LOAD
  phdr.writeUInt32LE(5,          4);  // p_flags = PF_R | PF_X (read + execute)
  // p_offset = 0 — map from file start so ELF + phdr + code all appear at LOAD_VADDR
  phdr.writeUInt32LE(0,          8);  // p_offset lo
  phdr.writeUInt32LE(0,         12);  // p_offset hi
  // p_vaddr = p_paddr = 0x400000
  phdr.writeUInt32LE(LOAD_VADDR, 16);
  phdr.writeUInt32LE(0,          20);
  phdr.writeUInt32LE(LOAD_VADDR, 24);
  phdr.writeUInt32LE(0,          28);
  // p_filesz = p_memsz = total file size
  phdr.writeUInt32LE(fileSize,   32);
  phdr.writeUInt32LE(0,          36);
  phdr.writeUInt32LE(fileSize,   40);
  phdr.writeUInt32LE(0,          44);
  // p_align = 0x200000 (2 MiB — standard for ET_EXEC on Linux)
  phdr.writeUInt32LE(0x200000,   48);
  phdr.writeUInt32LE(0,          52);

  return Buffer.concat([elf, phdr, codePlusData]);
}

// ─── Backend Export ───────────────────────────────────────────────────────────

module.exports = {
  name: 'x86_64',
  wordSize: 1,              // byte-oriented (variable-width instructions)
  defaultOutput: 'app.elf',

  /** x86_64 uses X86_64Emitter (byte-level, string pool). */
  createEmitter() {
    return new X86_64Emitter();
  },

  /** Emit _start before any compiled functions. */
  emitProgramPrologue(e) {
    emitBootstrap(e);
  },

  /**
   * Emit a compiled function with a minimal stack frame.
   *
   * System V AMD64 ABI stack alignment rule:
   *   RSP must be 16-byte aligned immediately before a CALL.
   *   After CALL, RSP is misaligned by 8 (return address pushed).
   *   PUSH RBP pushes another 8 bytes → RSP is 16-byte aligned again.
   *   This allows any nested CALL inside this function to be correct.
   *
   *   <name>:
   *     push rbp          ; 1 byte
   *     mov  rbp, rsp     ; 3 bytes — set up frame
   *     <body>
   *     pop  rbp          ; 1 byte
   *     ret               ; 1 byte
   */
  emitFunction(e, name, compileBody) {
    e.label(name);
    emitPUSH_RBP(e);
    emitMOV_RBP_RSP(e);
    compileBody();
    emitPOP_RBP(e);
    emitRET(e);
  },

  resolveAndSerialize,

  /**
   * Intrinsic call handlers.
   * On Linux x86_64, UART maps to stdout via the write(2) syscall.
   */
  intrinsics: {
    /**
     * uart_init() — no-op on Linux x86_64.
     * stdout (fd 1) is already open; no UART hardware to initialise.
     */
    'uart_init': (_e) => { /* intentionally empty */ },

    /**
     * uart_print("...") — write(stdout, str, len) via Linux syscall.
     *
     * System V AMD64 syscall convention:
     *   rax = syscall number (SYS_write = 1)
     *   rdi = fd             (1 = stdout)
     *   rsi = buf pointer    (RIP-relative address of string literal)
     *   rdx = byte count     (compile-time strlen)
     *
     *   lea  rsi, [rip + strOffset]  ; 7 bytes
     *   mov  edx, len                ; 5 bytes
     *   mov  edi, 1                  ; 5 bytes  (stdout)
     *   mov  eax, 1                  ; 5 bytes  (SYS_write)
     *   syscall                      ; 2 bytes
     */
    'uart_print': (e, str) => {
      if (typeof str !== 'string') {
        throw new Error('[yogc/x86_64] uart_print requires a string literal argument');
      }
      const strLabel = e.addString(str);
      const len = Buffer.byteLength(str, 'utf8');
      emitLEA_RSI_rip(e, strLabel);
      emitMOV_EDX_imm32(e, len);
      emitMOV_EDI_imm32(e, 1);           // stdout
      emitMOV_EAX_imm32(e, SYS_write);
      emitSYSCALL(e);
    },

    /**
     * Memory.write32(addr, val) — Phase 1 stub (no-op in Linux userspace).
     * In a future bare-metal x86_64 target, this would write to a physical
     * address (e.g., via mmap /dev/mem or port I/O).
     */
    'Memory.write32': (_e, _addr, _val) => { /* stub */ },

    /** Memory.read32(addr) — Phase 1 stub. */
    'Memory.read32': (_e, _addr) => { /* stub */ },
  },

  /**
   * How to execute the output binary.
   *
   * Linux x86_64:  run natively (chmod +x first).
   * macOS / ARM:   user-mode QEMU translates x86_64 syscalls to the host kernel.
   * Windows WSL:   run natively inside the WSL environment.
   */
  qemuCommand(outputPath) {
    return [
      `# ── Linux x86_64 (native) ───────────────────────────────────────`,
      `chmod +x ${outputPath}`,
      `./${outputPath}`,
      ``,
      `# ── macOS or other platform (user-mode QEMU) ─────────────────────`,
      `# brew install qemu    (if not already installed)`,
      `qemu-x86_64 ${outputPath}`,
      ``,
      `# Note: qemu-x86_64 is user-mode emulation — it runs Linux x86_64 ELF`,
      `# binaries by translating syscalls to the host OS.  No full VM needed.`,
    ].join('\n');
  },
};
