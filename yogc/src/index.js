#!/usr/bin/env node
'use strict';

/**
 * yogc — The Yog Compiler  (CLI entry point)
 *
 * Usage:
 *   yogc [--target <target>] <input.yog> [output]
 *
 * Targets:
 *   arm64         Raspberry Pi 3 / QEMU raspi3b (default)
 *   xtensa-esp32  ESP32 (Xtensa LX6, dual-core 240 MHz)
 *
 * Examples:
 *   yogc kernel/kernel.yog kernel8.img
 *   yogc --target arm64 kernel/kernel.yog kernel8.img
 *   yogc --target xtensa-esp32 app/main.yog app.bin
 */

const fs   = require('fs');
const path = require('path');
const { Compiler } = require('./compiler');

// ─── Available backends ───────────────────────────────────────────────────────

const BACKENDS = {
  'arm64':        './backends/arm64',
  'xtensa-esp32': './backends/xtensa',
  'x86_64':       './backends/x86_64',
};

// ─── CLI argument parsing ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  let target = 'arm64';
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--target' || args[i] === '-t') && args[i + 1]) {
      target = args[++i];
    } else if (args[i].startsWith('--target=')) {
      target = args[i].slice('--target='.length);
    } else {
      positional.push(args[i]);
    }
  }

  return {
    target,
    inputPath:  positional[0] || null,
    outputPath: positional[1] || null,
  };
}

// ─── Backend loader ───────────────────────────────────────────────────────────

function loadBackend(target) {
  const modulePath = BACKENDS[target];
  if (!modulePath) {
    const available = Object.keys(BACKENDS).join(', ');
    console.error(`[yogc] Unknown target: "${target}". Available targets: ${available}`);
    process.exit(1);
  }
  return require(modulePath);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const { target, inputPath, outputPath } = parseArgs(process.argv);

  if (!inputPath) {
    console.error('Usage: yogc [--target arm64|xtensa-esp32] <input.yog> [output]');
    console.error('');
    console.error('Targets:');
    for (const [t, mod] of Object.entries(BACKENDS)) {
      const b = require(mod);
      console.error(`  ${t.padEnd(16)} default output: ${b.defaultOutput}`);
    }
    console.error('');
    console.error('Examples:');
    console.error('  yogc kernel/kernel.yog kernel8.img');
    console.error('  yogc --target xtensa-esp32 app/main.yog app.bin');
    process.exit(1);
  }

  const backend = loadBackend(target);
  const out     = outputPath || backend.defaultOutput;

  // Read source
  let source;
  try {
    source = fs.readFileSync(inputPath, 'utf8');
  } catch (err) {
    console.error(`[yogc] Cannot read input "${inputPath}": ${err.message}`);
    process.exit(1);
  }

  // Compile
  let buf;
  try {
    const compiler = new Compiler(inputPath, source, backend);
    buf = compiler.compile();
  } catch (err) {
    console.error(`[yogc] Compilation failed: ${err.message}`);
    process.exit(1);
  }

  // Write output
  try {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, buf);
  } catch (err) {
    console.error(`[yogc] Cannot write output "${out}": ${err.message}`);
    process.exit(1);
  }

  console.log(`[yogc] OK  ${inputPath} → ${out}  (target: ${target})`);
  console.log(`[yogc]     ${buf.length} bytes`);
  console.log('');
  console.log(backend.qemuCommand(out));
}

main();
