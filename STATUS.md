# Yog / JSOS — Project Status

> Last updated: 2026-06-12

---

## Phase 1 — Proof of Concept ✅ COMPLETE

**Goal:** Compiler produces bare-metal binaries. Programs print to UART / stdout.

### Compiler (`yogc`)
- [x] TypeScript compiler API front-end — parses `.yog` source files
- [x] Pluggable backend architecture — `compiler.js` is backend-agnostic
- [x] ARM64 backend — flat binary (`kernel8.img`) for Raspberry Pi 3 / QEMU raspi3b
- [x] Xtensa LX6 backend — flat binary (`app.bin`) for ESP32, setup()+loop() model
- [x] x86_64 backend — Linux ELF64 executable (`app.elf`), raw syscalls
- [x] Two-pass emitter — placeholders on pass 1, forward-ref patch on pass 2
- [x] Xtensa literal pool — L32R with global pool, resolved at serialise time
- [x] ELF64 generation — pure Node.js, no linker, no assembler
- [x] Cross-compilation — runs on any Node.js ≥ 18 host, targets any supported arch

### Intrinsics
- [x] `uart_init()` — ARM64: PL011 register sequence; ESP32/x86_64: no-op
- [x] `uart_print("...")` — ARM64: inline poll+write loop; ESP32: FIFO write; x86_64: `write` syscall
- [x] `Memory.read32(addr)` — ARM64: `LDR Wt,[Xn]`; ESP32: `L32R`+`L32I`; x86_64: stub
- [x] `Memory.write32(addr, val)` — ARM64: `MOVZ`+`STR`; ESP32: `L32R`+`MOVI`+`S32I`; x86_64: stub

### Bootstrap sequences
- [x] ARM64: multi-core park (MPIDR_EL1 check), stack setup at 0x80000, `BL main`
- [x] ESP32: ROM bootloader handoff, `CALL0 setup` → `CALL0 loop` → infinite J
- [x] x86_64: `_start` → `CALL main` → `MOV EAX,60` / `SYSCALL` (exit 0)

### Standard library stubs (blocked on Phase 2 compiler features)
- [ ] `yog-core`: `mem_copy`, `mem_set`, `str_len`, `str_cmp` — need loops
- [ ] `yog-std`: `print`, `println`, `read_line` — need loops + syscall infra

### Tooling & docs
- [x] npm workspaces monorepo — `yogc`, `yog-core`, `yog-std`, `docs`
- [x] VS Code extension (`vscode-yog`) — syntax highlighting via TS grammar delegation
- [x] VitePress docs site — guide, reference, vision sections
- [x] GitHub Actions workflow — auto-deploys docs to GitHub Pages on push to main
- [x] Example programs for all three targets
- [x] `run.sh` — one-command build + QEMU boot

### Verified output
- ARM64: 472-byte `kernel8.img` boots in QEMU raspi3b, prints "Hello, World!\n"
- x86_64: 193-byte `app.elf` — disassembly verified correct (CALL, PUSH RBP, LEA RSI [RIP+0x13], SYSCALL)
- ESP32: `app.bin` — instruction encoding manually verified; hardware testing pending

---

## Phase 2 — Compiler Features 🔲 NOT STARTED

**Goal:** Add control flow and variables to the compiler so stdlib functions can be written in Yog.

Unblocks: `mem_copy`, `mem_set`, `str_len`, `str_cmp`, `print`, `println` in yog-core/yog-std.

- [ ] `let` / `const` variable declarations (numeric literals)
- [ ] Basic arithmetic: `+`, `-`, `*`, `/`, `%`
- [ ] Comparison operators: `===`, `!==`, `<`, `>`, `<=`, `>=`
- [ ] `while (cond) { }` loops
- [ ] `if (cond) { } else { }` conditionals
- [ ] `return <expr>` with expression support
- [ ] Register allocator (simple — scratch registers per backend)
- [ ] Compiler warnings promoted to errors for unknown constructs

---

## Phase 3 — Kernel Core 🔲 NOT STARTED

**Goal:** Preemptive round-robin scheduler, MMU, syscall interface. Programs run in user space.

- [ ] Exception Vector Table (`VBAR_EL1`) — timer IRQ, SVC, fault handlers
- [ ] Physical Memory Allocator — bitmap of 4 KB pages, `alloc_page` / `free_page`
- [ ] MMU — 2-level page tables, `TTBR0_EL1` (user) / `TTBR1_EL1` (kernel)
- [ ] Process Control Block — saves `x0–x30`, `sp`, `pc`, `pstate`, page-table root
- [ ] Scheduler — fixed array of 8 PCBs, round-robin on timer tick
- [ ] ARM Generic Timer — `CNTV_TVAL_EL0` → periodic interrupt → context switch
- [ ] Syscall interface (`SVC #n`) — `write`, `read`, `open`, `fwrite`, `fread`, `spawn`, `exit`, `wait`
- [ ] yog-core / yog-std fully implemented (loops + syscalls now available)

---

## Phase 4 — RAM Filesystem + Shell 🔲 NOT STARTED

**Goal:** Interactive shell. Compile-and-run loop inside the OS.

- [ ] RAM FS — flat array of 64 file slots (`name[64]`, `data[MAX_SIZE]`, `size`, `used`)
- [ ] Shell (`shell.yog`) — UART REPL, `ls`, `cat`, `echo > file`, `ps`, `kill`, `yog <file>`, `run <bin>`
- [ ] `yogc` compiled as a userland binary, invocable from shell

---

## Phase 5 — Persistent Storage 🔲 NOT STARTED

**Goal:** Disk I/O that survives reboot.

- [ ] SD card / EMMC driver (BCM2837)
- [ ] FAT32 layer — read/write FAT32 partitions
- [ ] VFS abstraction — `vnode`, `vfs_read`, `vfs_write`, `vfs_open`, `vfs_close`
- [ ] Block cache — 64-entry LRU, 512-byte sectors

---

## Phase 6 — Memory Allocator 🔲 NOT STARTED

**Goal:** Dynamic heap for user programs.

- [ ] Kernel heap — slab allocator for fixed-size objects
- [ ] User heap — per-process bump allocator, backed by `mmap`
- [ ] Syscalls: `mmap`, `munmap`, `brk`
- [ ] macOS native target (Mach-O, BSD syscalls) — for desktop Yog programs

---

## Phase 7 — Permissions 🔲 NOT STARTED

- [ ] UID/GID per process
- [ ] File permissions (rwxrwxrwx bits)
- [ ] Capability flags (`CAP_SYS_ADMIN`, `CAP_NET_BIND`, `CAP_KILL`, etc.)
- [ ] Login shell

---

## Phase 8 — IPC & Signals 🔲 NOT STARTED

- [ ] Pipes — kernel ring buffer, `pipe(fd[2])`, shell `|` operator
- [ ] Signals — `SIGKILL`, `SIGTERM`, `SIGCHLD`, `SIGINT`, `SIGUSR1/2`
- [ ] Signal delivery — trampoline frame on user stack, `sigreturn` syscall

---

## Phase 9 — LLVM IR Backend + Shared Libraries 🔲 NOT STARTED

**Goal:** Portable compilation via LLVM. All architectures for free.

- [ ] LLVM IR backend for `yogc` — emit `.ll`, delegate to `llc` + `lld`
- [ ] YOF (Yog Object Format) — ELF-inspired: `.text`, `.data`, `.bss`, `.rel`, `.dynsym`
- [ ] Shared libraries (`.yoglib`) — position-independent, runtime-loaded
- [ ] `ld.yog` dynamic linker
- [ ] Windows native target (PE32+, Win32/NT syscalls)

---

## Phase 10 — Networking 🔲 NOT STARTED

- [ ] LAN9514 USB Ethernet driver (Raspberry Pi 3)
- [ ] Network stack: Ethernet → ARP → IPv4 → ICMP → UDP → TCP
- [ ] Socket syscalls: `socket`, `bind`, `listen`, `accept`, `connect`, `send`, `recv`
- [ ] `net` module in `yog-std`

---

## Phase 11 — JS Runtime (Long-term Vision) 🔲 NOT STARTED

**Goal:** npm ecosystem on bare metal. See `docs/vision/js-runtime.md`.

- [ ] Port QuickJS or Duktape to Yog OS (ARM64/x86_64)
- [ ] npm module resolver — load CommonJS/ESM from the filesystem
- [ ] POSIX-compatible ABI layer for the JS engine
- [ ] `npm install` from a network-connected Yog device
- [ ] yogc compiled by the Yog JS runtime (self-hosting via JS)

---

## Phase 12 — Self-Hosting 🔲 NOT STARTED

**Goal:** `yogc` compiles itself. The OS rebuilds itself from source.

- [ ] `yogc.yog` — compiler rewritten in Yog
- [ ] `make.yog` — build script orchestrates kernel + userland
- [ ] Yog OS on RPi3 compiles a new `kernel8.img` from its own source

---

## Stale / Cleanup

| File | Status | Action |
|---|---|---|
| `kernel/kernel.js` | Stale — pre-Yog file referencing `kernel_main` | Delete manually |
| `compiler/` | Stale — old `js2bin.js` predecessor to `yogc/` | Delete manually |
| `kernel8.img` | May be stale — compiled before `main` rename | Regenerate: `yogc kernel/kernel.yog kernel8.img` |

---

## Quick Reference

```sh
# Compile for ARM64 (RPi3 / QEMU)
yogc kernel/kernel.yog kernel8.img

# Run in QEMU
qemu-system-aarch64 -M raspi3b -kernel kernel8.img -serial stdio -display none

# Compile for x86_64 (Linux / macOS via QEMU user-mode)
yogc --target x86_64 examples/x86_64-hello/main.yog app.elf
qemu-x86_64 app.elf

# Compile for ESP32
yogc --target xtensa-esp32 examples/esp32-hello/main.yog app.bin

# Docs dev server
npm run docs:dev
```
