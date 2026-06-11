# Vision: A Native JS Runtime for Yog OS

> **Status**: Long-term research goal. Not yet scheduled. Captured here for future reference.

## The Idea

The ultimate ambition for Yog/JSOS is not just to print "Hello, World!" from bare metal — it is to run **JavaScript natively on bare metal**, with access to the npm ecosystem, so that JS developers can write actual applications for the OS using the tools and packages they already know.

The reference model is [node-os](https://github.com/nicowillis/node-os): an operating system where Node.js and npm are the primary userland, replacing the traditional POSIX shell + C standard library stack. The vision for Yog is similar, but built from scratch using Yog's own compiler rather than porting an existing runtime.

## Why This Matters

JS developers have a massive ecosystem of tested, well-maintained libraries. If Yog OS can:

1. Run a JS engine natively on bare metal
2. Implement enough POSIX-like syscalls to satisfy the engine's ABI
3. Support npm module resolution at the OS level

...then a JS developer could `npm install` a library and run it on their microcontroller or Raspberry Pi without any cross-compilation, C toolchain, or foreign language. The OS and the application code live in the same world.

## Architecture Sketch

```
┌────────────────────────────────────┐
│         npm application             │  ← user code (TypeScript/JS)
├────────────────────────────────────┤
│         JS engine (V8 / SpiderMonkey│  ← native binary, compiled by yogc
│         / QuickJS / Duktape)        │    or cross-compiled and linked
├────────────────────────────────────┤
│         Yog OS kernel               │  ← bare-metal Yog kernel (JSOS)
│  - process scheduler                │    providing engine's syscalls:
│  - memory allocator                 │    read, write, mmap, futex, etc.
│  - VFS / block driver               │
│  - network stack                    │
├────────────────────────────────────┤
│         Hardware                    │  ← RPi3, ESP32, x86_64, etc.
└────────────────────────────────────┘
```

## Stages Toward This Goal

| Stage | What | Notes |
|---|---|---|
| **Now (Phase 1–4)** | Yog compiler produces bare-metal binaries | UART output, memory-mapped I/O |
| **Phase 5** | Yog kernel with process model + syscall table | `fork`, `exec`, `read`, `write`, `mmap` |
| **Phase 6** | File system driver | FAT32 or a simple log-structured FS on SD/flash |
| **Phase 7** | Port QuickJS or Duktape | Lightweight engines (~200 KB) compilable by yogc or LLVM |
| **Phase 8** | npm module resolver | Load CommonJS/ESM modules from the filesystem |
| **Phase 9** | Network stack | TCP/IP, HTTP — enables `npm install` from the device |
| **Phase 10** | Self-hosting | Yog compiler runs on Yog OS, compiles itself |

## Engine Choice

For bare-metal JS, a lightweight embedded engine is more practical than V8 (which requires ~50 MB of RAM and a complex build system):

- **[QuickJS](https://bellard.org/quickjs/)** — ~210 KB footprint, full ES2023, written in C. Most likely candidate for Phase 7. Compiles to ARM64/x86_64 with a standard C toolchain.
- **[Duktape](https://duktape.org/)** — similar footprint, single-file distribution, good embedded track record.
- **[Hermes](https://hermesengine.dev/)** — Facebook's engine optimised for low memory, but Android-focused.
- **V8** — the gold standard, but requires >128 MB RAM; only realistic on RPi-class hardware.

## The yogc Connection

The Yog compiler's role evolves across these stages:

| Phase | yogc role |
|---|---|
| 1–4 | Produces kernel8.img / app.bin / app.elf from .yog source |
| 5–7 | Compiles kernel modules written in Yog; links with the JS engine binary |
| 8 | LLVM IR backend — delegate to LLVM for full C interop and optimisation |
| 10 | yogc compiled and run by the Yog JS runtime on Yog OS |

## Prior Art

- **[node-os](https://github.com/nicowillis/node-os)** — the direct inspiration; runs Node.js as the OS userland on top of a Linux kernel.
- **[JerryScript + Zephyr](https://github.com/jerryscript-project/jerryscript)** — JS on RTOS for IoT devices.
- **[Espruino](https://www.espruino.com/)** — JS interpreter that runs directly on microcontrollers; limited npm support.
- **[KasperskyOS](https://os.kaspersky.com/)** — demonstrates that a high-level language (Kotlin/Rust) can be a first-class systems language.

## Open Questions

- Which engine to port first? (QuickJS is the most tractable starting point.)
- Is the npm ecosystem compatible with bare-metal (no `process.env`, no `fs` on the host)?
- How do we handle native Node.js add-ons (`.node` files, N-API)?
- Should Yog OS present a POSIX-compatible ABI, or define a new one optimised for the JS engine?
