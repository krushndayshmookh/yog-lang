# Syscall Table

Syscalls are the interface between user-space programs and the JSOS kernel. They are invoked from Yog code with the `syscall()` intrinsic, which `yogc` compiles to a `SVC #0` instruction.

> **Phase 2+ — not yet implemented.** The table below documents the planned interface. Phase 1 has no kernel/user boundary; all code runs in EL1.

## How syscalls work

```js
// User code
const n = syscall(0, 1, buf, len);   // write(fd=1, buf, len) → bytes written
```

`yogc` emits:

```asm
; Arguments already in x0–x2 (placed by caller)
movz x8, #0          ; syscall number
svc  #0              ; trap to EL1 kernel SVC handler
; return value in x0
```

The kernel SVC handler (Phase 2) reads `x8` for the syscall number and dispatches to the appropriate handler. Return values are placed in `x0` before `eret`.

## Phase 2 — Core I/O

| Number | Name | Signature | Description |
|---|---|---|---|
| 0 | `write` | `(fd, buf, len) → n` | Write `len` bytes from `buf` to file descriptor `fd` |
| 1 | `read` | `(fd, buf, len) → n` | Read up to `len` bytes from `fd` into `buf` |
| 2 | `open` | `(path) → fd` | Open a file; returns file descriptor or negative error |
| 3 | `fwrite` | `(fd, buf, len) → n` | Buffered write |
| 4 | `fread` | `(fd, buf, len) → n` | Buffered read |
| 5 | `spawn` | `(bin, len) → pid` | Load binary image of `len` bytes from `bin` and start a new process |
| 6 | `exit` | `(code)` | Terminate the calling process with exit code `code` |
| 7 | `wait` | `(pid) → code` | Block until process `pid` exits; return its exit code |

Well-known file descriptors:

| fd | Target |
|---|---|
| 0 | stdin (UART RX) |
| 1 | stdout (UART TX) |
| 2 | stderr (UART TX) |

## Phase 5 — Memory management

| Number | Name | Signature | Description |
|---|---|---|---|
| 8 | `mmap` | `(addr, len, prot) → ptr` | Map `len` bytes at hint address `addr`; returns actual address |
| 9 | `munmap` | `(addr, len) → 0` | Unmap a previously mapped region |
| 10 | `brk` | `(addr) → addr` | Set program break (end of heap segment) |

`prot` flags (OR together):

| Value | Meaning |
|---|---|
| `0x1` | `PROT_READ` |
| `0x2` | `PROT_WRITE` |
| `0x4` | `PROT_EXEC` |

## Phase 7 — IPC and signals

| Number | Name | Signature | Description |
|---|---|---|---|
| 11 | `pipe` | `(fds)` | Create a pipe; write fd and read fd placed in `fds[0]` and `fds[1]` |
| 12 | `signal` | `(sig, handler)` | Register `handler` as the signal handler for signal number `sig` |
| 13 | `kill` | `(pid, sig) → 0` | Send signal `sig` to process `pid` |
| 14 | `sigreturn` | `()` | Return from a signal handler; restores saved register state |

## Calling convention

JSOS follows the AArch64 procedure call standard (AAPCS64) for syscalls:

- Arguments in `x0`–`x5` (up to 6)
- Syscall number in `x8`
- Return value in `x0`
- Negative return values indicate errors (errno-style)
- Registers `x0`–`x17` are caller-saved across `SVC`

The `syscall()` intrinsic in Yog handles argument placement and number loading. Direct `SVC` instructions are not part of the Yog dialect.
