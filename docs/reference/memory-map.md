# Memory Map

Physical memory layout for JSOS on Raspberry Pi 3 / QEMU `raspi3b`.

## Physical address space

| Region | Base Address | Notes |
|---|---|---|
| Boot ROM | `0x00000000` | Read-only; contains GPU firmware boot code |
| Kernel image | `0x00080000` | `kernel8.img` loaded here by firmware/QEMU |
| Kernel stack | `0x00080000` ↓ | Grows downward from the kernel entry point |
| Kernel heap | `0x00400000` | Phase 5+; managed via `mmap` syscall |
| User space | `0x00800000`+ | Phase 4+; per-process address spaces |
| Peripherals | `0x3F000000` | BCM2837 peripheral bus base |
| ARM local | `0x40000000` | Core-local timers and mailboxes |

The first 512 KB (`0x00000000`–`0x0007FFFF`) is available to the kernel. The stack starts at `0x80000` and grows downward; the kernel image grows upward from the same address. For Phase 1 the image is under 1 KB, so there is no collision.

## Peripheral registers

All peripherals are memory-mapped in the `0x3F000000` bus region.

| Peripheral | Base Address |
|---|---|
| System Timer | `0x3F003000` |
| Interrupt Controller | `0x3F00B000` |
| GPIO | `0x3F200000` |
| UART0 (PL011) | `0x3F201000` |

## UART0 (PL011) register map

Base: `0x3F201000`

| Register | Offset | Address | Description |
|---|---|---|---|
| `DR` | `0x00` | `0x3F201000` | Data Register — read/write characters |
| `FR` | `0x18` | `0x3F201018` | Flag Register |
| `IBRD` | `0x24` | `0x3F201024` | Integer Baud Rate Divisor |
| `FBRD` | `0x28` | `0x3F201028` | Fractional Baud Rate Divisor |
| `LCRH` | `0x2C` | `0x3F20102C` | Line Control Register |
| `CR` | `0x30` | `0x3F201030` | Control Register |

### FR (Flag Register) bits

| Bit | Name | Meaning |
|---|---|---|
| 5 | `TXFF` | TX FIFO Full — do not write `DR` while set |
| 4 | `RXFE` | RX FIFO Empty — no data available to read |
| 3 | `BUSY` | UART transmitting |

`uart_print` polls `TXFF` before writing each character to `DR`.

### CR (Control Register) bits

| Value | Effect |
|---|---|
| `0x000` | Disable UART (written first during `uart_init`) |
| `0x301` | `UARTEN` (bit 0) + `TXE` (bit 8) + `RXE` (bit 9) — enable UART with TX and RX |

### LCRH (Line Control Register) bits

| Value | Effect |
|---|---|
| `0x000` | Reset / flush FIFOs |
| `0x070` | `WLEN=11` (8-bit) + `FEN` (FIFO enable) |
