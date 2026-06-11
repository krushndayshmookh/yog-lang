# ESP32 (Xtensa LX6) Backend Reference

The ESP32 backend targets the **Espressif ESP32** (dual-core Xtensa LX6, 240 MHz). It produces a **flat binary** (`app.bin`) suitable for loading directly into IRAM at address `0x40080000`.

Source: `yogc/src/backends/xtensa.js`

## Output Format

| Property | Value |
|---|---|
| File name | `app.bin` |
| Format | Flat binary (no ELF/ESP-IDF framing) |
| Load address | `0x40080000` (ESP32 IRAM start) |
| Instruction width | 24-bit variable (3 bytes each) |
| Byte order | Little-endian (3-byte LE per instruction) |

Xtensa LX6 uses a **24-bit instruction word** for all standard instructions. Each instruction occupies exactly 3 bytes in the binary. The literal pool that follows the code section uses 4-byte aligned 32-bit entries.

## Architecture Overview

- **Registers:** `a0`–`a15` (address registers). `a0` holds the return address under the CALL0 ABI; `a1` is the stack pointer.
- **Calling convention:** CALL0 (no register windows). Return address is in `a0`; callee saves `a0` if it calls further functions.
- **ROM bootloader:** starts PRO CPU (core 0), initialises UART0 at 115200 baud, loads code to IRAM at `0x40080000`, then jumps to the entry point. APP CPU (core 1) is held in reset.

## Instruction Encoders

All encoders return 24-bit values stored in JavaScript numbers. The emitter serialises each as 3 little-endian bytes.

Format names follow the Xtensa ISA Reference Manual.

### L32R — Load 32-bit from Literal Pool (PC-relative)

```
L32R at, <literal>
```

Loads a 32-bit word from a literal pool entry into register `at`. The effective address is computed as:

```
EA = ((instrAddr + 3) & ~3) + SignExtend(imm16, 16) * 4
```

The `imm16` field is a signed 16-bit word offset from the next 4-byte-aligned address after the instruction. This gives a reach of ±128 KB (±32 767 32-bit words).

Format: RI16 — `[23:8]=imm16, [7:4]=t, [3:0]=op0=1`

Encoding: `((imm16 & 0xFFFF) << 8) | ((at & 0xF) << 4) | 0x1`

### S32I — Store 32-bit Word

```
S32I at, as, imm8
```

Stores the 32-bit register `at` to memory at `EA = as + imm8 * 4`.

Format: RRI8 — `[23:16]=imm8, [15:12]=s, [11:8]=t, [7:4]=op1=6, [3:0]=op0=2`

Encoding: `((imm8 & 0xFF) << 16) | ((as & 0xF) << 12) | ((at & 0xF) << 8) | 0x62`

### L32I — Load 32-bit Word

```
L32I at, as, imm8
```

Loads a 32-bit word from `EA = as + imm8 * 4` into `at`.

Format: RRI8 — `[23:16]=imm8, [15:12]=s, [11:8]=t, [7:4]=op1=2, [3:0]=op0=2`

Encoding: `((imm8 & 0xFF) << 16) | ((as & 0xF) << 12) | ((at & 0xF) << 8) | 0x22`

### MOVI — Move 12-bit Immediate

```
MOVI at, imm12
```

Loads a sign-extended 12-bit immediate into `at`. Valid range: −2048 to +2047. Used for small character codes and short constants.

Format: RRI8 (op1=0xA) — lower 8 bits of immediate in `[23:16]`, upper 4 bits in `[15:12]`

Encoding: `((lo8 << 16) | (hi4 << 12) | ((at & 0xF) << 8) | 0xA2)`

### CALL0 — Call Subroutine (CALL0 ABI)

```
CALL0 <target>
```

Calls a subroutine without register windows. Sets `a0 = return address` and jumps to:

```
EA = ((PC + 4) & ~3) + SignExtend(offset18, 18) * 4
```

The `offset18` is a signed 18-bit word offset. **Targets must be 4-byte aligned**; `emitFunction` enforces this with NOP padding.

Format: CALL — `[23:6]=offset18, [5:4]=n=0, [3:0]=op0=5`

Encoding: `((offset18 & 0x3FFFF) << 6) | 0x05`

### J — Unconditional Jump

```
J <target>
```

Jumps to `EA = PC + 4 + SignExtend(offset18, 18)`. Unlike CALL0, `J`'s offset is in **bytes** (not words). A self-loop at byte address B encodes `offset18 = -4`.

Format: CALL — `[23:6]=offset18, [5:4]=n=0, [3:0]=op0=6`

Encoding: `((offset18 & 0x3FFFF) << 6) | 0x06`

### JX_A0 — Return (CALL0 ABI)

Constant encoding `0x0000A0`. Performs `JX a0` — jumps to the address in `a0`, which holds the return address set by `CALL0`. This is the standard return instruction in the CALL0 ABI.

RRR format: `op2=0, op1=0, r=0xA (JX), s=0 (a0)`

### NOP_XTENSA — No Operation

Constant encoding `0x810100`. Encoded as `OR a1, a1, a1` — a harmless self-OR that has no observable effect. Used for 4-byte alignment padding before function entry points.

## Literal Pool Strategy (XtensaEmitter)

L32R is the only way to load arbitrary 32-bit constants on Xtensa. It requires a literal pool — a region of 4-byte aligned 32-bit values that L32R addresses PC-relatively.

This backend uses a **global literal pool** appended at the end of the binary after all instructions. This avoids per-function pool management at the cost of requiring the entire binary to stay within 128 KB (the L32R reach limit). Phase 1 programs are far smaller than this limit.

### XtensaEmitter class

`XtensaEmitter` extends the base `Emitter` with three additions:

| Field | Type | Purpose |
|---|---|---|
| `byteLen` | number | Running byte count of emitted code (for alignment tracking) |
| `litPool` | number[] | Array of 32-bit literal values |
| `l32rPatches` | object[] | Pending `{ instrIdx, reg, litIdx }` fixups |

### addLiteral(value)

Registers a 32-bit value in the literal pool and returns its pool index. If the value was already registered, the existing index is reused (deduplication). This means the same UART address used by multiple `uart_putc` calls costs only one pool entry.

### emitL32R(reg, litIdx)

Records an L32R patch and emits a placeholder instruction with `offset=0`. The actual PC-relative offset is computed in `resolveAndSerialize` once the pool's byte position is known.

```
instrIdx = e.buf.length            // instruction index before emit
e.l32rPatches.push({ instrIdx, reg, litIdx })
emit L32R(reg, 0)                  // placeholder
```

## Bootstrap

The ESP32 follows the **Arduino / ESP-IDF** programming model: a `setup()` function runs once at boot, then `loop()` is called repeatedly in an infinite loop.

### Entry contract

The user must define:
```js
function setup(): void  // runs once
function loop():  void  // runs forever
```

### Bootstrap layout (4 instructions = 12 bytes)

| idx | Byte | Instruction | Label | Description |
|---|---|---|---|---|
| 0 | 0 | `CALL0 setup` | — | Run `setup()` once at boot |
| 1 | 3 | `CALL0 loop` | `loop_top:` | Call `loop()` |
| 2 | 6 | `J loop_top` | — | Jump back to byte 3 (offset = −7) |
| 3 | 9 | `J -4` | `hang:` | Unreachable safety-net self-loop |

`J loop_top` at byte 6: `EA = 6 + 4 + (−7) = 3` ✓

After 12 bytes of bootstrap, compiled functions begin at byte 12, which is 4-byte aligned. All subsequent functions are padded to 4-byte alignment by `emitFunction`.

## UART Driver (UART0 at 0x3FF40000)

### Hardware registers

| Constant | Address | Description |
|---|---|---|
| `ESP32_UART0_FIFO` | `0x3FF40000` | Write a byte here to transmit |
| `ESP32_UART0_STATUS` | `0x3FF4001C` | Bits [22:16] = TXFIFO_CNT (0–127) |

### uart_init — No-op

`uart_init` is intentionally empty on ESP32. The ROM bootloader initialises UART0 at 115200 baud before jumping to application code. Calling `uart_init()` in Yog source is accepted for cross-target source compatibility but emits no instructions.

### uart_putc — Write one character

Phase 1 uses a **no-poll** strategy: write directly to the FIFO without checking `TXFIFO_CNT`. The FIFO is 128 bytes deep; a typical `uart_print("Hello World\r\n")` (13 bytes) fits comfortably without overflow.

```asm
L32R  a2, &ESP32_UART0_FIFO   ; load FIFO address from literal pool
MOVI  a3, charCode             ; 12-bit immediate character
S32I  a3, a2, 0                ; write char to FIFO (EA = a2 + 0)
```

Registers used: `a2` (FIFO address), `a3` (character value). Three instructions per character.

## 4-byte Alignment in emitFunction

Xtensa CALL0 requires 4-byte aligned targets. Because instructions are 3 bytes each, the byte position after a sequence of instructions is not always a multiple of 4.

`emitFunction` inserts `NOP_XTENSA` instructions before each function label until `e.byteLen % 4 === 0`:

```js
while (e.byteLen % 4 !== 0) {
  e.emit(NOP_XTENSA);  // 3 bytes, advances byteLen
}
e.label(name);
```

At most 3 NOP instructions (9 bytes) are needed, since `gcd(3, 4) = 1` and the cycle repeats every 12 bytes.

## Patch Types

### Label-targeted patches (e.patches)

| Type | Instruction | Formula |
|---|---|---|
| `'call0'` | `CALL0 label` | `offset18 = (targetByteAddr - ((instrByteAddr + 4) & ~3)) / 4` |
| `'j'` | `J label` | `offset18 = targetByteAddr - (instrByteAddr + 4)` (bytes) |

The `'call0'` case validates that the byte offset is divisible by 4; an error is thrown if the target is not 4-byte aligned.

### Literal pool patches (e.l32rPatches)

| Field | Meaning |
|---|---|
| `instrIdx` | Instruction slot index in `e.buf` |
| `reg` | Destination register for L32R |
| `litIdx` | Index into `e.litPool` |

Resolution:
```
l32rBase    = (instrByteAddr + 3) & ~3    // next 4-byte boundary after instruction
litByteAddr = poolStart + litIdx * 4
wordOffset  = (litByteAddr - l32rBase) / 4
```

An error is raised if `wordOffset` falls outside `[−32768, 32767]`.

## resolveAndSerialize — Binary Layout

```
[ 0 .. codeBytes-1    ]  instructions (3 bytes each, LE)
[ codeBytes ..        ]  0–3 zero padding bytes (4-byte alignment)
[ poolStart ..        ]  literal pool (4 bytes per entry, LE uint32)
```

`padBytes = (4 - (codeBytes % 4)) % 4`

`poolStart = codeBytes + padBytes`

The function:
1. Resolves all CALL0/J patches using label byte addresses
2. Resolves all L32R patches using pool byte addresses
3. Allocates a `Buffer` of `poolStart + litPool.length * 4` bytes
4. Writes each 24-bit instruction as 3 LE bytes
5. Writes each 32-bit literal as 4 LE bytes

## Running the Output

```sh
# Flash to a real ESP32 via OpenOCD (bare IRAM load)
openocd -f board/esp32-wrover-kit-3.3v.cfg \
  -c "program app.bin 0x40080000 verify reset exit"

# Espressif QEMU fork (requires separate build)
# https://github.com/espressif/qemu
qemu-system-xtensa -M esp32 -nographic -serial stdio \
  -drive file=app.bin,if=mtd,format=raw
```

Note: Upstream `qemu-system-xtensa` does not model the ESP32 peripheral set. Espressif's fork is required for full simulation. For hardware bring-up, OpenOCD with direct IRAM loading is simpler.
