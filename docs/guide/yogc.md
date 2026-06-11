# yogc CLI

`yogc` is the Yog compiler. It takes a `.yog` source file and produces a native binary for the target architecture.

## Usage

```sh
yogc [--target <target>] <input.yog> [output]
```

**Default target:** `arm64` (Raspberry Pi 3 / QEMU raspi3b)

## Examples

```sh
# ARM64 — produces kernel8.img
yogc kernel/kernel.yog kernel8.img

# Xtensa ESP32 — produces app.bin
yogc --target xtensa-esp32 app/main.yog app.bin

# x86_64 Linux — produces app.elf
yogc --target x86_64 examples/x86_64-hello/main.yog app.elf
```

## Targets

| Target flag | Architecture | Default output | Entry point |
|---|---|---|---|
| `arm64` | ARM64 (AArch64) | `kernel8.img` | `function main(): void` |
| `xtensa-esp32` | Xtensa LX6 | `app.bin` | `function setup(): void` + `function loop(): void` |
| `x86_64` | x86_64 Linux ELF64 | `app.elf` | `function main(): void` |

## How it works

`yogc` is a two-phase compiler: the front-end parses `.yog` source using the TypeScript compiler API; the back-end emits native machine code directly with no intermediate representation or linker.

```
.yog source
    │
    ▼
TypeScript compiler API   ← ts.createSourceFile() + ts.forEachChild()
    │
    ▼
AST walker (Compiler)     ← visits FunctionDeclaration, CallExpression nodes
    │
    ▼
Backend emitter           ← emits instruction words / bytes; placeholders for forward refs
  Pass 1: emit()          ← append instructions; record label sites
  Pass 2: resolve()       ← patch forward references with real offsets
    │
    ├─ arm64 backend      → flat binary (LE 32-bit words)
    ├─ xtensa backend     → flat binary (LE 24-bit words) + literal pool
    └─ x86_64 backend     → ELF64 executable (code + string pool)
```

**Why TypeScript compiler API?** Yog syntax is a typed subset of TypeScript. Using the official TS API gives `yogc` a complete, spec-correct TypeScript parser for free, so Yog programs can be type-checked with `tsc` before compilation.

**Why two passes?** Forward references — the bootstrap stub's `BL main` instruction is emitted before `main`'s byte offset is known. Pass 1 emits a zero placeholder and records the patch site. Pass 2 fills in the correct signed offset once all labels are defined.

**No linker, no assembler, no C toolchain.** `yogc` writes the output binary directly from JavaScript `Buffer` operations. This means it runs on any platform with Node.js ≥ 18 and can cross-compile for any supported target.

## Supported constructs (Phase 1)

| Construct | Notes |
|---|---|
| `FunctionDeclaration` | Top-level functions only |
| `ExpressionStatement` (call) | Only intrinsic calls |
| `uart_init()` | Inline UART init sequence (target-specific) |
| `uart_print("...")` | String literal only; target-specific inline output |
| `Memory.write32(addr, val)` | Both arguments must be numeric literals |
| `Memory.read32(addr)` | Argument must be a numeric literal |

Unsupported statement types produce a warning and are skipped. This allows you to write `.yog` files with `let`, `if`, and `return` in them today — the compiler will skip those nodes until support is added.

## Output

On success, `yogc` prints:

```
[yogc] OK  kernel/kernel.yog → kernel8.img  (target: arm64)
[yogc]     472 bytes

qemu-system-aarch64 -M raspi3b -kernel kernel8.img -serial stdio -display none
```

The QEMU command is printed for convenience — copy-paste it to run immediately.

## Running without install

If `yogc` is not on your `PATH`:

```sh
node yogc/src/index.js [--target <target>] <input.yog> [output]
```

## Cross-compilation

Because `yogc` has no native dependencies, it cross-compiles freely:

| Host | Target | How to run output |
|---|---|---|
| macOS (Apple Silicon) | arm64 | Copy to RPi3, or `qemu-system-aarch64 -M raspi3b` |
| macOS (Apple Silicon) | x86_64 | `qemu-x86_64 app.elf` |
| Linux x86_64 | arm64 | Copy to RPi3, or `qemu-system-aarch64 -M raspi3b` |
| Linux x86_64 | x86_64 | `chmod +x app.elf && ./app.elf` |

See the per-target guides under [Targets](/guide/targets/arm64) for full details.

## Future: LLVM IR backend (Phase 8)

Phase 8 will add an LLVM IR backend for full portability:

```
.yog source → AST → LLVM IR → llc → native object → lld → binary
```

This gives `yogc` every architecture LLVM supports (x86-64, RISC-V, MIPS, WebAssembly) without maintaining separate code-generation backends. The current backends remain for bare-metal targets where LLVM is unavailable.
