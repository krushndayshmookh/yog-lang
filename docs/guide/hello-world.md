# Hello World

The entry point for JSOS is `kernel/kernel.yog`. It is the first program compiled by `yogc` and the simplest valid Yog kernel.

## The source

```js
/**
 * kernel.yog — Yog Phase 1 Kernel
 *
 * Compile:  yogc kernel/kernel.yog kernel8.img
 * Run:      qemu-system-aarch64 -M raspi3b -kernel kernel8.img -serial stdio -display none
 */

function main(): void {
    uart_init();
    uart_print("Hello, World!\n");
}
```

That is the entire kernel. No headers. No includes. No linker script.

## Line by line

**`function main(): void`**

`main` is the entry point for ARM64 programs. The bootstrap stub emitted by `yogc` always ends with `bl main` — it is the kernel entry point by convention. The function does not need to `return`; if it does, the bootstrap falls through to an infinite `b hang` loop.

**`uart_init()`**

A compiler intrinsic. `yogc` recognises this call by name and emits an inline sequence that configures the PL011 UART at 115200 baud. No function is actually called at runtime — the UART register writes are embedded directly in the instruction stream.

See [uart_init](/reference/intrinsics#uart_init) for the full ARM64 sequence.

**`uart_print("Hello, World!\n")`**

A compiler intrinsic. The string argument must be a compile-time literal. `yogc` iterates over each character and emits a polling write loop per character. At 472 bytes total output for this kernel, the bulk of the image is these character sequences.

## What happens at boot

When QEMU loads `kernel8.img` at address `0x80000`, the CPU begins executing at that address. The first thing it hits is the bootstrap stub that `yogc` prepends to every output image:

```asm
; Read which core this is (bits [1:0] of MPIDR_EL1)
mrs  x0, mpidr_el1
and  x0, x0, #3

; Core 0 proceeds; cores 1–3 loop on WFE forever
cbz  x0, core0
halt:
  wfe
  b    halt

core0:
; Set stack pointer to 0x80000 (grows downward, below the kernel image)
  movz x0, #8, lsl #16   ; x0 = 0x80000
  mov  sp, x0

; Jump to the compiled main
  bl   main

; main returned — spin forever
hang:
  b    hang
```

**Why halt cores 1–3?** The Raspberry Pi 3 has four Cortex-A53 cores. At reset, all four start executing from address `0x80000`. JSOS Phase 1 is single-core; letting cores 1–3 execute the same kernel code would corrupt UART state and corrupt the stack. The `MPIDR_EL1` check parks them safely on `WFE`.

**Why SP = 0x80000?** The kernel image is loaded starting at `0x80000`. The stack grows downward. Setting `SP` to the load address means the stack lives below the kernel image in the first 512 KB of RAM — far from any hardware-mapped region.

## What uart_init() does

The PL011 UART on the Raspberry Pi 3 is a memory-mapped peripheral at base address `0x3F201000`. To produce output at 115200 baud:

1. **Disable UART** — write 0 to `CR` (`0x3F201030`) to stop any in-progress transfers
2. **Flush FIFOs** — write 0 to `LCRH` (`0x3F20102C`)
3. **Set baud rate** — with a 48 MHz reference clock and 115200 baud:
   - `IBRD` (`0x3F201024`) = **1** (integer divisor)
   - `FBRD` (`0x3F201028`) = **40** (fractional divisor)
4. **Configure frame** — write `0x70` to `LCRH`: 8-bit words, FIFOs enabled
5. **Enable UART** — write `0x301` to `CR`: UARTEN + TXE + RXE

After these writes, `uart_print` can feed characters to the Data Register (`DR`) once the TX FIFO is not full (TXFF bit 5 of `FR` is clear).

## Expected output

```
Hello, World!
```

Then QEMU halts waiting for input (or for `Ctrl-A X`).
