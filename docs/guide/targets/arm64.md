# ARM64 Target (Raspberry Pi 3 / QEMU)

The `arm64` target compiles Yog programs to AArch64 machine code for Raspberry Pi 3 and QEMU.

## Entry Point

ARM64 programs define a single `main()` function. The bootstrap sets up the stack pointer and calls it. If `main()` returns, the CPU halts.

```ts
function main(): void {
    uart_init();
    uart_print("Hello, World!\n");
}
```

## Compile

```sh
yogc examples/arm64-hello/main.yog kernel8.img
# or explicitly:
yogc --target arm64 examples/arm64-hello/main.yog kernel8.img
```

`arm64` is the default target, so `--target` is optional.

## Run in QEMU

Install QEMU:

```sh
brew install qemu           # macOS
sudo apt install qemu-system-aarch64  # Ubuntu/Debian
```

Boot:

```sh
qemu-system-aarch64 -M raspi3b -kernel kernel8.img -serial stdio -display none
```

Expected output:

```
Hello, World!
```

Press `Ctrl-A X` to quit QEMU.

## Run on Real Hardware (Raspberry Pi 3)

1. Format an SD card as FAT32.
2. Download the [Raspberry Pi firmware](https://github.com/raspberrypi/firmware/tree/master/boot): `bootcode.bin`, `start.elf`, `fixup.dat`.
3. Copy those files plus your `kernel8.img` to the SD card root.
4. Create `config.txt` with:

   ```ini
   enable_uart=1
   arm_64bit=1
   ```

5. Insert the SD card, connect a USB-serial adapter to GPIO pins 14/15, and power on.
6. Open a terminal at 115200 baud to see output.

## Hardware Details

| Property | Value |
|---|---|
| CPU | ARM Cortex-A53 (AArch64) |
| Load address | `0x80000` |
| UART | PL011 at `0x3F201000` |
| Baud rate | 115200 (48 MHz ref clock) |

## Boot Sequence

The VideoCore GPU reads `kernel8.img` from the SD card and loads it at `0x80000`. Execution starts at the very first instruction (the bootstrap stub). The stub:

1. Reads `MPIDR_EL1` to get the core ID.
2. Parks cores 1–3 in a `WFE` loop.
3. Sets `SP = 0x80000` (stack grows down from the load address).
4. Calls `main()`.
5. Hangs if `main()` returns.

## Intrinsics Available

| Call | Description |
|---|---|
| `uart_init()` | Initialise PL011 UART at 115200 baud |
| `uart_print("...")` | Write a string literal to UART |
| `Memory.read32(addr)` | Load a 32-bit MMIO register |
| `Memory.write32(addr, val)` | Store a 32-bit MMIO register |
