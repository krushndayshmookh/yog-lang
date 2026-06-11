#!/usr/bin/env node
'use strict';

/**
 * js2bin.js — JSOS Phase 1 Compiler
 *
 * Compiles a JS dialect source file directly to a flat ARM64 binary image
 * suitable for booting on Raspberry Pi 3 / QEMU raspi3b.
 *
 * No cross-compiler, assembler, or linker required.
 * Every ARM64 instruction is encoded as a 32-bit little-endian word.
 *
 * Supported JS constructs (Phase 1):
 *   - function declarations
 *   - Intrinsic: uart_init()
 *   - Intrinsic: uart_print("literal string")
 *   - Intrinsic: Memory.write32(addr, val)
 *   - Intrinsic: Memory.read32(addr)  [returns value in w0]
 *
 * Binary layout:
 *   Offset 0x00000: Bootstrap (halt cores 1-3, set SP, call kernel_main)
 *   Offset 0x00024: kernel_main and other compiled functions
 *
 * Load address: 0x80000 (QEMU raspi3b default for kernel8.img)
 */

const fs   = require('fs');
const acorn = require('acorn');

// ─── Hardware Constants ───────────────────────────────────────────────────────

const UART0_BASE = 0x3F201000;
const UART0_DR   = UART0_BASE + 0x00;  // Data Register
const UART0_FR   = UART0_BASE + 0x18;  // Flag Register  (bit 5 = TXFF)
const UART0_IBRD = UART0_BASE + 0x24;  // Integer Baud Rate Divisor
const UART0_FBRD = UART0_BASE + 0x28;  // Fractional Baud Rate Divisor
const UART0_LCRH = UART0_BASE + 0x2C;  // Line Control Register
const UART0_CR   = UART0_BASE + 0x30;  // Control Register

// ─── ARM64 Instruction Encoders ───────────────────────────────────────────────
// All return unsigned 32-bit integers (instructions are 4 bytes, little-endian).

/**
 * MOVZ Xd, #imm16, LSL #(hw*16)
 * Load 16-bit zero-extended immediate, zeroing other bits.
 * hw: 0=no shift, 1=lsl#16, 2=lsl#32, 3=lsl#48
 */
function MOVZ_X(rd, imm16, hw = 0) {
  return (0xD2800000 | (hw << 21) | ((imm16 & 0xFFFF) << 5) | (rd & 0x1F)) >>> 0;
}

/**
 * MOVK Xd, #imm16, LSL #(hw*16)
 * Insert 16-bit immediate into register, keeping other bits.
 */
function MOVK_X(rd, imm16, hw = 1) {
  return (0xF2800000 | (hw << 21) | ((imm16 & 0xFFFF) << 5) | (rd & 0x1F)) >>> 0;
}

/**
 * MOVZ Wd, #imm16  (32-bit register, hw always 0 for Phase 1)
 */
function MOVZ_W(rd, imm16) {
  return (0x52800000 | ((imm16 & 0xFFFF) << 5) | (rd & 0x1F)) >>> 0;
}

/**
 * STR Wt, [Xn, #offset]  — store 32-bit word, unsigned scaled offset.
 * offset must be 0 or a multiple of 4, max 16380.
 */
function STR_W(rt, rn, offset = 0) {
  const imm12 = (offset >>> 2) & 0xFFF;
  return (0xB9000000 | (imm12 << 10) | (rn << 5) | rt) >>> 0;
}

/**
 * LDR Wt, [Xn, #offset]  — load 32-bit word, unsigned scaled offset.
 */
function LDR_W(rt, rn, offset = 0) {
  const imm12 = (offset >>> 2) & 0xFFF;
  return (0xB9400000 | (imm12 << 10) | (rn << 5) | rt) >>> 0;
}

/**
 * STR Wzr, [Xn]  — store zero word (clear register at address).
 * WZR = register 31 in 32-bit context.
 */
function STR_WZR(rn, offset = 0) {
  return STR_W(31, rn, offset);
}

/**
 * BL label_offset_words  — branch with link (call), signed 26-bit word offset.
 */
function BL(offset_words) {
  return (0x94000000 | (offset_words & 0x3FFFFFF)) >>> 0;
}

/**
 * B label_offset_words  — unconditional branch, signed 26-bit word offset.
 * Use B(-1) to encode an infinite loop (branch to self).
 */
function B(offset_words) {
  return (0x14000000 | (offset_words & 0x3FFFFFF)) >>> 0;
}

/**
 * CBZ Xt, label_offset_words  — compare and branch if zero, 19-bit signed offset.
 */
function CBZ_X(rt, offset_words) {
  return (0xB4000000 | ((offset_words & 0x7FFFF) << 5) | (rt & 0x1F)) >>> 0;
}

/**
 * CBNZ Wt, label_offset_words  — compare and branch if nonzero (32-bit register).
 * Used for TXFF polling loop.
 */
function CBNZ_W(rt, offset_words) {
  return (0x35000000 | ((offset_words & 0x7FFFF) << 5) | (rt & 0x1F)) >>> 0;
}

/**
 * AND W0, W0, #imm  — logical AND with immediate bitmask.
 * Hardcoded for masking TXFF (bit 5 = 0x20) from the UART FR register.
 * AND W10, W10, #0x20: N=0, immr=0, imms=0 (1 bit), element=32... actually:
 * For single bit at position 5 in 32-bit: immr=27 (=32-5), imms=0
 *   N=0, immr=27=0x1B, imms=0
 *   sf=0, [31]=0, [30-29]=00, [28-23]=100100, [22]=N=0, [21-16]=immr=011011,
 *   [15-10]=imms=000000, [9-5]=Rn, [4-0]=Rd
 * = 0x12000000 | (0 << 22) | (27 << 16) | (0 << 10) | (rn << 5) | rd
 */
function AND_W_BIT5(rd, rn) {
  // AND Wd, Wn, #0x20  (isolate TXFF bit)
  return (0x12000000 | (27 << 16) | (0 << 10) | (rn << 5) | (rd & 0x1F)) >>> 0;
}

/**
 * AND X0, X0, #3  — mask lower 2 bits of X0 (for MPIDR_EL1 core ID check).
 * Bitmask immediate encoding: N=1, immr=0, imms=1 (two consecutive 1s from bit 0).
 */
const AND_X0_CORE_MASK = 0x92400400 >>> 0;

/**
 * MRS X0, MPIDR_EL1  — read Multiprocessor Affinity Register into X0.
 * Bits [1:0] = core ID (0-3).
 */
const MRS_MPIDR_EL1 = 0xD53800A0 >>> 0;

/**
 * WFE  — Wait For Event. Halts the core until an event is received.
 */
const WFE = 0xD503205F >>> 0;

/**
 * RET  — return from function (branches to address in X30/LR).
 */
const RET = 0xD65F03C0 >>> 0;

/**
 * NOP  — no operation.
 */
const NOP = 0xD503201F >>> 0;

/**
 * MOV SP, Xn  — encoded as ADD SP, Xn, #0.
 * [31]=1(sf), [30-29]=00(ADD), [28-24]=10001, [23-22]=00(shift=0),
 * [21-10]=imm12=0, [9-5]=Rn, [4-0]=Rd=31(SP)
 */
function MOV_SP(rn) {
  return (0x91000000 | (rn << 5) | 31) >>> 0;
}

// ─── Address Loader ───────────────────────────────────────────────────────────

/**
 * Emit two instructions that load a 32-bit address/constant into a 64-bit register.
 *   MOVZ Xreg, #lo16
 *   MOVK Xreg, #hi16, LSL #16
 */
function emitLoadAddr(e, reg, addr) {
  const lo = (addr >>> 0)  & 0xFFFF;
  const hi = (addr >>> 16) & 0xFFFF;
  e.emit(MOVZ_X(reg, lo, 0));
  e.emit(MOVK_X(reg, hi, 1));
}

// ─── Binary Emitter ───────────────────────────────────────────────────────────

class Emitter {
  constructor() {
    this.words   = [];   // Array of 32-bit instruction words
    this.labels  = {};   // name → word index
    this.patches = [];   // { idx, labelName, type, extra }
  }

  /** Append one instruction word, return its index. */
  emit(word) {
    const idx = this.words.length;
    this.words.push(word >>> 0);
    return idx;
  }

  /** Emit a placeholder (NOP) and record it for later patching. */
  placeholder(labelName, type, extra = {}) {
    const idx = this.emit(NOP);
    this.patches.push({ idx, labelName, type, ...extra });
    return idx;
  }

  /** Define a label at the current word position. */
  label(name) {
    this.labels[name] = this.words.length;
  }

  /** Current word index (= next instruction position). */
  here() {
    return this.words.length;
  }

  /** Resolve all patches. Call after all code has been emitted. */
  resolve() {
    for (const p of this.patches) {
      const target = this.labels[p.labelName];
      if (target === undefined) {
        throw new Error(`[js2bin] Unresolved label: "${p.labelName}"`);
      }
      const offset = target - p.idx;  // signed word offset

      switch (p.type) {
        case 'bl':    this.words[p.idx] = BL(offset);             break;
        case 'b':     this.words[p.idx] = B(offset);              break;
        case 'cbz_x': this.words[p.idx] = CBZ_X(p.rt, offset);   break;
        default:
          throw new Error(`[js2bin] Unknown patch type: "${p.type}"`);
      }
    }
  }

  /** Serialise to a Buffer (little-endian 32-bit words). */
  toBuffer() {
    this.resolve();
    const buf = Buffer.alloc(this.words.length * 4);
    for (let i = 0; i < this.words.length; i++) {
      buf.writeUInt32LE(this.words[i], i * 4);
    }
    return buf;
  }
}

// ─── Bootstrap Code ───────────────────────────────────────────────────────────

/**
 * Emit the boot stub that runs before kernel_main.
 *
 * Assembly equivalent:
 *   mrs  x0, mpidr_el1    // read core ID
 *   and  x0, x0, #3       // isolate bits [1:0]
 *   cbz  x0, .core0       // if core 0, continue
 * .halt:
 *   wfe                    // cores 1-3: sleep forever
 *   b    .halt
 * .core0:
 *   movz x0, #8, lsl #16  // x0 = 0x80000 (load address = initial stack top)
 *   mov  sp, x0
 *   bl   kernel_main
 * .hang:
 *   b    .hang             // kernel_main returned — loop forever
 */
function emitBootstrap(e) {
  e.emit(MRS_MPIDR_EL1);           // mrs x0, mpidr_el1
  e.emit(AND_X0_CORE_MASK);        // and x0, x0, #3
  // CBZ X0, core0  — patched after core0 label is placed
  e.placeholder('core0', 'cbz_x', { rt: 0 });

  e.label('halt');
  e.emit(WFE);
  e.emit(B(-1));                    // b halt  (self-loop: offset -1 = branch to self)

  e.label('core0');
  // MOVZ X0, #8, LSL #16  →  X0 = 0x00080000 = 0x80000
  e.emit(MOVZ_X(0, 0x0008, 1));
  e.emit(MOV_SP(0));                // mov sp, x0

  e.placeholder('kernel_main', 'bl');  // bl kernel_main

  e.label('hang');
  e.emit(B(-1));                    // b hang  (returned from kernel_main — halt)
}

// ─── UART Intrinsics ──────────────────────────────────────────────────────────

/**
 * Emit code to initialise the PL011 UART at 115200 baud.
 *
 * Sequence:
 *   1. CR = 0          (disable UART)
 *   2. LCRH = 0        (flush TX FIFO)
 *   3. IBRD = 1        (integer baud divisor)
 *   4. FBRD = 40       (fractional baud divisor → 115200 @ 48MHz ref clock)
 *   5. LCRH = 0x70     (8-bit word, FIFO enabled)
 *   6. CR = 0x301      (TX enable + RX enable + UART enable)
 *
 * Uses registers: x8 (UART address), w9 (value to write)
 */
function emitUartInit(e) {
  // 1. Disable UART: CR = 0
  emitLoadAddr(e, 8, UART0_CR);
  e.emit(STR_WZR(8));               // str wzr, [x8]

  // 2. Flush FIFO: LCRH = 0
  emitLoadAddr(e, 8, UART0_LCRH);
  e.emit(STR_WZR(8));

  // 3. IBRD = 1
  emitLoadAddr(e, 8, UART0_IBRD);
  e.emit(MOVZ_W(9, 1));
  e.emit(STR_W(9, 8));

  // 4. FBRD = 40
  emitLoadAddr(e, 8, UART0_FBRD);
  e.emit(MOVZ_W(9, 40));
  e.emit(STR_W(9, 8));

  // 5. LCRH = 0x70  (8-bit, FIFO enabled)
  emitLoadAddr(e, 8, UART0_LCRH);
  e.emit(MOVZ_W(9, 0x70));
  e.emit(STR_W(9, 8));

  // 6. CR = 0x301  (TX + RX + UART enable)
  emitLoadAddr(e, 8, UART0_CR);
  e.emit(MOVZ_W(9, 0x301));
  e.emit(STR_W(9, 8));
}

/**
 * Emit code to write a single character to the UART.
 *
 * Polls TXFF (bit 5 of FR) before writing to avoid overflowing TX FIFO.
 *
 * Uses registers: x8 (address), w9 (char), w10 (FR poll scratch)
 *
 *   // Load FR address
 *   movz x8, #fr_lo
 *   movk x8, #fr_hi, lsl #16
 * .poll:
 *   ldr  w10, [x8]
 *   and  w10, w10, #0x20     // isolate TXFF bit
 *   cbnz w10, .poll          // loop while TX FIFO full
 *   // Load DR address
 *   movz x8, #dr_lo
 *   movk x8, #dr_hi, lsl #16
 *   movz w9, #charCode
 *   str  w9, [x8]
 */
function emitUartPutc(e, charCode) {
  // Load FR address into x8
  emitLoadAddr(e, 8, UART0_FR);

  // Poll TXFF: ldr w10, [x8] ; and w10, w10, #0x20 ; cbnz w10, -3
  const pollStart = e.here();
  e.emit(LDR_W(10, 8));              // ldr w10, [x8]
  e.emit(AND_W_BIT5(10, 10));        // and w10, w10, #0x20
  // CBNZ W10, pollStart — offset from CBNZ position back to pollStart
  // CBNZ is at here(), pollStart is 2 words back, so offset = -2... wait:
  // after LDR and AND: here() = pollStart + 2
  // CBNZ will be at pollStart + 2, target is pollStart
  // offset = pollStart - (pollStart + 2) = -2
  e.emit(CBNZ_W(10, -2));            // cbnz w10, poll  (offset -2 = 2 words back)

  // Write character to DR
  emitLoadAddr(e, 8, UART0_DR);
  e.emit(MOVZ_W(9, charCode & 0xFF));
  e.emit(STR_W(9, 8));
}

/**
 * Emit code to write each character of a string literal to the UART.
 * Handles escape sequences: \n → 0x0A, \r → 0x0D, \t → 0x09, \\ → 0x5C
 */
function emitUartPrint(e, str) {
  for (let i = 0; i < str.length; i++) {
    emitUartPutc(e, str.charCodeAt(i));
  }
}

// ─── JS Compiler ─────────────────────────────────────────────────────────────

class Compiler {
  constructor(source) {
    try {
      this.ast = acorn.parse(source, { ecmaVersion: 2020 });
    } catch (err) {
      throw new Error(`[js2bin] Parse error: ${err.message}`);
    }
    this.e = new Emitter();
  }

  compile() {
    // 1. Emit bootstrap first (load address 0x80000, entry point)
    emitBootstrap(this.e);

    // 2. Walk top-level function declarations and compile each
    for (const node of this.ast.body) {
      if (node.type === 'FunctionDeclaration') {
        this.compileFunction(node);
      }
    }

    // 3. Resolve forward references and return flat binary
    return this.e.toBuffer();
  }

  compileFunction(fn) {
    // Define label matching the function name
    this.e.label(fn.id.name);

    // Compile function body statements
    for (const stmt of fn.body.body) {
      this.compileStatement(stmt);
    }

    // Emit return
    this.e.emit(RET);
  }

  compileStatement(stmt) {
    switch (stmt.type) {
      case 'ExpressionStatement':
        this.compileExpr(stmt.expression);
        break;

      // Future: VariableDeclaration, IfStatement, WhileStatement, ReturnStatement
      default:
        console.warn(`[js2bin] Warning: unsupported statement type "${stmt.type}" — skipped`);
    }
  }

  compileExpr(expr) {
    if (expr.type !== 'CallExpression') {
      console.warn(`[js2bin] Warning: non-call expression ignored`);
      return;
    }

    const callee = expr.callee;
    const args   = expr.arguments;

    // ── uart_init() ─────────────────────────────────────────────────────────
    if (callee.type === 'Identifier' && callee.name === 'uart_init') {
      emitUartInit(this.e);
      return;
    }

    // ── uart_print("...") ────────────────────────────────────────────────────
    if (callee.type === 'Identifier' && callee.name === 'uart_print') {
      const arg = args[0];
      if (!arg || arg.type !== 'Literal' || typeof arg.value !== 'string') {
        throw new Error('[js2bin] uart_print requires a string literal argument');
      }
      emitUartPrint(this.e, arg.value);
      return;
    }

    // ── Memory.write32(addr, val) ─────────────────────────────────────────
    if (callee.type === 'MemberExpression' &&
        callee.object.name === 'Memory' &&
        callee.property.name === 'write32') {
      if (args.length < 2 || args[0].type !== 'Literal' || args[1].type !== 'Literal') {
        throw new Error('[js2bin] Memory.write32 requires two numeric literal arguments');
      }
      const addr = args[0].value >>> 0;
      const val  = args[1].value >>> 0;
      emitLoadAddr(this.e, 0, addr);
      this.e.emit(MOVZ_W(1, val & 0xFFFF));
      this.e.emit(STR_W(1, 0));
      return;
    }

    // ── Memory.read32(addr) — result left in W0 ───────────────────────────
    if (callee.type === 'MemberExpression' &&
        callee.object.name === 'Memory' &&
        callee.property.name === 'read32') {
      if (args.length < 1 || args[0].type !== 'Literal') {
        throw new Error('[js2bin] Memory.read32 requires a numeric literal argument');
      }
      const addr = args[0].value >>> 0;
      emitLoadAddr(this.e, 8, addr);
      this.e.emit(LDR_W(0, 8));     // ldr w0, [x8]
      return;
    }

    console.warn(`[js2bin] Warning: unknown call "${callee.name || callee.type}" — skipped`);
  }
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

function main() {
  const [inputPath, outputPath] = process.argv.slice(2);

  if (!inputPath || !outputPath) {
    console.error('Usage: node js2bin.js <input.js> <output.img>');
    console.error('');
    console.error('Example:');
    console.error('  node js2bin.js kernel.js kernel8.img');
    console.error('  qemu-system-aarch64 -M raspi3b -kernel kernel8.img -serial stdio -display none');
    process.exit(1);
  }

  let source;
  try {
    source = fs.readFileSync(inputPath, 'utf8');
  } catch (err) {
    console.error(`[js2bin] Cannot read input: ${err.message}`);
    process.exit(1);
  }

  let buf;
  try {
    const compiler = new Compiler(source);
    buf = compiler.compile();
  } catch (err) {
    console.error(`[js2bin] Compilation failed: ${err.message}`);
    process.exit(1);
  }

  try {
    fs.writeFileSync(outputPath, buf);
  } catch (err) {
    console.error(`[js2bin] Cannot write output: ${err.message}`);
    process.exit(1);
  }

  const wordCount = buf.length / 4;
  console.log(`[js2bin] OK  ${inputPath} → ${outputPath}`);
  console.log(`[js2bin]     ${buf.length} bytes  (${wordCount} ARM64 instructions)`);
  console.log(`[js2bin]     Load address: 0x80000  Entry: kernel_main`);
  console.log('');
  console.log('To run:');
  console.log(`  qemu-system-aarch64 -M raspi3b -kernel ${outputPath} -serial stdio -display none`);
}

main();
