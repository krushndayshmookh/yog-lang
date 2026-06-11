# What is Yog?

Yog (योग — *union*) is a systems compiler that takes JavaScript syntax and produces native machine code. No virtual machine. No garbage collector. No C runtime.

## The problem it solves

JS developers who want to target hardware currently have two choices:

1. Learn C/C++ or Rust — a different language with different tooling
2. Use an embedded JS runtime (like Espruino) — which adds a significant interpreter overhead

Yog is a third path: take the JS syntax you already know, apply systems-programming semantics, and compile directly to binary. The JS ecosystem's parser tooling (acorn, babel, etc.) handles the frontend. Yog handles the backend.

## Yog vs JavaScript

Yog is **not** JavaScript. It uses JS syntax as a notation, but:

- There is no garbage collector — memory is managed manually via `mmap`
- There are no closures, no prototype chains, no `this`
- There is no standard library — only compiler intrinsics and `yog-std`
- Types must be explicit (via JSDoc annotations or naming conventions)

Think of the relationship the way AssemblyScript relates to TypeScript: same syntax, completely different execution model.

## The compiler: yogc

`yogc` is the compiler. It takes `.yog` source files and produces flat binary images:

```sh
yogc kernel/kernel.yog kernel8.img
qemu-system-aarch64 -M raspi3b -kernel kernel8.img -serial stdio -display none
```

Phase 1 targets ARM64 (Raspberry Pi 3 / QEMU raspi3b). Phase 8 adds an LLVM IR backend, giving every architecture LLVM supports.

## The demo: JSOS

JSOS is a bare-metal operating system written entirely in Yog — no C, no assembly. It's the primary demonstration that Yog works. The phases in this documentation track JSOS's development from a blinking UART to a self-hosting OS.

But JSOS is just one thing you can build. Yog can target any bare-metal ARM64 system.

## Next steps

- [Getting Started](/guide/getting-started) — install and compile your first `.yog` file
- [The Yog Dialect](/guide/dialect) — what's supported, what's not, and why
