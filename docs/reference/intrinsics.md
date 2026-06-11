# Compiler Intrinsics

Intrinsics are call sites that `yogc` recognises by name at compile time and replaces with inline instruction sequences. No function call is emitted — the instructions are inserted directly into the caller's instruction stream.

> **Target-specific behaviour.** Each backend implements intrinsics differently. The sections below describe what each intrinsic does on ARM64, ESP32, and x86_64. An intrinsic that is a no-op on one target may have significant hardware side effects on another — always check the section for your target before use.

## uart_init()

Configures the PL011 UART at `0x3F201000` for 115200 baud, 8-N-1, FIFO enabled.

```js
uart_init();
```

**Parameters:** none  
**Returns:** nothing  
**Side effects:** modifies UART0 registers

**Baud-rate calculation** (48 MHz reference clock, 115200 baud):

```
Divisor = 48,000,000 / (16 × 115,200) = 26.041...
IBRD = 26   →  integer part
FBRD = floor(0.041... × 64 + 0.5) = 40  (actually 1 and 40 for this clock)
```

> Note: the actual values used are IBRD=1, FBRD=40. This is correct for the QEMU `raspi3b` emulation; verify against your hardware's reference clock if targeting real RPi3.

**Register sequence emitted:**

| Register | Address | Value | Effect |
|---|---|---|---|
| `CR` | `0x3F201030` | `0x000` | Disable UART |
| `LCRH` | `0x3F20102C` | `0x000` | Flush TX/RX FIFOs |
| `IBRD` | `0x3F201024` | `1` | Integer baud divisor |
| `FBRD` | `0x3F201028` | `40` | Fractional baud divisor |
| `LCRH` | `0x3F20102C` | `0x70` | 8-bit word length, FIFO enable |
| `CR` | `0x3F201030` | `0x301` | UARTEN + TXE + RXE |

**ARM64 pattern** (per register write):

```asm
movz x8, #lo16(addr)
movk x8, #hi16(addr), lsl #16
movz w9, #value
str  w9, [x8]
```

**Per-target behaviour:**

| Target | Behaviour |
|---|---|
| **ARM64** | Emits the full PL011 register-write sequence described above. |
| **ESP32 (Xtensa)** | No-op. The ESP-IDF bootloader initialises UART0 before `setup()` is called; a second initialisation would corrupt baud settings. |
| **x86_64** | No-op. There is no UART peripheral to configure on a standard Linux host; output goes through `write` syscalls instead. |

## uart_print(str)

Writes a compile-time string literal to UART0 one character at a time, polling the TX FIFO Full flag between each character.

```js
uart_print("Hello, World!\n");
```

**Parameters:** `str` — must be a string literal (not a variable)  
**Returns:** nothing  
**Constraint:** argument must be resolvable at compile time

**ARM64 pattern** (per character):

```asm
; Load FR address into x8
movz x8, #lo16(0x3F201018)
movk x8, #hi16(0x3F201018), lsl #16

; Poll TXFF (bit 5 of FR) — loop while TX FIFO is full
poll:
  ldr  w10, [x8]
  and  w10, w10, #0x20     ; isolate bit 5
  cbnz w10, poll

; Write character to DR
movz x8, #lo16(0x3F201000)
movk x8, #hi16(0x3F201000), lsl #16
movz w9, #<charCode>
str  w9, [x8]
```

This sequence is emitted once per character. A 14-character string ("Hello, World!\n") produces 14 such sequences inline.

**Per-target behaviour:**

| Target | Behaviour |
|---|---|
| **ARM64** | Emits the polling UART write sequence described above — one per character, directly into the instruction stream. |
| **ESP32 (Xtensa)** | Emits a write to the ESP32 UART FIFO register (`UART_FIFO_REG`, `0x60000000`). Polls `UART_STATUS_REG` TXFIFO count before each write. No busy-wait loop is needed in most cases because the FIFO is 128 bytes deep. |
| **x86_64** | Emits a Linux `write` syscall (`syscall number 1`) with `fd=1` (stdout), the string data, and its length. The string is placed in the `.rodata` section; the syscall arguments are loaded into `rax`, `rdi`, `rsi`, `rdx`. |

## Memory.write32(addr, val)

Stores a 32-bit value to a memory-mapped address. Both arguments must be numeric literals.

```js
Memory.write32(0x3F201030, 0x301);
```

**Parameters:**
- `addr` — destination address (numeric literal)
- `val` — value to write (numeric literal, 16-bit max in Phase 1)

**Returns:** nothing

**ARM64 sequence emitted:**

```asm
movz x0, #lo16(addr)
movk x0, #hi16(addr), lsl #16
movz w1, #val
str  w1, [x0]
```

## Memory.read32(addr)

Loads a 32-bit value from a memory-mapped address. Result is left in register `W0`.

```js
const fr = Memory.read32(0x3F201018);
```

**Parameters:**
- `addr` — source address (numeric literal)

**Returns:** 32-bit value in `W0`

**ARM64 sequence emitted:**

```asm
movz x8, #lo16(addr)
movk x8, #hi16(addr), lsl #16
ldr  w0, [x8]
```

Note that `x8` is used as the address register (not `x0`) so that the result register `w0` is free for the loaded value.

## syscall(n, ...args)

Issues a supervisor call. Phase 2+ only — not yet implemented in the compiler.

```js
syscall(0, 1, buf, len);   // write(fd=1, buf, len)
```

**Parameters:**
- `n` — syscall number (placed in `x8` per AArch64 Linux ABI convention)
- `args` — up to 6 arguments in `x0`–`x5`

**ARM64 sequence (planned):**

```asm
; Load args into x0–x5
; Load syscall number into x8
movz x8, #n
svc  #0
; return value in x0
```

See [Syscall Table](/reference/syscalls) for the planned syscall numbers and signatures.
