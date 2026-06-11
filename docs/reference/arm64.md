# ARM64 Backend Reference

The ARM64 backend targets the **Raspberry Pi 3 (BCM2837)** and QEMU `raspi3b`. It produces a **flat binary image** (`kernel8.img`) that the Pi firmware loads directly into memory and executes at address `0x80000`.

Source: `yogc/src/backends/arm64.js`

## Output Format

| Property | Value |
|---|---|
| File name | `kernel8.img` |
| Format | Flat binary (no ELF headers) |
| Load address | `0x80000` |
| Instruction width | 32-bit fixed (4 bytes each) |
| Byte order | Little-endian |

All instructions are serialised as 4-byte little-endian words. The binary is loaded verbatim by the Raspberry Pi GPU firmware before the CPU is released.

## Instruction Encoders

All encoders return unsigned 32-bit integers drawn from the ARMv8 Architecture Reference Manual (DDI0487).

### MOVZ_X — Move with Zero (64-bit)

```
MOVZ Xd, #imm16, LSL #(hw * 16)
```

Loads a 16-bit immediate into the selected 16-bit field of a 64-bit register, zeroing all other bits.

| Parameter | Meaning |
|---|---|
| `rd` | Destination register (0–30; 31 = XZR) |
| `imm16` | 16-bit immediate value |
| `hw` | Shift amount selector: 0 = bits [15:0], 1 = bits [31:16], 2 = bits [47:32], 3 = bits [63:48] |

Encoding: `0xD2800000 | (hw << 21) | (imm16 << 5) | rd`

### MOVK_X — Move with Keep (64-bit)

```
MOVK Xd, #imm16, LSL #(hw * 16)
```

Same field layout as `MOVZ_X`, but leaves other 16-bit fields unchanged. Used as the second half of a two-instruction 32-bit address load.

Encoding: `0xF2800000 | (hw << 21) | (imm16 << 5) | rd`

### MOVZ_W — Move with Zero (32-bit)

```
MOVZ Wd, #imm16
```

32-bit variant of MOVZ; `hw` is always 0. Used when loading small values into registers for UART writes.

Encoding: `0x52800000 | (imm16 << 5) | rd`

### STR_W — Store 32-bit Word

```
STR Wt, [Xn, #offset]
```

Stores a 32-bit register to memory. `offset` must be a multiple of 4; the encoded `imm12` field holds `offset / 4`.

Encoding: `0xB9000000 | (imm12 << 10) | (rn << 5) | rt`

### LDR_W — Load 32-bit Word

```
LDR Wt, [Xn, #offset]
```

Loads a 32-bit value from memory. Same offset scaling as `STR_W`.

Encoding: `0xB9400000 | (imm12 << 10) | (rn << 5) | rt`

### STR_WZR — Store Zero

```
STR Wzr, [Xn, #offset]
```

Clears a 32-bit memory location by storing the zero register (`Wzr`, encoded as `rt = 31`). Implemented as `STR_W(31, rn, offset)`.

### BL — Branch with Link

```
BL <label>
```

Calls a subroutine. Stores the return address in `X30` (LR) and jumps to `PC + offset_words * 4`. The 26-bit signed word offset gives a ±128 MB reach.

Encoding: `0x94000000 | (offset_words & 0x3FFFFFF)`

### B — Unconditional Branch

```
B <label>
```

Jumps to `PC + offset_words * 4`. Same 26-bit reach as BL. `B(-1)` encodes an infinite self-loop (branch to itself).

Encoding: `0x14000000 | (offset_words & 0x3FFFFFF)`

### CBZ_X — Compare and Branch if Zero (64-bit)

```
CBZ Xt, <label>
```

Branches if the 64-bit register is zero. 19-bit signed word offset (±4 MB reach). Used in the bootstrap to route core 0 past the WFE halt loop.

Encoding: `0xB4000000 | ((offset_words & 0x7FFFF) << 5) | rt`

### CBNZ_W — Compare and Branch if Nonzero (32-bit)

```
CBNZ Wt, <label>
```

Branches if the 32-bit register is nonzero. 19-bit signed word offset. Used in `uart_putc` to loop while the TX FIFO full flag is set.

Encoding: `0x35000000 | ((offset_words & 0x7FFFF) << 5) | rt`

### AND_W_BIT5 — AND with Bit 5 Mask

```
AND Wd, Wn, #0x20
```

Isolates bit 5 (TXFF — TX FIFO Full) from the UART Flag Register. The immediate mask `0x20` is encoded as a bitmask immediate using the ARM64 logical-immediate encoding (`imms=27, immr=0`).

Encoding: `0x12000000 | (27 << 16) | (0 << 10) | (rn << 5) | rd`

### AND_X0_CORE_MASK — AND X0 with Core ID Mask

```
AND X0, X0, #3
```

Constant encoding (`0x92400400`). Masks bits [1:0] of `X0` to extract the CPU core number from `MPIDR_EL1`. Only cores 1–3 are halted; core 0 proceeds.

### MRS_MPIDR_EL1 — Read Core ID

```
MRS X0, MPIDR_EL1
```

Constant encoding (`0xD53800A0`). Reads the Multiprocessor Affinity Register into `X0`. On the BCM2837, bits [1:0] hold the CPU core number (0–3).

### WFE — Wait for Event

Constant encoding (`0xD503205F`). Suspends the current core until an event or interrupt is signalled. Cores 1–3 loop on WFE to avoid consuming power while idle.

### RET — Return from Function

Constant encoding (`0xD65F03C0`). Branches to the address in `X30` (LR). Emitted at the end of every compiled function.

### NOP — No Operation

Constant encoding (`0xD503201F`). Used for alignment padding if required.

### MOV_SP — Move to Stack Pointer

```
MOV SP, Xn    (encoded as ADD SP, Xn, #0)
```

Sets the stack pointer from a general-purpose register. ARM64 does not have a direct `MOV SP, Xn`; the assembler maps it to `ADD SP, Xn, #0`.

Encoding: `0x91000000 | (rn << 5) | 31`

## emitLoadAddr — 32-bit Address Loader

Loading arbitrary 32-bit addresses requires two instructions because MOVZ only provides 16 bits at a time:

```
emitLoadAddr(e, reg, addr)
  →  MOVZ Xreg, #(addr & 0xFFFF)           // bits [15:0], hw=0 (zero top)
     MOVK Xreg, #((addr >> 16) & 0xFFFF), LSL #16  // bits [31:16], hw=1 (keep bottom)
```

This sequence always produces a 64-bit register holding the 32-bit address zero-extended. All UART register loads use this pair.

## Bootstrap

The bootstrap runs before `main()`. It must:

1. Park cores 1–3 so they do not corrupt memory or I/O
2. Set up a valid stack pointer
3. Call the user's `main()`
4. Halt after `main()` returns

### Assembly listing

```asm
        mrs   x0, mpidr_el1   ; read core ID (bits [1:0] = core number)
        and   x0, x0, #3      ; isolate core field
        cbz   x0, .core0      ; if core 0 → skip the halt loop

.halt:
        wfe                   ; cores 1-3: wait for event (sleep)
        b     .halt           ; loop forever

.core0:
        movz  x0, #8, lsl #16 ; x0 = 0x00080000 = 0x80000 (stack top = load address)
        mov   sp, x0          ; set stack pointer
        bl    main            ; call user's main()

.hang:
        b     .hang           ; main() returned — halt
```

The stack grows downward from `0x80000`, which is the exact byte where the kernel image begins. On a bare Pi3, RAM below `0x80000` is free for stack use.

### Emitter sequence (word indices)

| idx | Instruction | Note |
|---|---|---|
| 0 | `MRS_MPIDR_EL1` | Read core ID into X0 |
| 1 | `AND_X0_CORE_MASK` | Mask to bits [1:0] |
| 2 | `CBZ_X(0, →core0)` | Placeholder — patched to jump past halt loop |
| 3 | `WFE` | `.halt:` |
| 4 | `B(-1)` | Loop back to WFE |
| 5 | `MOVZ_X(0, 0x0008, 1)` | `.core0:` — X0 = 0x80000 |
| 6 | `MOV_SP(0)` | SP = X0 |
| 7 | `BL →main` | Placeholder — patched to call main() |
| 8 | `B(-1)` | `.hang:` — infinite loop after main returns |

## UART Driver (PL011 at 0x3F201000)

The BCM2837 PL011 UART is the primary debug output channel. Registers are memory-mapped starting at `0x3F201000`.

### Hardware registers

| Constant | Address | Description |
|---|---|---|
| `UART0_DR` | `0x3F201000` | Data Register — write byte here to transmit |
| `UART0_FR` | `0x3F201018` | Flag Register — bit 5 (TXFF) set when TX FIFO is full |
| `UART0_IBRD` | `0x3F201024` | Integer Baud Rate Divisor |
| `UART0_FBRD` | `0x3F201028` | Fractional Baud Rate Divisor |
| `UART0_LCRH` | `0x3F20102C` | Line Control Register |
| `UART0_CR` | `0x3F201030` | Control Register |

### uart_init — Initialisation sequence

Configures the PL011 for **115200 baud** with an assumed 48 MHz reference clock. The baud rate divisor is `48000000 / (16 × 115200) = 26.04…`, split into integer part 1 and fractional part 40 (out of 64).

| Step | Register | Value | Meaning |
|---|---|---|---|
| 1 | `UART0_CR` | `0x00000000` | Disable UART (prevent glitches during setup) |
| 2 | `UART0_LCRH` | `0x00000000` | Clear line control / flush TX FIFO |
| 3 | `UART0_IBRD` | `0x00000001` | Integer baud divisor = 1 |
| 4 | `UART0_FBRD` | `0x00000028` | Fractional baud divisor = 40 (0x28) |
| 5 | `UART0_LCRH` | `0x00000070` | 8-bit word, FIFO enable (FEN), no parity |
| 6 | `UART0_CR` | `0x00000301` | Enable UART + TX (bit 0) + RX (bit 9) |

Each register write uses an `emitLoadAddr` pair followed by `MOVZ_W` + `STR_W`.

### uart_putc — Poll and transmit one byte

```
; x8 = UART0_FR address, w10 = poll scratch, x8/w9 = DR address/char

.poll:
    ldr  w10, [x8]          ; read Flag Register
    and  w10, w10, #0x20    ; isolate TXFF (bit 5)
    cbnz w10, .poll         ; loop while TX FIFO full

    ; x8 = UART0_DR address (reloaded), w9 = character byte
    str  w9, [x8]           ; write character
```

Registers used: `x8` (UART address), `w9` (character), `w10` (flag scratch). Each character write takes 7 instructions (2 for address load + LDR + AND + CBNZ + 2 for address load + MOVZ + STR).

`uart_print` iterates over a string literal and calls `uart_putc` for each character at compile time — no runtime loop is generated.

## Patch Types

The emitter records forward references as patches. `resolveAndSerialize` fills them in once all labels are defined.

| Type | Instruction | Formula |
|---|---|---|
| `'bl'` | `BL label` | `BL(target_idx - patch_idx)` |
| `'b'` | `B label` | `B(target_idx - patch_idx)` |
| `'cbz_x'` | `CBZ Xt, label` | `CBZ_X(p.rt, target_idx - patch_idx)` |

`target_idx` and `patch_idx` are instruction-word indices (not byte offsets). The difference is the signed word offset placed directly into the instruction's immediate field.

## Serialisation

After patch resolution, each 32-bit word in `e.buf[]` is written as four **little-endian bytes**:

```
buf.writeUInt32LE(e.buf[i], i * 4)
```

The output is a raw byte buffer with no framing. Total size = `e.buf.length × 4` bytes.

## Running the Output

```sh
# QEMU (recommended for development)
qemu-system-aarch64 -M raspi3b -kernel kernel8.img -serial stdio -display none

# Real Raspberry Pi 3
# Copy kernel8.img to a FAT32 SD card alongside bootcode.bin and start4.elf
```
