'use strict';

/**
 * emitter.js — Backend-agnostic instruction buffer with label/patch support.
 *
 * The Emitter stores instructions as JS numbers in this.buf[].
 * Each entry represents one instruction slot of `wordSize` bytes.
 *
 * ARM64 uses wordSize=4 (32-bit instructions).
 * Xtensa LX6 uses wordSize=3 (24-bit instructions).
 *
 * resolve() and toBuffer() are ISA-specific and live in each backend,
 * because patch encoding (BL vs CALL0 etc.) differs per architecture.
 */

class Emitter {
  /**
   * @param {number} wordSize — bytes per instruction slot (4 for ARM64, 3 for Xtensa)
   */
  constructor(wordSize = 4) {
    this.wordSize = wordSize;
    this.buf      = [];      // array of instruction words (each is a JS number, wordSize bytes)
    this.labels   = {};      // name → instruction index
    this.patches  = [];      // { idx, labelName, type, ...extra }
  }

  /**
   * Append one instruction word, return its index in this.buf.
   * @param {number} word
   * @returns {number} index
   */
  emit(word) {
    const idx = this.buf.length;
    this.buf.push(word >>> 0);
    return idx;
  }

  /**
   * Emit a zero-word placeholder and record it for later patching.
   * The backend's resolve() will overwrite this slot with the correct encoding.
   * @param {string} labelName — target label to branch/call to
   * @param {string} type      — patch kind (e.g. 'bl', 'b', 'cbz_x', 'call0', 'j')
   * @param {object} extra     — additional fields stored on the patch record (e.g. { rt: 0 })
   * @returns {number} index of the emitted placeholder
   */
  placeholder(labelName, type, extra = {}) {
    const idx = this.emit(0);
    this.patches.push({ idx, labelName, type, ...extra });
    return idx;
  }

  /**
   * Define a label pointing to the next instruction to be emitted.
   * @param {string} name
   */
  label(name) {
    this.labels[name] = this.buf.length;
  }

  /**
   * Return the current instruction index (= index of the next instruction to be emitted).
   * @returns {number}
   */
  here() {
    return this.buf.length;
  }
}

module.exports = { Emitter };
