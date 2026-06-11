# The Yog Dialect

Yog is a **typed subset of TypeScript**. The syntax is standard TypeScript — TS-style type annotations, standard keywords, the same expression grammar — but the semantics are entirely different. There is no runtime, no garbage collector, and no standard library.

Think of it the way AssemblyScript relates to TypeScript: the notation is familiar, but execution maps directly to machine instructions.

> **IDE support:** Since Yog uses TypeScript syntax, you get full IntelliSense and type checking in VS Code by pointing your `tsconfig.json` at `yog-core/yog.d.ts`. See [Editor Setup](/guide/editor-setup) for details.

## Types

Yog declares its primitive types in `yog-core/yog.d.ts`. They are TypeScript type aliases that map to `number` or `boolean` at the TS level but carry semantic meaning that `yogc` uses to select instruction widths and overflow behavior.

| Yog type | Width | Signed |
|---|---|---|
| `u8` | 8-bit | unsigned |
| `u16` | 16-bit | unsigned |
| `u32` | 32-bit | unsigned |
| `u64` | 64-bit | unsigned |
| `i8` | 8-bit | signed |
| `i16` | 16-bit | signed |
| `i32` | 32-bit | signed |
| `i64` | 64-bit | signed |
| `usize` | pointer-width | unsigned |
| `isize` | pointer-width | signed |
| `bool` | 1-bit logical | — |
| `ptr<T>` | pointer-width | unsigned (address) |

`void` is standard TypeScript — no alias needed.

## Supported constructs

```typescript
// Function declarations with TypeScript type annotations
function add(a: u32, b: u32): u32 {
    return a + b;
}

function kernel_main(): void {
    uart_init();
    uart_print("Hello!\n");
}

// Variable declarations
let x: u32 = 42;
const BASE: u32 = 0x3F201000;

// Control flow
if (x > 0) {
    // ...
} else {
    // ...
}

while (x > 0) {
    x = x - 1;
}

for (let i: u32 = 0; i < 8; i = i + 1) {
    // ...
}

return x;
```

**Numeric literals** — decimal, hex, and binary are all valid:

```typescript
const n: u32  = 255;
const n2: u32 = 0xFF;
const n3: u32 = 0b11111111;
```

## Not supported

The following features are explicitly out of scope. They either require a runtime, a GC, or introduce semantics incompatible with bare-metal execution:

| Feature | Reason |
|---|---|
| Closures / lexical capture | Requires heap-allocated environments |
| Prototype chain | Dynamic dispatch, no vtable model |
| `class` | Syntactic sugar over prototype chain |
| `eval` | Requires a runtime compiler |
| `JSON`, `Date`, `Math` | Standard library — not available bare-metal |
| Dynamic dispatch | Requires runtime type tags |
| Generators / `async`/`await` | Require coroutine machinery |
| Decorators | No runtime reflection model |
| `arguments` object | Variadic calling convention not modelled |

If you write unsupported constructs, `yogc` will emit a warning and skip the node. Errors will be promoted to hard failures in Phase 3.

## Compiler intrinsics

Intrinsics are special call sites that `yogc` recognises by name and replaces with inline ARM64 sequences. They are **not** function calls at runtime. Their types are declared in `yog-core/yog.d.ts` so the TypeScript language server can check them.

```typescript
// Initialise PL011 UART at 115200 baud
uart_init();

// Print a string literal to UART — must be a compile-time string
uart_print("Hello, World!\n");

// Read a 32-bit word from a memory-mapped register
const val: u32 = Memory.read32(0x3F201018);

// Write a 32-bit word to a memory-mapped register
Memory.write32(0x3F201000, 0x61);

// Read / write a single byte
const b: u8 = Memory.read8(0x3F201018);
Memory.write8(0x3F201001, 0x00);

// Issue a supervisor call (Phase 2+)
syscall(0, fd, buf, len);
```

See [Compiler Intrinsics](/reference/intrinsics) for the full encoding details.

## Why these constraints?

Yog targets environments with:

- **No GC** — the kernel is the memory allocator; heap regions are acquired via `mmap` syscalls (Phase 5)
- **No runtime overhead** — every instruction in the output image was explicitly emitted by `yogc`
- **Flat address space** — no OS, no page tables at boot; memory layout is fixed by the linker script (or hardcoded to `0x80000`)

The constraints are not limitations of ambition — they are the precise properties that make bare-metal execution possible from a TypeScript-syntax source file.
