# ESP32 Target (Xtensa LX6)

The `xtensa-esp32` target compiles Yog programs to Xtensa LX6 machine code for the ESP32 microcontroller.

## Entry Point

ESP32 programs follow the **Arduino programming model**: two functions instead of one.

```ts
function setup(): void {
    // Runs once at boot — initialise hardware, configure peripherals
    uart_init();
    uart_print("Hello from Yog on ESP32!\n");
}

function loop(): void {
    // Called repeatedly forever — main application logic
    // poll sensors, update state, drive outputs, etc.
}
```

The bootstrap emits:

```
CALL0 setup       ; run setup() once
loop_top:
CALL0 loop        ; call loop() ...
J loop_top        ; ...repeat forever
```

You never need to write an explicit `while(true)` — the bootstrap handles it.

## Compile

```sh
yogc --target xtensa-esp32 examples/esp32-hello/main.yog app.bin
```

## Flash to ESP32

### Via OpenOCD (JTAG)

Load directly into IRAM (fastest for development):

```sh
openocd -f board/esp32-wrover-kit-3.3v.cfg \
  -c "program app.bin 0x40080000 verify reset exit"
```

### Via esptool.py (USB/UART)

For a proper flash image you'll need an ESP-IDF image header. Phase 1 targets direct IRAM loading; full flash support is on the roadmap.

## QEMU

ESP32 QEMU requires [Espressif's QEMU fork](https://github.com/espressif/qemu) — upstream `qemu-system-xtensa` does not implement the ESP32 peripheral model.

```sh
# Build Espressif QEMU first (see their README)
qemu-system-xtensa -M esp32 -nographic -serial stdio \
  -drive file=app.bin,if=mtd,format=raw
```

## Hardware Details

| Property | Value |
|---|---|
| CPU | Xtensa LX6, dual-core 240 MHz |
| ISA | Xtensa (24-bit variable-width instructions) |
| IRAM load address | `0x40080000` |
| UART0 base | `0x3FF40000` |
| UART0 TX FIFO | `0x3FF40000` (FIFO offset `+0x00`) |
| UART TX FIFO depth | 128 bytes |

## Boot Sequence

The ESP32 ROM bootloader:

1. Initialises CPU clocks, IRAM, DRAM.
2. Initialises UART0 at 115200 baud. ← **already done before your code runs**
3. Loads our `app.bin` into IRAM at `0x40080000`.
4. Jumps to `0x40080000` (our bootstrap stub).

Because the ROM initialises UART0, `uart_init()` is a **no-op** on ESP32. It's still safe to call for source compatibility with the ARM64 target.

## Calling Convention

The Xtensa backend uses the **CALL0 ABI** (no register windows):

- `a0` — return address (set by `CALL0`, restored by `JX a0`)
- `a1` — stack pointer
- `a2–a7` — arguments / scratch
- `a8–a15` — callee-saved (not yet managed in Phase 1)

## Intrinsics Available

| Call | Description |
|---|---|
| `uart_init()` | No-op on ESP32 (ROM already initialised UART0) |
| `uart_print("...")` | Write a string literal to UART0 FIFO |
| `Memory.read32(addr)` | Load a 32-bit MMIO register |
| `Memory.write32(addr, val)` | Store a 32-bit MMIO register |

## Alignment Notes

CALL0 targets must be **4-byte aligned**. The Xtensa backend automatically inserts `NOP` padding before each function label, so you never need to worry about this in user code.
