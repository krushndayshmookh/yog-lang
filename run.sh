#!/usr/bin/env bash
# run.sh — Build and boot JSOS in QEMU
#
# Usage:
#   ./run.sh              # compile kernel.js and boot
#   ./run.sh --build-only # compile but don't launch QEMU
#
# Requirements:
#   node >= 16
#   npm
#   qemu-system-aarch64

set -e

COMPILER_DIR="$(dirname "$0")/compiler"
KERNEL_SRC="$(dirname "$0")/kernel/kernel.js"
KERNEL_IMG="$(dirname "$0")/kernel8.img"

# Install npm deps if not already installed
if [ ! -d "$COMPILER_DIR/node_modules" ]; then
  echo "[jsos] Installing compiler dependencies..."
  (cd "$COMPILER_DIR" && npm install --silent)
fi

# Compile kernel.js → kernel8.img
echo "[jsos] Compiling $KERNEL_SRC..."
node "$COMPILER_DIR/js2bin.js" "$KERNEL_SRC" "$KERNEL_IMG"

if [[ "$1" == "--build-only" ]]; then
  exit 0
fi

# Check QEMU is available
if ! command -v qemu-system-aarch64 &>/dev/null; then
  echo ""
  echo "[jsos] QEMU not found. Install it first:"
  echo "  macOS:  brew install qemu"
  echo "  Debian: sudo apt install qemu-system-aarch64"
  echo ""
  echo "Then run:"
  echo "  qemu-system-aarch64 -M raspi3b -kernel $KERNEL_IMG -serial stdio -display none"
  exit 1
fi

echo "[jsos] Booting in QEMU (Ctrl-A X to quit)..."
echo "──────────────────────────────────────────"
qemu-system-aarch64 \
  -M raspi3b \
  -kernel "$KERNEL_IMG" \
  -serial stdio \
  -display none
