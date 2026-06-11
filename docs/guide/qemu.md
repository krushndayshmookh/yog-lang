# Running in QEMU

QEMU emulates the Raspberry Pi 3B (`raspi3b` machine), which is the closest available QEMU model to the real AArch64 RPi3 hardware. The PL011 UART, interrupt controller, and memory map are all emulated, making it possible to develop and test JSOS without physical hardware.

## Install QEMU

**macOS (Homebrew):**

```sh
brew install qemu
```

**Debian / Ubuntu:**

```sh
sudo apt install qemu-system-aarch64
```

**Verify:**

```sh
qemu-system-aarch64 --version
```

You need `qemu-system-aarch64`. The generic `qemu` package on some distributions only includes x86 targets.

## The QEMU command

```sh
qemu-system-aarch64 -M raspi3b -kernel kernel8.img -serial stdio -display none
```

| Flag | Meaning |
|---|---|
| `-M raspi3b` | Emulate a Raspberry Pi 3B (AArch64, 4× Cortex-A53, 1 GB RAM, PL011 UART) |
| `-kernel kernel8.img` | Load the binary at physical address `0x80000` — the AArch64 `kernel8.img` convention |
| `-serial stdio` | Wire UART0 (PL011) to the terminal's stdin/stdout |
| `-display none` | Disable the graphical window — this kernel has no video output |

## Quit QEMU

Press **`Ctrl-A`** then **`X`** to exit. (`Ctrl-C` sends SIGINT to the guest, which the kernel does not handle in Phase 1 — it does nothing.)

## Why raspi3b?

The `raspi3b` machine model is the only QEMU target that accurately emulates:

- **AArch64 (64-bit ARM)** — matching the Cortex-A53 used in the real RPi3
- **PL011 UART at `0x3F201000`** — same base address as physical hardware
- **Memory layout starting at `0x00000000`** — peripheral bus mapped at `0x3F000000`
- **Multi-core boot behaviour** — all four cores start at `0x80000`, matching real hardware

The `virt` machine is more generic and better supported for VMs, but its peripheral addresses differ. Using `raspi3b` means code developed and tested in QEMU boots unchanged on a real Raspberry Pi 3.

## Convenience script

The repo includes `run.sh` which compiles and boots in one command:

```sh
./run.sh
```

To compile without launching QEMU:

```sh
./run.sh --build-only
```

## Troubleshooting

**No output / QEMU exits immediately:**
Check that `kernel8.img` was produced by `yogc` and is non-empty. An empty or corrupt image will cause QEMU to reset immediately.

**`qemu-system-aarch64: -M raspi3b: unsupported machine type`:**
Your QEMU version is too old. The `raspi3b` machine was added in QEMU 6.0. Run `qemu-system-aarch64 --version` and upgrade if needed.

**Characters garbled / wrong baud rate:**
QEMU's `raspi3b` serial emulation ignores the baud-rate divisor registers and passes bytes through at terminal speed. Garbled output is usually a sign that `uart_init()` wrote incorrect values to `LCRH` (frame format), not baud rate. Confirm `LCRH = 0x70` (8 data bits, FIFO enabled).
