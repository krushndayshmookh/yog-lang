# JSOS — JavaScript Operating System
## Project Vision & Roadmap

---

## What Is JSOS?

JSOS is a bare-metal operating system where JavaScript is the primary systems language.
JS source files are compiled directly to ARM64 machine code by an in-tree compiler and
executed natively — no VM, no interpreter, no C runtime. The kernel, shell, compiler,
and all userland programs are written in a typed JS dialect that compiles to flat binaries.

Target hardware: Raspberry Pi 3 (AArch64 / ARMv8-A). Development and testing via QEMU.

---

## Architecture Overview

```
┌───────────────────────────────────────────────────────────────┐
│  USER SPACE (EL0)                                             │
│  [ Shell ]  [ JS Compiler ]  [ User Programs ]  [ Daemons ]  │
└──────────────────────────┬────────────────────────────────────┘
                  SVC gate │  (EL0 → EL1 via SVC instruction)
┌──────────────────────────▼────────────────────────────────────┐
│  KERNEL SPACE (EL1)                                           │
│  [ Scheduler ]  [ MMU ]  [ VFS ]  [ Drivers ]  [ Net Stack ] │
└──────────────────────────┬────────────────────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────────────┐
│  HARDWARE                                                     │
│  [ ARM Cortex-A53 ]  [ 1GB RAM ]  [ UART ]  [ Timer ]  [SD] │
└───────────────────────────────────────────────────────────────┘
```

---

## Milestones

### Phase 1 — Proof of Concept (current)
**Goal:** Boot QEMU, print "Hello, World!" to serial console.

- [x] Bootstrap binary encoder (`js2bin.js`) — JS dialect → ARM64 flat binary
- [x] Bootstrap stub — halt cores 1–3, set stack pointer, call `kernel_main`
- [x] UART driver intrinsic — `uart_print("string")` expands to PL011 writes
- [ ] QEMU boot verification

Deliverable: `kernel8.img` that prints "Hello, World!\n" and halts.

---

### Phase 2 — Multitasking Kernel
**Goal:** Preemptive round-robin scheduler with kernel/user address separation.

Components to build:
- **Exception Vector Table** (`VBAR_EL1`) — timer IRQ, SVC, fault handlers
- **Physical Memory Allocator** — bitmap of 4KB pages, `alloc_page` / `free_page`
- **MMU** — 2-level page tables, `TTBR0_EL1` (user) / `TTBR1_EL1` (kernel)
- **Process Control Block** — saves `x0–x30`, `sp`, `pc`, `pstate`, page table root
- **Scheduler** — fixed array of 8 PCBs, round-robin on timer tick
- **ARM Generic Timer** — `CNTV_TVAL_EL0` → periodic interrupt → context switch
- **Syscall interface** — 8 initial syscalls dispatched from SVC handler

Initial syscall table:

| # | Name | Description |
|---|------|-------------|
| 0 | `write(fd, buf, len)` | Write bytes to file descriptor (fd=1 → UART) |
| 1 | `read(fd, buf, len)` | Read bytes from file descriptor (fd=0 → UART) |
| 2 | `open(path)` → fd | Open a file from RAM FS |
| 3 | `fwrite(fd, buf, len)` | Write to open file |
| 4 | `fread(fd, buf, len)` | Read from open file |
| 5 | `spawn(bin, len)` → pid | Load binary blob, create process, mark READY |
| 6 | `exit(code)` | Terminate calling process |
| 7 | `wait(pid)` → code | Block until child process exits |

---

### Phase 3 — RAM Filesystem + Shell
**Goal:** Interactive shell, file creation, compile-and-run loop.

- **RAM FS** — flat array of 64 file slots: `{ name[64], data[MAX_SIZE], size, used }`
- **Shell** (`shell.js`) — UART REPL, command parser, built-in commands
  - `ls` — list files
  - `cat <file>` — print file contents
  - `echo <text> > <file>` — write to file
  - `ps` — list processes
  - `kill <pid>` — terminate process
  - `js <file.js>` — compile JS file to binary
  - `run <file>` — execute binary
- **Compiler as userland** — `compiler.bin` lives in initramfs, invoked by shell

---

### Phase 4 — Proper Filesystem (Disk I/O)
**Goal:** Persistent storage that survives reboot.

- **SD card driver** — EMMC controller on BCM2837, DMA transfers
- **FAT32 layer** — read/write FAT32 partitions (broadly compatible)
- **VFS abstraction** — `struct vnode`, `vfs_read`, `vfs_write`, `vfs_open`, `vfs_close`
  - RAM FS and FAT32 both register as VFS backends
- **Block cache** — 64-entry LRU cache of 512-byte sectors

---

### Phase 5 — Memory Allocator
**Goal:** Dynamic heap usable by user programs.

- **Kernel heap** — slab allocator for fixed-size kernel objects (PCBs, vnodes, etc.)
- **User heap** — per-process bump allocator backed by `mmap` syscall
- **`mmap` syscall** — maps pages into user address space, backed by physical allocator
- **`brk` / `sbrk` syscall** — grow/shrink heap segment
- New syscalls: `mmap(addr, len, prot)`, `munmap(addr, len)`, `brk(addr)`

---

### Phase 6 — Permissions Model
**Goal:** Multi-user security with capability-based process permissions.

- **UID/GID** — integer user and group IDs per process
- **File permissions** — rwxrwxrwx bits stored in file metadata
- **Privilege escalation** — `setuid` bit on executables
- **Capability flags** — fine-grained per-process capability set
  - `CAP_SYS_ADMIN`, `CAP_NET_BIND`, `CAP_KILL`, etc.
- **User database** — `/etc/passwd` equivalent in VFS
- **login shell** — authenticates before spawning user shell

---

### Phase 7 — Pipes & Signals
**Goal:** Unix-style IPC for composable command pipelines.

- **Pipes** — kernel ring buffer connecting two file descriptors
  - `pipe(fd[2])` syscall — creates read/write ends
  - Shell `|` operator wires `stdout` of left to `stdin` of right
- **Signals** — asynchronous notifications to processes
  - Signal table: `SIGKILL`, `SIGTERM`, `SIGCHLD`, `SIGINT`, `SIGUSR1`, `SIGUSR2`
  - `signal(sig, handler)` — register handler in user space
  - Delivery: kernel sets up trampoline frame on user stack before returning to EL0
  - `sigreturn` syscall — restore original context after handler returns
- New syscalls: `pipe(fds)`, `signal(sig, handler)`, `kill(pid, sig)`, `sigreturn()`

---

### Phase 8 — Dynamic Linker / Loader
**Goal:** Shared libraries to avoid duplicating code in every binary.

- **Binary format (JSOF — JS Object Format)** — custom ELF-inspired format:
  - Header: magic, entry point, section table offset, flags
  - Sections: `.text` (code), `.data` (initialized data), `.bss` (zero-init), `.rel` (relocations), `.dynsym` (exported symbols)
- **Shared library** (`.jslib`) — JSOF with `SHARED` flag, position-independent code
- **Dynamic linker** (`ld.js`) — loaded by kernel at process start:
  - Reads `.dynsym` and `.rel` sections
  - Maps shared libraries into process address space
  - Patches call sites with resolved symbol addresses
- **Standard library** (`libjs.jslib`) — wraps all syscalls, provides string/math/IO

---

### Phase 9 — Networking
**Goal:** TCP/IP stack, usable from JS programs via socket API.

- **LAN9514 driver** — USB Ethernet chip on Raspberry Pi 3 (via USB host controller)
- **Network stack layers:**
  - Ethernet (Layer 2) — frame send/receive
  - ARP — address resolution for IPv4
  - IPv4 — packet routing, fragmentation, checksum
  - ICMP — ping support
  - UDP — connectionless datagrams
  - TCP — reliable streams (3-way handshake, retransmit, flow control)
- **Socket API syscalls:** `socket()`, `bind()`, `listen()`, `accept()`, `connect()`, `send()`, `recv()`, `close()`
- **DNS resolver** — UDP queries to resolve hostnames
- **`net` JS stdlib module** — wraps socket syscalls for user programs

---

### Phase 10 — Self-Hosting
**Goal:** The OS builds itself inside itself.

- JS compiler (`compiler.bin`) is capable of compiling its own source
- `make.js` build script orchestrates kernel + userland compilation
- Cross-bootstrap procedure documented so the OS can be rebuilt from source on JSOS

---

## The JS Dialect

JSOS programs use a typed subset of JavaScript. Rules:

- Functions must have explicit parameter types via JSDoc or suffix convention (`_u32`, `_ptr`)
- No closures, no prototype chain, no garbage collection (manual memory via `mmap`)
- No `eval`, no `JSON`, no `Date`, no `Math` (use stdlib equivalents)
- Numeric literals: decimal, `0x` hex, `0b` binary
- Supported statements: `function`, `let`/`const`, `if/else`, `while`, `for`, `return`
- Intrinsics (compiler-recognized calls):
  - `uart_print(str)` — write string to UART
  - `uart_init()` — initialize PL011 UART
  - `Memory.read32(addr)` — load word from MMIO address
  - `Memory.write32(addr, val)` — store word to MMIO address
  - `syscall(n, ...args)` — emit `SVC #n` instruction

---

## File Layout

```
JSOS/
├── VISION.md               ← this document
├── compiler/
│   ├── package.json
│   └── js2bin.js           ← JS-to-ARM64 binary compiler (runs on Node.js)
├── kernel/
│   └── kernel.js           ← kernel source (compiled by js2bin.js)
├── userland/
│   ├── shell.js
│   ├── compiler.js         ← in-OS compiler (self-hosted eventually)
│   └── stdlib/
│       └── io.js
└── run.sh                  ← one-command build + QEMU launch
```

---

## Hardware Memory Map

| Region | Address Range | Purpose |
|--------|--------------|---------|
| Boot ROM | `0x00000000` | QEMU loads kernel here; we branch to `0x80000` |
| Kernel load | `0x00080000` | `kernel8.img` entry point |
| Kernel stack | `0x00080000` ↓ | Grows downward from load address |
| Kernel heap | `0x00400000` | Slab allocator pool |
| User space | `0x00800000+` | Per-process mapped pages |
| UART0 (PL011) | `0x3F201000` | Serial I/O |
| Timer | `0x3F003000` | ARM system timer |
| GPIO | `0x3F200000` | General-purpose I/O |
| Interrupt ctrl | `0x3F00B000` | BCM2837 interrupt controller |

---

## Build Pipeline

### Phase 1 (current) — host-side only
```
kernel.js  →  [js2bin.js on Node.js]  →  kernel8.img  →  QEMU
```

### Phase 3+ — compiler lives inside the OS
```
shell> js kernel.js        # invokes compiler.bin inside JSOS
shell> run kernel8.img     # boots new kernel in nested QEMU (eventually)
```

---

## Design Principles

1. **No C.** Every line of systems code is written in the JS dialect. The compiler and
   kernel are both JS source.
2. **No external assembler or linker.** `js2bin.js` emits ARM64 machine code bytes
   directly. No `gas`, no `ld`, no `objcopy`.
3. **Flat binaries first.** No ELF until Phase 8. Entry at offset 0. Simpler to load,
   simpler to debug.
4. **One file, one program.** Until the dynamic linker exists, every binary is
   self-contained.
5. **QEMU first, hardware second.** All development targets QEMU `raspi3b`. Physical
   RPi3 comes after each phase is stable in emulation.
6. **Incremental self-hosting.** Each phase's tools are usable from within the OS by
   the next phase.
