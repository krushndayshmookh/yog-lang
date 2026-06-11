# Yog
## A systems compiler for JS developers

---

## What Is Yog?

Yog (योग — union) is a compiler that takes JavaScript syntax and produces native machine code that runs directly on hardware — no VM, no interpreter, no runtime overhead.

The goal: let JS developers target bare metal. Write `.yog` files in a typed JS dialect. Compile with `yogc`. Boot on hardware.

The OS (JSOS) is one demonstration of what Yog-compiled code can do. The compiler is the product.

Target hardware: Raspberry Pi 3 (AArch64 / ARMv8-A). Development and testing via QEMU.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  USER SPACE (EL0)                                             │
│  [ Shell ]  [ yogc ]  [ User Programs ]  [ Daemons ]         │
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

### Compiler pipeline

```
.yog source
    │
    ▼
TypeScript compiler API → AST
    │
    ▼
yogc code generator
    │
    ├─ ARM64 backend → flat binary (Phase 1 → Phase 7)
    └─ LLVM IR backend → portable (Phase 8+, all architectures)
```

---

## The Yog Dialect

Yog uses a typed subset of JavaScript. Same syntax, different semantics.

**Supported:**
- `function`, `let`/`const`, `if`/`else`, `while`, `for`, `return`
- Numeric literals: decimal, `0x` hex, `0b` binary
- Types via JSDoc annotations: `/** @type {u32} */` or suffix convention (`_u32`, `_ptr`)

**Not supported (no runtime = no GC):**
- Closures, prototype chain, `class` (Phase 1–7)
- `eval`, `JSON`, `Date`, `Math` — use stdlib equivalents from `yog-std`
- Dynamic dispatch, `typeof`, `instanceof`

**Compiler intrinsics (Phase 1):**
- `uart_init()` — initialise PL011 UART
- `uart_print(str)` — write string literal to UART
- `Memory.read32(addr)` — load word from MMIO address → W0
- `Memory.write32(addr, val)` — store word to MMIO address
- `syscall(n, ...args)` — emit `SVC #n` (Phase 2+)

---

## Monorepo Layout

```
yog/
├── package.json            ← npm workspaces root
├── VISION.md               ← this document
│
├── yogc/                   ← the compiler
│   ├── package.json
│   └── src/
│       └── index.js        ← Phase 1: TypeScript API → native binary
│
├── yog-core/               ← bare-metal stdlib (no OS, no syscalls)
│   ├── package.json
│   └── src/
│
├── yog-std/                ← OS-backed stdlib (syscalls, io, net)
│   ├── package.json
│   └── src/
│
├── kernel/                 ← JSOS demo kernel
│   └── kernel.yog
│
├── userland/               ← shell, tools, daemons
│   ├── shell.yog
│   └── stdlib/
│
├── docs/                   ← VitePress documentation site
│   ├── package.json
│   ├── .vitepress/
│   │   └── config.js
│   ├── index.md
│   ├── guide/
│   └── reference/
│
└── run.sh                  ← one-command build + QEMU boot
```

---

## Milestones

### Phase 1 — Proof of Concept (current)
**Goal:** Boot QEMU, print "Hello, World!" to serial console.

- [x] `yogc` compiler — `.yog` → ARM64 flat binary (no assembler, no linker)
- [x] Boot stub — halt cores 1–3, set stack pointer, call `main`
- [x] UART intrinsics — `uart_init()` + `uart_print("string")`
- [ ] QEMU boot verification

Deliverable: `kernel8.img` that prints "Hello, World!\n" and halts.

---

### Phase 2 — Multitasking Kernel
**Goal:** Preemptive round-robin scheduler with kernel/user address separation.

- **Exception Vector Table** (`VBAR_EL1`) — timer IRQ, SVC, fault handlers
- **Physical Memory Allocator** — bitmap of 4KB pages, `alloc_page` / `free_page`
- **MMU** — 2-level page tables, `TTBR0_EL1` (user) / `TTBR1_EL1` (kernel)
- **Process Control Block** — saves `x0–x30`, `sp`, `pc`, `pstate`, page table root
- **Scheduler** — fixed array of 8 PCBs, round-robin on timer tick
- **ARM Generic Timer** — `CNTV_TVAL_EL0` → periodic interrupt → context switch
- **Syscall interface** — initial syscall table via SVC handler

Initial syscall table:

| # | Name | Description |
|---|------|-------------|
| 0 | `write(fd, buf, len)` | Write bytes to fd (fd=1 → UART) |
| 1 | `read(fd, buf, len)` | Read bytes from fd (fd=0 → UART) |
| 2 | `open(path)` → fd | Open a file from RAM FS |
| 3 | `fwrite(fd, buf, len)` | Write to open file |
| 4 | `fread(fd, buf, len)` | Read from open file |
| 5 | `spawn(bin, len)` → pid | Load binary blob, create process |
| 6 | `exit(code)` | Terminate calling process |
| 7 | `wait(pid)` → code | Block until child exits |

---

### Phase 3 — RAM Filesystem + Shell
**Goal:** Interactive shell, file creation, compile-and-run loop.

- **RAM FS** — flat array of 64 file slots: `{ name[64], data[MAX_SIZE], size, used }`
- **Shell** (`shell.yog`) — UART REPL, built-in commands: `ls`, `cat`, `echo > file`, `ps`, `kill`, `yog <file.yog>`, `run <file>`
- **yogc as userland** — compiler lives in initramfs, invoked by shell

---

### Phase 4 — Disk I/O
**Goal:** Persistent storage that survives reboot.

- **SD card driver** — EMMC controller on BCM2837, DMA transfers
- **FAT32 layer** — read/write FAT32 partitions
- **VFS abstraction** — `vnode`, `vfs_read`, `vfs_write`, `vfs_open`, `vfs_close`
- **Block cache** — 64-entry LRU cache of 512-byte sectors

---

### Phase 5 — Memory Allocator
**Goal:** Dynamic heap usable by user programs.

- **Kernel heap** — slab allocator for fixed-size kernel objects
- **User heap** — per-process bump allocator backed by `mmap`
- New syscalls: `mmap(addr, len, prot)`, `munmap(addr, len)`, `brk(addr)`

---

### Phase 6 — Permissions
**Goal:** Multi-user security with capability-based permissions.

- **UID/GID** — per-process integer user/group IDs
- **File permissions** — rwxrwxrwx bits in file metadata
- **Capability flags** — `CAP_SYS_ADMIN`, `CAP_NET_BIND`, `CAP_KILL`, etc.
- **login shell** — authenticates before spawning user shell

---

### Phase 7 — Pipes & Signals
**Goal:** Unix-style IPC for composable pipelines.

- **Pipes** — kernel ring buffer, `pipe(fd[2])` syscall, shell `|` operator
- **Signals** — `SIGKILL`, `SIGTERM`, `SIGCHLD`, `SIGINT`, `SIGUSR1/2`
- **Signal delivery** — trampoline frame on user stack, `sigreturn` syscall

---

### Phase 8 — Dynamic Linker / LLVM Backend
**Goal:** Shared libraries + portable compilation via LLVM IR.

- **LLVM IR backend** for `yogc` — emit LLVM IR instead of raw bytes, get all architectures for free
- **YOF (Yog Object Format)** — ELF-inspired binary: `.text`, `.data`, `.bss`, `.rel`, `.dynsym`
- **Shared libraries** (`.yoglib`) — position-independent, loaded at runtime
- **`ld.yog`** — dynamic linker, maps `.yoglib` files, patches call sites
- **`yog-std`** — wraps all syscalls, provides string/math/IO

Architecture priority after ARM64: x86-64 (developer machines), RISC-V.

---

### Phase 9 — Networking
**Goal:** TCP/IP stack usable from Yog programs via socket API.

- **LAN9514 driver** — USB Ethernet on Raspberry Pi 3
- **Network stack** — Ethernet → ARP → IPv4 → ICMP → UDP → TCP
- **Socket syscalls** — `socket`, `bind`, `listen`, `accept`, `connect`, `send`, `recv`
- **`net` module** in `yog-std`

---

### Phase 10 — Self-Hosting
**Goal:** yogc compiles itself inside the OS.

- `yogc` compiled from `.yog` source by a previous-stage `yogc`
- `make.yog` build script orchestrates kernel + userland
- The OS rebuilds itself from source on Yog hardware

---

## Hardware Memory Map

| Region | Address | Purpose |
|--------|---------|---------|
| Boot ROM | `0x00000000` | QEMU loads kernel here; branches to `0x80000` |
| Kernel entry | `0x00080000` | `kernel8.img` load address |
| Kernel stack | `0x00080000` ↓ | Grows downward |
| Kernel heap | `0x00400000` | Slab allocator pool |
| User space | `0x00800000+` | Per-process mapped pages |
| UART0 (PL011) | `0x3F201000` | Serial I/O |
| Timer | `0x3F003000` | ARM system timer |
| GPIO | `0x3F200000` | General-purpose I/O |
| Interrupt ctrl | `0x3F00B000` | BCM2837 interrupt controller |

---

## Build Pipeline

```
# Phase 1 — host-side only
kernel.yog  →  [yogc on Node.js]  →  kernel8.img  →  QEMU

# Phase 3+ — yogc lives inside the OS
shell> yog kernel.yog
shell> run kernel8.img

# Phase 10 — self-hosting
yogc.yog  →  [yogc on Yog]  →  yogc.bin
```

---

## Design Principles

1. **No C.** Every line of systems code is Yog. The compiler and kernel are both Yog source.
2. **No external assembler or linker.** `yogc` emits ARM64 machine code bytes directly. No `gas`, no `ld`, no `objcopy`.
3. **Use community tools where possible.** TypeScript compiler API for parsing, LLVM IR for portable codegen (Phase 8+).
4. **Flat binaries first.** No object format until Phase 8. Entry at offset 0.
5. **QEMU first, hardware second.** All development targets QEMU `raspi3b`.
6. **Incremental self-hosting.** Each phase's tools are usable from within the OS by the next phase.
