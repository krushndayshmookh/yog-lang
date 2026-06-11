'use strict';

/**
 * backends/arm64.js — ARM64 (AArch64) backend for the Yog compiler.
 *
 * Targets: Raspberry Pi 3 (BCM2837) and QEMU raspi3b.
 * Produces a flat binary image (kernel8.img) loaded at 0x80000.
 *
 * All instruction encoders return unsigned 32-bit integers.
 * Instructions are serialised as little-endian 32-bit words.
 *
 * Instruction encodings are drawn from:
 *   ARM Architecture Reference Manual, ARMv8, for ARMv8-A architecture profile.
 *   https://developer.arm.com/documentation/ddi0487/latest
 */

const { Emitter } = require('../emitter');

// ─── Hardware Constants ───────────────────────────────────────────────────────

const UART0_BASE = 0x3F201000;  // BCM2837 PL011 UART base
const UART0_DR   = UART0_BASE + 0x00;  // Data Register
const UART0_FR   = UART0_BASE + 0x18;  // Flag Register  (bit 5 = TXFF)
const UART0_IBRD = UART0_BASE + 0x24;  // Integer Baud Rate Divisor
const UART0_FBRD = UART0_BASE + 0x28;  // Fractional Baud Rate Divisor
const UART0_LCRH = UART0_BASE + 0x2C;  // Line Control Register
const UART0_CR   = UART0_BASE + 0x30;  // Control Register

// ─── ARM64 Instruction Encoders ───────────────────────────────────────────────
// All return unsigned 32-bit integers (instructions are 4 bytes, little-endian).

/** MOVZ Xd, #imm16, LSL #(hw*16) — load 16-bit immediate, zeroing other bits. */
function MOVZ_X(rd, imm16, hw = 0) {
  return (0xD2800000 | (hw << 21) | ((imm16 & 0xFFFF) << 5) | (rd & 0x1F)) >>> 0;
}

/** MOVK Xd, #imm16, LSL #(hw*16) — insert 16-bit immediate, keeping other bits. */
function MOVK_X(rd, imm16, hw = 1) {
  return (0xF2800000 | (hw << 21) | ((imm16 & 0xFFFF) << 5) | (rd & 0x1F)) >>> 0;
}

/** MOVZ Wd, #imm16 — 32-bit variant. */
function MOVZ_W(rd, imm16) {
  return (0x52800000 | ((imm16 & 0xFFFF) << 5) | (rd & 0x1F)) >>> 0;
}

/** STR Wt, [Xn, #offset] — store 32-bit word, unsigned scaled offset (must be multiple of 4). */
function STR_W(rt, rn, offset = 0) {
  const imm12 = (offset >>> 2) & 0xFFF;
  return (0xB9000000 | (imm12 << 10) | (rn << 5) | rt) >>> 0;
}

/** LDR Wt, [Xn, #offset] — load 32-bit word, unsigned scaled offset. */
function LDR_W(rt, rn, offset = 0) {
  const imm12 = (offset >>> 2) & 0xFFF;
  return (0xB9400000 | (imm12 << 10) | (rn << 5) | rt) >>> 0;
}

/** STR Wzr, [Xn, #offset] — store zero (clear memory). */
function STR_WZR(rn, offset = 0) {
  return STR_W(31, rn, offset);
}

/** BL label_offset_words — branch with link (function call), signed 26-bit word offset. */
function BL(offset_words) {
  return (0x94000000 | (offset_words & 0x3FFFFFF)) >>> 0;
}

/** B label_offset_words — unconditional branch. B(-1) = infinite self-loop. */
function B(offset_words) {
  return (0x14000000 | (offset_words & 0x3FFFFFF)) >>> 0;
}

/** CBZ Xt, label_offset_words — branch if zero, 19-bit signed offset. */
function CBZ_X(rt, offset_words) {
  return (0xB4000000 | ((offset_words & 0x7FFFF) << 5) | (rt & 0x1F)) >>> 0;
}

/** CBNZ Wt, label_offset_words — branch if nonzero, 32-bit register. */
function CBNZ_W(rt, offset_words) {
  return (0x35000000 | ((offset_words & 0x7FFFF) << 5) | (rt & 0x1F)) >>> 0;
}

/** AND Wd, Wn, #0x20 — isolate TXFF bit (bit 5) from UART FR register. */
function AND_W_BIT5(rd, rn) {
  return (0x12000000 | (27 << 16) | (0 << 10) | (rn << 5) | (rd & 0x1F)) >>> 0;
}

/** AND X0, X0, #3 — mask lower 2 bits for MPIDR_EL1 core ID check. */
const AND_X0_CORE_MASK = 0x92400400 >>> 0;

/** MRS X0, MPIDR_EL1 — read core ID register. */
const MRS_MPIDR_EL1 = 0xD53800A0 >>> 0;

/** WFE — wait for event (halts core until woken). */
const WFE = 0xD503205F >>> 0;

/** RET — return from function (branches to LR / X30). */
const RET = 0xD65F03C0 >>> 0;

/** NOP — no operation. */
const NOP = 0xD503201F >>> 0;

/** MOV SP, Xn — encoded as ADD SP, Xn, #0. */
function MOV_SP(rn) {
  return (0x91000000 | (rn << 5) | 31) >>> 0;
}

// ─── Address Loader ───────────────────────────────────────────────────────────

/**
 * Emit MOVZ + MOVK pair to load a 32-bit address/constant into a 64-bit register.
 *   MOVZ Xreg, #lo16
 *   MOVK Xreg, #hi16, LSL #16
 */
function emitLoadAddr(e, reg, addr) {
  const lo = (addr >>> 0)  & 0xFFFF;
  const hi = (addr >>> 16) & 0xFFFF;
  e.emit(MOVZ_X(reg, lo, 0));
  e.emit(MOVK_X(reg, hi, 1));
}

// ─── Bootstrap Code ───────────────────────────────────────────────────────────

/**
 * Emit the boot stub that runs before main().
 *
 * Entry point contract (ARM64): the user defines `function main(): void`.
 * The bootstrap sets up the stack and calls it. On return, halts.
 *
 *   mrs  x0, mpidr_el1    // read core ID
 *   and  x0, x0, #3       // isolate bits [1:0]
 *   cbz  x0, .core0       // core 0 → continue
 * .halt:
 *   wfe                    // cores 1-3: sleep forever
 *   b    .halt
 * .core0:
 *   movz x0, #8, lsl #16  // x0 = 0x80000 (stack top = load address)
 *   mov  sp, x0
 *   bl   main              // call user's main()
 * .hang:
 *   b    .hang             // main() returned — halt
 */
function emitBootstrap(e) {
  e.emit(MRS_MPIDR_EL1);
  e.emit(AND_X0_CORE_MASK);
  e.placeholder('core0', 'cbz_x', { rt: 0 });

  e.label('halt');
  e.emit(WFE);
  e.emit(B(-1));

  e.label('core0');
  e.emit(MOVZ_X(0, 0x0008, 1));   // x0 = 0x80000
  e.emit(MOV_SP(0));
  e.placeholder('main', 'bl');    // BL main()

  e.label('hang');
  e.emit(B(-1));
}

// ─── UART Driver ─────────────────────────────────────────────────────────────

/**
 * Initialise PL011 UART at 115200 baud (48MHz ref clock).
 * Registers: x8 = address, w9 = value
 */
function emitUartInit(e) {
  emitLoadAddr(e, 8, UART0_CR);   e.emit(STR_WZR(8));          // CR = 0 (disable)
  emitLoadAddr(e, 8, UART0_LCRH); e.emit(STR_WZR(8));          // LCRH = 0 (flush)
  emitLoadAddr(e, 8, UART0_IBRD); e.emit(MOVZ_W(9, 1));    e.emit(STR_W(9, 8));  // IBRD = 1
  emitLoadAddr(e, 8, UART0_FBRD); e.emit(MOVZ_W(9, 40));   e.emit(STR_W(9, 8));  // FBRD = 40
  emitLoadAddr(e, 8, UART0_LCRH); e.emit(MOVZ_W(9, 0x70)); e.emit(STR_W(9, 8));  // 8-bit + FIFO
  emitLoadAddr(e, 8, UART0_CR);   e.emit(MOVZ_W(9, 0x301)); e.emit(STR_W(9, 8)); // TX+RX+enable
}

/**
 * Emit code to write a single character to the UART.
 * Polls TXFF (bit 5 of FR) to avoid overflowing TX FIFO.
 * Registers: x8 = address, w9 = char, w10 = poll scratch
 */
function emitUartPutc(e, charCode) {
  emitLoadAddr(e, 8, UART0_FR);
  e.emit(LDR_W(10, 8));
  e.emit(AND_W_BIT5(10, 10));
  e.emit(CBNZ_W(10, -2));         // loop while TXFF set
  emitLoadAddr(e, 8, UART0_DR);
  e.emit(MOVZ_W(9, charCode & 0xFF));
  e.emit(STR_W(9, 8));
}

/**
 * Emit code to write each character of a string literal to the UART.
 */
function emitUartPrint(e, str) {
  for (let i = 0; i < str.length; i++) {
    emitUartPutc(e, str.charCodeAt(i));
  }
}

// ─── Patch Resolution & Serialisation ────────────────────────────────────────

/**
 * Resolve all forward-reference patches and serialise to a Buffer.
 * Called by the Compiler after all code has been emitted.
 * @param {Emitter} e
 * @returns {Buffer} flat binary image (little-endian 32-bit words)
 */
function resolveAndSerialize(e) {
  // Resolve patches
  for (const p of e.patches) {
    const target = e.labels[p.labelName];
    if (target === undefined) {
      throw new Error(`[yogc/arm64] Unresolved label: "${p.labelName}"`);
    }
    const offset = target - p.idx;

    switch (p.type) {
      case 'bl':    e.buf[p.idx] = BL(offset);            break;
      case 'b':     e.buf[p.idx] = B(offset);             break;
      case 'cbz_x': e.buf[p.idx] = CBZ_X(p.rt, offset);  break;
      default:
        throw new Error(`[yogc/arm64] Unknown patch type: "${p.type}"`);
    }
  }

  // Serialise: each word as 4 LE bytes
  const buf = Buffer.alloc(e.buf.length * 4);
  for (let i = 0; i < e.buf.length; i++) {
    buf.writeUInt32LE(e.buf[i] >>> 0, i * 4);
  }
  return buf;
}

// ─── Backend Export ───────────────────────────────────────────────────────────

module.exports = {
  name: 'arm64',
  wordSize: 4,           // 32-bit instructions
  defaultOutput: 'kernel8.img',
  NOP,

  /** ARM64 uses the base Emitter (4-byte words). */
  createEmitter() {
    return new Emitter(4);
  },

  /** Emit the boot stub before any compiled functions. */
  emitProgramPrologue(e) {
    emitBootstrap(e);
  },

  /**
   * Emit a compiled function: label, body, then RET.
   * @param {Emitter} e
   * @param {string} name
   * @param {function} compileBody — callback that emits the function's instructions
   */
  emitFunction(e, name, compileBody) {
    e.label(name);
    compileBody();
    e.emit(RET);
  },

  /** Resolve patches and write the final binary. */
  resolveAndSerialize,

  /**
   * Intrinsic call handlers.
   * Each handler receives (emitter, ...resolvedArgs) and emits the appropriate instructions.
   */
  intrinsics: {
    'uart_init': (e) => {
      emitUartInit(e);
    },
    'uart_print': (e, str) => {
      if (typeof str !== 'string') {
        throw new Error('[yogc/arm64] uart_print requires a string literal argument');
      }
      emitUartPrint(e, str);
    },
    'Memory.write32': (e, addr, val) => {
      if (addr == null || val == null) {
        throw new Error('[yogc/arm64] Memory.write32 requires two numeric literal arguments');
      }
      emitLoadAddr(e, 0, (addr >>> 0));
      e.emit(MOVZ_W(1, ((val >>> 0) & 0xFFFF)));
      e.emit(STR_W(1, 0));
    },
    'Memory.read32': (e, addr) => {
      if (addr == null) {
        throw new Error('[yogc/arm64] Memory.read32 requires a numeric literal argument');
      }
      emitLoadAddr(e, 8, (addr >>> 0));
      e.emit(LDR_W(0, 8));
    },
  },

  /** QEMU invocation hint printed after successful compilation. */
  qemuCommand(outputPath) {
    return (
      `qemu-system-aarch64 -M raspi3b -kernel ${outputPath} -serial stdio -display none`
    );
  },
};
