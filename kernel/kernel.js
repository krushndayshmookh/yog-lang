/**
 * kernel.js — JSOS Phase 1 Kernel
 *
 * This is the first program compiled by the JSOS compiler (js2bin.js).
 * It initialises the UART and prints "Hello, World!" to the serial console.
 *
 * Compile:  node compiler/js2bin.js kernel/kernel.js kernel8.img
 * Run:      qemu-system-aarch64 -M raspi3b -kernel kernel8.img -serial stdio -display none
 *
 * Expected output:
 *   Hello, World!
 */

function kernel_main() {
    uart_init();
    uart_print("Hello, World!\n");
}
