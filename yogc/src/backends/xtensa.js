'use strict';

/**
 * backends/xtensa.js — Xtensa LX6 backend for the Yog compiler.
 *
 * Targets: Espressif ESP32 (dual-core Xtensa LX6, 240 MHz).
 * Produces a flat binary suitable for loading into IRAM at 0x40080000.
 *
 * Key architecture facts:
 *   - Instructions are 24-bit (3 bytes), little-endian.
 *   - Registers a0–a15 (address registers). a0 = return address (CALL0 ABI), a1 = stack pointer.
 *   - Two calling conventions: windowed (CALL4/8/12) and CALL0 (no register windows).
 *     This backend uses CALL0 throughout for simplicity.
 *   - ROM bootloader starts PRO CPU (core 0), initialises UART0 at 115200 baud, loads
 *     code to IRAM, then jumps to our entry point. APP CPU (core 1) is held in reset.
 *   - No uart_init needed for Phase 1: ROM has already done it.
 *
 * Literal pool strategy:
 *   L32R (the standard way to load 32-bit constants on Xtensa) uses a PC-relative
 *   signed 16-bit word offset to a 4-byte aligned literal in a "literal pool".
 *   This backend uses a GLOBAL literal pool appended at the end of the binary.
 *   All UART addresses are compile-time constants, and the binary is small enough
 *   that L32R can reach the pool (±128KB, i.e. ±32768 32-bit words).
 *
 * IMPORTANT: All instruction encodings should be verified against:
 *   Xtensa ISA Reference Manual (public document from Tensilica/Cadence/Espressif).
 *   https://www.cadence.com/content/dam/cadence-www/global/en_US/documents/tools/ip/tensilica-ip/isa-summary.pdf
 *   ESP32 Technical Reference Manual (for peripheral register maps):
 *   https://www.espressif.com/sites/default/files/documentation/esp32_technical_reference_manual_en.pdf
 */

const { Emitter } = require('../emitter');

// ─── Hardware Constants ───────────────────────────────────────────────────────

const ESP32_IRAM_START   = 0x40080000;   // Code entry point (IRAM)
const ESP32_UART0_BASE   = 0x3FF40000;
const ESP32_UART0_FIFO   = ESP32_UART0_BASE + 0x00;   // Write byte here to transmit
const ESP32_UART0_STATUS = ESP32_UART0_BASE + 0x1C;   // bits [22:16] = TXFIFO_CNT (0..127)

// ─── Xtensa LX6 Instruction Encoders ─────────────────────────────────────────
//
// All encoders return 24-bit values (JS numbers). The emitter stores them in
// this.buf[] and serialises each as 3 little-endian bytes.
//
// Format names and field layouts follow the Xtensa ISA Reference Manual.

/**
 * L32R at, imm16 — load 32-bit word from literal pool (PC-relative).
 *   EA = ((instrAddr + 3) & ~3) + SignExtend(imm16, 16) * 4
 *
 * RI16 format: [23:8]=imm16, [7:4]=t, [3:0]=op0=1
 */
function L32R(at, imm16) {
  return (((imm16 & 0xFFFF) << 8) | ((at & 0xF) << 4) | 0x1) >>> 0;
}

/**
 * S32I at, as, imm8 — store word to memory.
 *   EA = as + imm8 * 4   (op1=0x6)
 *
 * RRI8 format: [3:0]=op0=2, [7:4]=op1=6, [11:8]=t, [15:12]=s, [23:16]=imm8
 */
function S32I(at, as, imm8) {
  return (((imm8 & 0xFF) << 16) | ((as & 0xF) << 12) | ((at & 0xF) << 8) | 0x62) >>> 0;
}

/**
 * L32I at, as, imm8 — load word from memory.
 *   EA = as + imm8 * 4   (op1=0x2)
 *
 * RRI8 format: [3:0]=op0=2, [7:4]=op1=2, [11:8]=t, [15:12]=s, [23:16]=imm8
 */
function L32I(at, as, imm8) {
  return (((imm8 & 0xFF) << 16) | ((as & 0xF) << 12) | ((at & 0xF) << 8) | 0x22) >>> 0;
}

/**
 * MOVI at, imm12 — move sign-extended 12-bit immediate into register.
 *
 * RRI8 format (op1=0xA): [3:0]=op0=2, [7:4]=op1=A, [11:8]=t, [15:12]=imm[11:8], [23:16]=imm[7:0]
 */
function MOVI(at, imm12) {
  // Sign-extend to 12 bits
  const v = ((imm12 & 0xFFF) << 20) >> 20;
  const lo8 = v & 0xFF;
  const hi4 = (v >> 8) & 0xF;
  return ((lo8 << 16) | (hi4 << 12) | ((at & 0xF) << 8) | 0xA2) >>> 0;
}

/**
 * CALL0 offset18 — call subroutine (CALL0 ABI), offset in units of 4 bytes.
 *   EA = ((PC + 4) & ~3) + SignExtend(offset18, 18) * 4
 *   Sets a0 = return address; does NOT use register windows.
 *
 * CALL format: [23:6]=offset18, [5:4]=n=0 (CALL0), [3:0]=op0=5
 */
function CALL0(offset18) {
  return (((offset18 & 0x3FFFF) << 6) | 0x05) >>> 0;
}

/**
 * J offset18 — unconditional direct jump.
 *   EA = PC + 4 + SignExtend(offset18, 18)   (offset in BYTES, not words)
 *
 * CALL format: [23:6]=offset18, [5:4]=n=0, [3:0]=op0=6
 *
 * NOTE: Unlike CALL0, J's offset is in bytes. A self-loop encodes offset=-4
 * (jump back 4 bytes from PC+4 → PC). However some Xtensa implementations
 * define J offset in terms of PC+4 + offset*1 (bytes). Verify against ISA ref.
 * For a hang loop, we use: offset = -4 (from PC+4, go back 4 bytes = land at J itself).
 */
function J(offset18) {
  return (((offset18 & 0x3FFFF) << 6) | 0x06) >>> 0;
}

/**
 * RETW.N — narrow return from windowed call. 2 bytes (narrow encoding).
 * In CALL0 ABI we actually want RET (return to a0), but Xtensa's narrow
 * 2-byte RET.N (0x0D0F) is the densely-encoded return.
 *
 * For CALL0 ABI: JX a0 (jump to address in a0) is the actual return.
 * Encoding JX a0: RRR format, op0=0, op1=0, op2=0, r=0 (JX), s=0, t=A(a0 idx)?
 * Actually the simpler approach is to use the 3-byte CALLX0 a0 ... no, that calls.
 *
 * Correct CALL0 ABI return: JX a0
 *   RRR format: [23:20]=op2=0, [19:16]=op1=0, [15:12]=r=A (JX opcode), [11:8]=s=0(a0), [7:4]=0, [3:0]=op0=0
 *   op2=0, op1=0, r=0xA (JX): encoding 0x0000A0
 *
 * Alternatively, RET.N (narrow, 2 bytes) works when the CALL0 ABI is used with
 * the "Windowed Register" option compiled out — but safer to use JX a0.
 *
 * For Phase 1, we emit JX a0 as the function return instruction.
 * JX a0: [23:20]=0, [19:16]=0, [15:12]=A (0xA=JX), [11:8]=0 (a0), [7:4]=0, [3:0]=0
 */
const JX_A0 = 0x0000A0 >>> 0;  // JX a0 — return in CALL0 ABI

/**
 * NOP — no operation.
 * Encoded as OR a1, a1, a1 (a harmless operation using caller-saved scratch reg).
 *
 * RRR format: [23:20]=op2=8(OR), [19:16]=r=1, [15:12]=s=1, [11:8]=t=1, [7:4]=0, [3:0]=op0=0
 */
const NOP_XTENSA = 0x810100 >>> 0;  // OR a1, a1, a1

// ─── XtensaEmitter ───────────────────────────────────────────────────────────

/**
 * XtensaEmitter extends Emitter with literal pool support.
 *
 * The global literal pool is built up during compilation and flushed at the
 * end of the binary. This avoids complex per-function pool management at the
 * cost of requiring the binary to stay within ±128KB (L32R reach), which is
 * fine for Phase 1 programs.
 *
 * Pool layout (after all code):
 *   [4-byte aligned padding if needed]
 *   lit0: [32-bit value, 4 bytes LE]
 *   lit1: [32-bit value, 4 bytes LE]
 *   ...
 *
 * Each L32R emitted during compilation stores a pending patch:
 *   { instrIdx, reg, litIdx }
 * These are resolved in resolveAndSerialize() once the pool byte offsets are known.
 */
class XtensaEmitter extends Emitter {
  constructor() {
    super(3);           // 3-byte instruction slots
    this.byteLen = 0;   // running byte count of code (for alignment tracking)
    this.litPool = [];  // array of 32-bit literal values
    this.l32rPatches = [];  // { instrIdx, reg, litIdx } — pending L32R fixups
  }

  /** Override emit to track byte length. */
  emit(word) {
    this.byteLen += 3;
    return super.emit(word);
  }

  /**
   * Add a 32-bit value to the global literal pool and return its pool index.
   * If the same value was already registered, re-use it.
   * @param {number} value
   * @returns {number} pool index
   */
  addLiteral(value) {
    const v = value >>> 0;
    const existing = this.litPool.indexOf(v);
    if (existing !== -1) return existing;
    return this.litPool.push(v) - 1;
  }

  /**
   * Emit an L32R instruction targeting a literal pool entry.
   * The actual PC-relative offset is filled in by resolveAndSerialize().
   * @param {number} reg — destination register (a0–a15)
   * @param {number} litIdx — index returned by addLiteral()
   */
  emitL32R(reg, litIdx) {
    const instrIdx = this.buf.length;
    this.l32rPatches.push({ instrIdx, reg, litIdx });
    // Emit placeholder with offset=0; will be patched later
    return this.emit(L32R(reg, 0));
  }
}

// ─── Bootstrap Code ───────────────────────────────────────────────────────────

/**
 * Emit the ESP32 entry stub.
 *
 * The ROM bootloader has already:
 *   - Started PRO CPU (core 0) and loaded our code to IRAM at ESP32_IRAM_START
 *   - Initialised UART0 at 115200 baud
 *   - APP CPU (core 1) is held in reset
 *
 * Entry point contract (ESP32): the user defines two functions:
 *   function setup(): void  — runs once at boot (hardware init, config)
 *   function loop():  void  — called repeatedly forever (main logic)
 *
 * This matches the Arduino / ESP-IDF programming model and avoids the need
 * for an explicit infinite loop in user code.
 *
 * Bootstrap layout (4 instructions = 12 bytes):
 *
 *   idx 0  byte 0:  CALL0 setup    → forward ref placeholder
 * loop_top:
 *   idx 1  byte 3:  CALL0 loop     → forward ref placeholder
 *   idx 2  byte 6:  J loop_top     → back-ref placeholder (jumps to byte 3)
 * hang:
 *   idx 3  byte 9:  J -4           → unreachable self-loop (safety net)
 *
 * After 12 bytes of bootstrap, all functions are emitted starting at byte 12
 * (4-byte aligned). emitFunction() inserts NOP padding before each label to
 * maintain 4-byte alignment regardless of instruction count in prior functions.
 *
 * CALL0 EA formula: ((PC+4) & ~3) + SignExtend(offset18, 18) * 4
 * → targets must be 4-byte aligned. ✓ (enforced by emitFunction padding)
 *
 * J EA formula: PC + 4 + SignExtend(offset18, 18)   (bytes)
 * J loop_top at byte 6: EA = 6 + 4 + (-7) = 3  ✓
 */
function emitBootstrap(e) {
  // idx 0  byte 0: CALL0 setup — run setup() once at boot
  e.placeholder('setup', 'call0');

  // idx 1  byte 3: CALL0 loop — call loop() ...
  e.label('loop_top');
  e.placeholder('loop', 'call0');

  // idx 2  byte 6: J loop_top — ...repeat forever
  // EA = 6 + 4 + offset = 3  →  offset = -7 (resolved by resolveAndSerialize 'j' case)
  e.placeholder('loop_top', 'j');

  // idx 3  byte 9: J -4 — unreachable self-loop (safety net if loop falls through)
  e.label('hang');
  e.emit(J((-4) & 0x3FFFF));
}

// ─── UART Driver ─────────────────────────────────────────────────────────────

/**
 * uart_init — no-op for ESP32 Phase 1.
 * The ROM bootloader initialises UART0 at 115200 baud before calling our code.
 * Nothing to do here; the function is accepted for source compatibility.
 */
function emitUartInit(/* e */) {
  // intentionally empty
}

/**
 * Emit code to write one character byte to UART0 FIFO.
 *
 * Phase 1 strategy: write directly without polling.
 * The UART0 FIFO is 128 bytes deep; "Hello World\r\n" (13 bytes) fits easily.
 *
 * Registers used: a2 = FIFO address, a3 = character value
 *
 * @param {XtensaEmitter} e
 * @param {number} charCode — ASCII code of character to send
 */
function emitUartPutc(e, charCode) {
  const litIdx = e.addLiteral(ESP32_UART0_FIFO);
  e.emitL32R(2, litIdx);                    // L32R a2, &ESP32_UART0_FIFO
  e.emit(MOVI(3, charCode & 0x7F));         // MOVI a3, charCode
  e.emit(S32I(3, 2, 0));                    // S32I a3, a2, 0  (write byte to FIFO)
}

/**
 * Emit code to write each character of a string literal to UART0.
 * @param {XtensaEmitter} e
 * @param {string} str
 */
function emitUartPrint(e, str) {
  for (let i = 0; i < str.length; i++) {
    emitUartPutc(e, str.charCodeAt(i));
  }
}

// ─── Patch Resolution & Serialisation ────────────────────────────────────────

/**
 * Resolve all patches (CALL0/J forward refs + L32R literal pool refs) and
 * serialise the binary.
 *
 * Binary layout:
 *   [0 .. codeBytes-1]         : instruction stream (3 bytes each)
 *   [padBytes]                 : 0–3 zero bytes to reach 4-byte alignment
 *   [poolStart .. poolEnd]     : literal pool (4 bytes per entry, LE uint32)
 *
 * @param {XtensaEmitter} e
 * @returns {Buffer}
 */
function resolveAndSerialize(e) {
  const instrCount = e.buf.length;
  const codeBytes  = instrCount * 3;

  // Compute pool start (4-byte aligned after code)
  const padBytes   = (4 - (codeBytes % 4)) % 4;
  const poolStart  = codeBytes + padBytes;

  // ── Resolve label-targeted patches (CALL0, J) ──────────────────────────────
  for (const p of e.patches) {
    const target = e.labels[p.labelName];
    if (target === undefined) {
      throw new Error(`[yogc/xtensa] Unresolved label: "${p.labelName}"`);
    }

    // Convert instruction indices to byte addresses (assuming base = 0)
    const instrByteAddr  = p.idx * 3;
    const targetByteAddr = target * 3;

    switch (p.type) {
      case 'call0': {
        // CALL0 offset: EA = ((PC+4) & ~3) + SignExtend(offset18, 18) * 4
        // PC = instrByteAddr, EA = targetByteAddr
        const base     = (instrByteAddr + 4) & ~3;
        const byteOff  = targetByteAddr - base;
        if (byteOff % 4 !== 0) {
          throw new Error(`[yogc/xtensa] CALL0 target "${p.labelName}" is not 4-byte aligned (offset=${byteOff})`);
        }
        const offset18 = (byteOff >> 2) & 0x3FFFF;
        e.buf[p.idx] = CALL0(offset18);
        break;
      }
      case 'j': {
        // J offset: EA = PC + 4 + SignExtend(offset18, 18)  (bytes)
        const byteOff  = targetByteAddr - (instrByteAddr + 4);
        const offset18 = byteOff & 0x3FFFF;
        e.buf[p.idx] = J(offset18);
        break;
      }
      default:
        throw new Error(`[yogc/xtensa] Unknown patch type: "${p.type}"`);
    }
  }

  // ── Resolve L32R patches (literal pool references) ─────────────────────────
  for (const lp of e.l32rPatches) {
    const instrByteAddr = lp.instrIdx * 3;
    // L32R base: (instrByteAddr + 3) & ~3  (next 4-byte aligned address after instruction)
    const l32rBase      = (instrByteAddr + 3) & ~3;
    const litByteAddr   = poolStart + lp.litIdx * 4;
    const wordOffset    = (litByteAddr - l32rBase) >> 2;

    if (wordOffset < -32768 || wordOffset > 32767) {
      throw new Error(
        `[yogc/xtensa] L32R literal[${lp.litIdx}] out of reach: ` +
        `instrAddr=0x${instrByteAddr.toString(16)}, litAddr=0x${litByteAddr.toString(16)}, ` +
        `wordOffset=${wordOffset} (range: ±32767)`
      );
    }

    e.buf[lp.instrIdx] = L32R(lp.reg, wordOffset & 0xFFFF);
  }

  // ── Serialise ──────────────────────────────────────────────────────────────
  const poolBytes  = e.litPool.length * 4;
  const totalBytes = poolStart + poolBytes;
  const out        = Buffer.alloc(totalBytes, 0);

  // Write instructions (3 bytes each, little-endian)
  for (let i = 0; i < instrCount; i++) {
    const word = e.buf[i] >>> 0;
    const off  = i * 3;
    out[off]     = (word)       & 0xFF;
    out[off + 1] = (word >> 8)  & 0xFF;
    out[off + 2] = (word >> 16) & 0xFF;
  }

  // Padding bytes are already zero (Buffer.alloc zeroes)

  // Write literal pool (4 bytes each, little-endian)
  for (let i = 0; i < e.litPool.length; i++) {
    out.writeUInt32LE(e.litPool[i] >>> 0, poolStart + i * 4);
  }

  return out;
}

// ─── Backend Export ───────────────────────────────────────────────────────────

module.exports = {
  name: 'xtensa-esp32',
  wordSize: 3,           // 24-bit instructions
  defaultOutput: 'app.bin',
  NOP: NOP_XTENSA,

  /** Xtensa uses XtensaEmitter (tracks literal pool, byte offsets). */
  createEmitter() {
    return new XtensaEmitter();
  },

  /** Emit the ESP32 entry stub before any compiled functions. */
  emitProgramPrologue(e) {
    emitBootstrap(e);
  },

  /**
   * Emit a compiled function: align to 4 bytes, label, body, then JX a0.
   *
   * CALL0 targets must be 4-byte aligned. Since Xtensa instructions are 3
   * bytes each, consecutive functions may land at unaligned byte offsets.
   * We insert NOP_XTENSA pads before each label to enforce alignment.
   *
   * @param {XtensaEmitter} e
   * @param {string} name
   * @param {function} compileBody
   */
  emitFunction(e, name, compileBody) {
    // Pad to 4-byte alignment before function entry point
    while (e.byteLen % 4 !== 0) {
      e.emit(NOP_XTENSA);
    }
    e.label(name);
    compileBody();
    e.emit(JX_A0);       // return to caller (CALL0 ABI: return addr in a0)
  },

  /** Resolve patches, flush literal pool, write binary. */
  resolveAndSerialize,

  /**
   * Intrinsic call handlers.
   * Each handler receives (emitter, ...resolvedArgs).
   */
  intrinsics: {
    /**
     * uart_init() — no-op on ESP32: ROM bootloader handles UART0 init.
     */
    'uart_init': (_e) => {
      emitUartInit();
    },

    /**
     * uart_print("...") — write each character to UART0 FIFO.
     */
    'uart_print': (e, str) => {
      if (typeof str !== 'string') {
        throw new Error('[yogc/xtensa] uart_print requires a string literal argument');
      }
      emitUartPrint(e, str);
    },

    /**
     * Memory.write32(addr, val) — store a 32-bit value to a memory-mapped register.
     *   Registers: a2 = address, a3 = value
     */
    'Memory.write32': (e, addr, val) => {
      if (addr == null || val == null) {
        throw new Error('[yogc/xtensa] Memory.write32 requires two numeric literal arguments');
      }
      const litIdx = e.addLiteral(addr >>> 0);
      e.emitL32R(2, litIdx);                  // L32R a2, &addr
      e.emit(MOVI(3, (val >>> 0) & 0xFFF));   // MOVI a3, val  (12-bit, sign-extended)
      e.emit(S32I(3, 2, 0));                  // S32I a3, a2, 0
    },

    /**
     * Memory.read32(addr) — load a 32-bit value from a memory-mapped register.
     * Result is left in a2.
     *   Registers: a2 = address (then result)
     */
    'Memory.read32': (e, addr) => {
      if (addr == null) {
        throw new Error('[yogc/xtensa] Memory.read32 requires a numeric literal argument');
      }
      const litIdx = e.addLiteral(addr >>> 0);
      e.emitL32R(2, litIdx);   // L32R a2, &addr
      e.emit(L32I(2, 2, 0));   // L32I a2, a2, 0  (load from that address into a2)
    },
  },

  /**
   * QEMU invocation hint.
   * ESP32 QEMU requires Espressif's QEMU fork — the upstream qemu-system-xtensa
   * does not implement the ESP32 peripheral model.
   */
  qemuCommand(outputPath) {
    return [
      '# ESP32 QEMU requires Espressif\'s QEMU fork:',
      '# https://github.com/espressif/qemu',
      `# qemu-system-xtensa -M esp32 -nographic -serial stdio \\`,
      `#   -drive file=${outputPath},if=mtd,format=raw`,
      '#',
      '# Note: a real ESP32 flash image also needs the ROM bootloader header.',
      '# For bare-IRAM testing, load via OpenOCD:',
      `#   openocd -f board/esp32-wrover-kit-3.3v.cfg \\`,
      `#     -c "program ${outputPath} 0x40080000 verify reset exit"`,
      '# See docs/guide/targets.md for full ESP32 setup instructions.',
    ].join('\n');
  },
};
