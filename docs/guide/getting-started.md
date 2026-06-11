# Getting Started

## Prerequisites

- Node.js 18+
- npm 9+
- QEMU (for running kernels): `brew install qemu` (macOS) or `sudo apt install qemu-system-aarch64`

## Install

Clone the monorepo and install dependencies:

```sh
git clone https://github.com/krushndayshmookh/yog
cd yog
npm install
```

## Write your first Yog program

Create `hello.yog`:

```ts
function main(): void {
    uart_init();
    uart_print("Hello, World!\n");
}
```

## Compile

```sh
node yogc/src/index.js hello.yog hello.img
```

Output:
```
[yogc] OK  hello.yog → hello.img
[yogc]     472 bytes  (118 ARM64 instructions)
[yogc]     Load address: 0x80000  Entry: kernel_main
```

## Run in QEMU

```sh
qemu-system-aarch64 -M raspi3b -kernel hello.img -serial stdio -display none
```

Expected output:
```
Hello, World!
```

Press `Ctrl-A X` to quit QEMU.

## Using run.sh

The repo includes a convenience script that compiles and boots in one command:

```sh
./run.sh
```

Or to compile only without launching QEMU:

```sh
./run.sh --build-only
```
