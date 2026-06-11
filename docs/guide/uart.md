# UART Driver

UART (Universal Asynchronous Receiver/Transmitter) is the primary output channel for Yog programs running on bare-metal hardware. Before there is a display, a file system, or a network stack, UART is how you know your code is running.

In Yog programs, UART is exposed through two compiler intrinsics:

```ts
uart_init();               // initialise the hardware (no-op on some platforms)
uart_print("Hello!\n");    // write a string literal to the serial port
```

Both are handled entirely at compile time — the compiler inlines the necessary machine code directly at the call site. There is no runtime library involved.

---

## Why UART?

UART has several properties that make it ideal as the first I/O primitive:

- **No initialisation complexity** — on RPi3, just write six registers. On ESP32, the ROM bootloader has already done it.
- **No buffering required** — for short strings, writing to the FIFO and polling a ready bit is sufficient.
- **Works immediately at EL1** — no MMU, no interrupts, no DMA.
- **Universally supported** — every development board has a UART, and QEMU exposes it as `-serial stdio`.

In later phases, `write(fd=1, ...)` syscalls will replace direct UART access for user programs. The UART driver itself will move into a kernel driver with interrupt-driven buffering.

---

## ARM64 / Raspberry Pi 3 — PL011 UART

The BCM2837 SoC on the Raspberry Pi 3 contains an ARM PL011 UART peripheral (UART0). This is a full-featured UART with a 16-entry TX FIFO and precise baud rate divisors.

### Register Map

| Register | Address | Description |
|----------|---------|-------------|
| DR | `0x3F201000` | Data Register — write a byte here to transmit |
| FR | `0x3F201018` | Flag Register — bit 5 (`TXFF`) = TX FIFO full |
| IBRD | `0x3F201024` | Integer Baud Rate Divisor |
| FBRD | `0x3F201028` | Fractional Baud Rate Divisor |
| LCRH | `0x3F20102C` | Line Control Register |
| CR | `0x3F201030` | Control Register |

Base address: `0x3F201000` (BCM2837 peripheral bus, mapped to ARM physical address space).

### Baud Rate Calculation

The PL011 baud rate divisor is split into integer and fractional parts. With a 48 MHz UART reference clock and a target of 115200 baud:

```
Divisor = 48_000_000 / (16 × 115_200) = 26.0417...
IBRD = 26        (integer part)
FBRD = 0.0417 × 64 ≈ 3
```

Wait — the actual values used by the ARM64 backend are `IBRD = 1`, `FBRD = 40`. This matches a **3 MHz** reference clock (`3_000_000 / (16 × 115_200) ≈ 1.627`; fractional `0.627 × 64 ≈ 40`). QEMU's raspi3b model accepts these values.

### Initialisation Sequence (`uart_init`)

The initialisation sequence disables the UART, clears the FIFOs, programs the baud rate, enables 8-bit frames with FIFO enabled, then re-enables the UART:

```asm
; 1. Disable UART (CR = 0)
movz x8, #CR_lo16
movk x8, #CR_hi16, lsl #16   ; x8 = 0x3F201030
str  wzr, [x8]                ; CR = 0

; 2. Flush FIFOs (LCRH = 0)
movz x8, #LCRH_lo16
movk x8, #LCRH_hi16, lsl #16
str  wzr, [x8]                ; LCRH = 0

; 3. Set integer baud rate divisor
movz x8, #IBRD_addr...
movz w9, #1
str  w9, [x8]                 ; IBRD = 1

; 4. Set fractional baud rate divisor
movz x8, #FBRD_addr...
movz w9, #40
str  w9, [x8]                 ; FBRD = 40

; 5. 8-bit, enable FIFO (LCRH = 0x70)
movz x8, #LCRH_addr...
movz w9, #0x70
str  w9, [x8]                 ; LCRH: WLEN=8, FEN=1

; 6. Enable TX + RX + UART (CR = 0x301)
movz x8, #CR_addr...
movz w9, #0x301               ; TXE | RXE | UARTEN
str  w9, [x8]                 ; CR = 0x301
```

`LCRH = 0x70` sets: `WLEN[6:5] = 11` (8-bit), `FEN[4] = 1` (FIFO enabled).  
`CR = 0x301` sets: `UARTEN[0] = 1`, `TXE[8] = 1`, `RXE[9] = 1`.

### Transmitting a Character (`uart_putc`)

Before writing a character to the Data Register, the driver polls the TX FIFO Full bit (bit 5 of FR). If the FIFO is full, it spins until space is available:

```asm
.txwait:
  movz x8, #FR_lo16
  movk x8, #FR_hi16, lsl #16
  ldr  w10, [x8]              ; read Flag Register
  and  w10, w10, #0x20        ; isolate TXFF (bit 5)
  cbnz w10, .txwait           ; loop while FIFO full

  movz x8, #DR_lo16           ; load DR address
  movk x8, #DR_hi16, lsl #16
  movz w9, #<charCode>        ; character to send
  str  w9, [x8]               ; write to Data Register
```

Each character in a string literal generates this ~8-instruction sequence. For a 14-character "Hello, World!\n", the compiler emits approximately 112 instructions inline.

### Source Reference

`yogc/src/backends/arm64.js`:
- `emitUartInit(e)` — the six-register init sequence
- `emitUartPutc(e, charCode)` — single-character transmit with TXFF polling
- `emitUartPrint(e, str)` — iterates `emitUartPutc` for each character

---

## ESP32 — Xtensa LX6 UART0

The ESP32 has a dedicated UART0 peripheral with a 128-byte hardware TX FIFO.

### Register Map

| Register | Address | Description |
|----------|---------|-------------|
| FIFO | `0x3FF40000` | Write a byte here to transmit |
| STATUS | `0x3FF4001C` | Bits [22:16] = `TXFIFO_CNT` (0..127 bytes used) |

Base address: `0x3FF40000`.

### `uart_init` — No-Op

The ROM bootloader initialises UART0 at 115200 baud before jumping to user code. There is nothing left to configure. The `uart_init` intrinsic is accepted by the compiler for source-level compatibility with the ARM64 target but emits zero instructions:

```js
// xtensa.js
function emitUartInit(/* e */) {
  // intentionally empty — ROM bootloader has already configured UART0
}
```

This means you can write portable Yog programs that call `uart_init()` and they will work correctly on both RPi3 (where init is required) and ESP32 (where it is a no-op).

### Transmitting a Character (`uart_putc`)

The TX FIFO is 128 bytes deep. For short strings (all typical Phase 1 programs), the FIFO will never fill, so no polling is needed. Each character is written directly:

```asm
; a2 = UART0_FIFO address (0x3FF40000), a3 = character value
l32r  a2, &ESP32_UART0_FIFO   ; load address from literal pool
movi  a3, <charCode>           ; character (12-bit immediate)
s32i  a3, a2, 0                ; store byte to FIFO
```

`L32R` is a 3-instruction (3-byte) PC-relative load from the literal pool appended at the end of the binary. The pool address is fixed at compile time.

### Why No Polling?

The 128-byte FIFO is large enough to hold any reasonable startup message without overflowing between characters, given that the CPU runs at 240 MHz and the UART transmits at 115200 baud (~11.5 KB/s). At 240 MHz, even without polling, at least ~20,000 CPU cycles elapse between FIFO writes, giving the hardware plenty of time to drain.

A future phase will add STATUS-based polling for robustness when printing long output.

### Source Reference

`yogc/src/backends/xtensa.js`:
- `emitUartInit()` — empty function
- `emitUartPutc(e, charCode)` — L32R + MOVI + S32I sequence
- `emitUartPrint(e, str)` — iterates `emitUartPutc`

---

## x86\_64 — Linux Syscall (stdout)

On the x86\_64 Linux target, there is no UART hardware. Instead, `uart_print` maps to the `write(2)` system call on stdout (fd 1), and `uart_init` is a no-op.

This mapping makes it possible to develop and test Yog programs on a Linux host before flashing to bare-metal hardware — the same source file runs on both.

### `uart_init` — No-Op

stdout is already open when the process starts. Nothing to initialise:

```js
// x86_64.js
'uart_init': (_e) => { /* intentionally empty */ },
```

### `uart_print` — `write(1, buf, len)` Syscall

The string literal is placed in a **string pool** appended after the compiled code. At link time (inside `resolveAndSerialize`), the pool entry's address is resolved into a RIP-relative `LEA` displacement.

Emitted instruction sequence (24 bytes):

```asm
; rsi = address of string literal (RIP-relative LEA)
lea   rsi, [rip + <strOffset>]   ; 7 bytes: 48 8D 35 [disp32]

; rdx = byte count (compile-time strlen)
mov   edx, <len>                  ; 5 bytes: BA [imm32]

; rdi = fd = 1 (stdout)
mov   edi, 1                      ; 5 bytes: BF 01 00 00 00

; rax = SYS_write = 1
mov   eax, 1                      ; 5 bytes: B8 01 00 00 00

syscall                           ; 2 bytes: 0F 05
```

The string data lives after the compiled code in the ELF file and is mapped into the same read-execute PT\_LOAD segment. No separate data segment is needed.

### Syscall Convention (System V AMD64)

| Register | Role | Value for `uart_print` |
|----------|------|----------------------|
| RAX | syscall number | 1 (`SYS_write`) |
| RDI | arg 1: fd | 1 (stdout) |
| RSI | arg 2: buf pointer | RIP-relative address of string literal |
| RDX | arg 3: byte count | `Buffer.byteLength(str, 'utf8')` |

### Source Reference

`yogc/src/backends/x86_64.js`:
- `'uart_init'` intrinsic — empty handler
- `'uart_print'` intrinsic — `emitLEA_RSI_rip` + `emitMOV_EDX_imm32` + `emitMOV_EDI_imm32` + `emitMOV_EAX_imm32` + `emitSYSCALL`
- `X86_64Emitter.addString(str)` — string pool management

---

## Platform Comparison

| Feature | ARM64 (RPi3) | ESP32 (Xtensa) | x86\_64 (Linux) |
|---------|-------------|----------------|-----------------|
| UART base | `0x3F201000` | `0x3FF40000` | N/A (syscall) |
| `uart_init` | Programs 6 registers | No-op | No-op |
| TX mechanism | Poll FR bit 5 (TXFF) before each byte | Direct FIFO write (no poll) | `write(1, ...)` syscall |
| TX FIFO depth | 16 bytes | 128 bytes | OS-managed |
| Baud rate | 115200 (IBRD=1, FBRD=40) | 115200 (ROM-configured) | N/A |
| Characters per `uart_putc` | ~8 instructions | 3 instructions | 24 bytes (total for string) |

---

## Using UART in Yog

A minimal Yog program that prints to the serial console:

```ts
function main(): void {
  uart_init();
  uart_print("Hello, World!\n");
}
```

For ESP32 (using `setup`/`loop` pattern):

```ts
function setup(): void {
  uart_init();
  uart_print("Booted!\n");
}

function loop(): void {
  uart_print("tick\n");
}
```

The compiler selects the correct implementation automatically based on the `--target` flag passed to `yogc`.

### QEMU

To observe UART output in QEMU:

```sh
# ARM64
qemu-system-aarch64 -M raspi3b -kernel kernel8.img -serial stdio -display none

# x86_64 (run natively on Linux)
chmod +x app.elf && ./app.elf

# x86_64 (user-mode QEMU on macOS/ARM)
qemu-x86_64 app.elf
```

---

## Current Limitations

- **String literals only.** `uart_print` accepts only compile-time constant string literals. The compiler resolves the string at code-generation time and inlines the character codes (ARM64/ESP32) or registers a string pool entry (x86\_64). You cannot pass a variable:

  ```ts
  // OK
  uart_print("Hello!\n");

  // NOT supported in Phase 1 — will throw a compile-time error
  let msg = "Hello!\n";
  uart_print(msg);
  ```

- **No receive support.** `uart_read` / `uart_getc` are not yet implemented. Phase 3 will add UART RX for the interactive shell.

- **No interrupt-driven buffering.** All TX operations are synchronous (polling on ARM64, direct-write on ESP32). Interrupt-driven TX with a ring buffer is planned for Phase 2 as part of the full UART kernel driver.
