/**
 * Yog primitive types and compiler intrinsics.
 * Include this file in your tsconfig.json to get type checking for .yog programs.
 */

// ---------------------------------------------------------------------------
// Primitive integer types
// These map to `number` at the TypeScript level but carry semantic meaning
// that yogc uses to select the right instruction widths and overflow behavior.
// ---------------------------------------------------------------------------

type u8    = number;
type u16   = number;
type u32   = number;
type u64   = number;

type i8    = number;
type i16   = number;
type i32   = number;
type i64   = number;

type usize = number;
type isize = number;

// ---------------------------------------------------------------------------
// Pointer type
// Pointers are just addresses, which are plain numbers in Yog's flat address
// space. The type parameter T gives the pointee type for documentation
// purposes; yogc does not yet enforce pointee types.
// ---------------------------------------------------------------------------

type ptr<T = unknown> = number;

// ---------------------------------------------------------------------------
// Boolean
// ---------------------------------------------------------------------------

type bool = boolean;

// `void` is already a standard TypeScript type — no alias needed.

// ---------------------------------------------------------------------------
// Phase 1 compiler intrinsics
// These are recognised by name in yogc and replaced with inline instruction
// sequences. They are NOT real function calls at runtime.
// ---------------------------------------------------------------------------

declare function uart_init(): void;
declare function uart_print(s: string): void;
declare function syscall(n: u32, a0?: u64, a1?: u64, a2?: u64, a3?: u64, a4?: u64, a5?: u64): u64;

// ---------------------------------------------------------------------------
// Memory namespace — memory-mapped I/O intrinsics
// ---------------------------------------------------------------------------

declare namespace Memory {
    function read32(addr: u32): u32;
    function write32(addr: u32, val: u32): void;
    function read8(addr: u32): u8;
    function write8(addr: u32, val: u8): void;
}
