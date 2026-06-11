# Editor Setup

Yog is a TypeScript superset — `.yog` files are valid TypeScript with additional bare-metal constructs layered on top. This means you can get excellent editor support by pointing your editor's TypeScript tooling at `.yog` files.

## VS Code

The recommended editor for Yog development is [Visual Studio Code](https://code.visualstudio.com/). The monorepo ships a first-party extension at `vscode-yog/`.

### What the extension provides

| Feature | Details |
|---|---|
| Syntax highlighting | Delegates to the TypeScript grammar (`source.ts`) so all TypeScript tokens are coloured correctly |
| Language configuration | Bracket matching/closing, auto-indent, JSDoc comment continuation, and word-boundary rules tuned for Yog syntax |
| File association | `.yog` files are detected automatically — no per-project configuration needed |

### Installing from source

The extension is not yet published to the VS Code Marketplace. Install it locally as a VSIX:

**1. Package the extension**

```bash
# From the repo root
cd vscode-yog
npm install -g @vscode/vsce   # install the packaging tool once
vsce package                   # produces vscode-yog-0.1.0.vsix
```

**2. Install the VSIX in VS Code**

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:

```
Extensions: Install from VSIX...
```

Select the generated `vscode-yog/vscode-yog-0.1.0.vsix` file. Reload the window when prompted.

Alternatively, from the command line:

```bash
code --install-extension vscode-yog/vscode-yog-0.1.0.vsix
```

### TypeScript IntelliSense for `.yog` files

Because `.yog` files are structurally TypeScript, `tsserver` provides full IntelliSense (completions, go-to-definition, type errors) if you include them in a `tsconfig.json`. Add the following to your project root:

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "types": []
  },
  "include": [
    "src/**/*.ts",
    "src/**/*.yog",
    "yog-core/yog.d.ts"
  ]
}
```

The key points:

- `"include"` must contain the `**/*.yog` glob so `tsserver` indexes `.yog` files.
- `yog-core/yog.d.ts` ships the Yog built-in type declarations (kernel intrinsics, MMIO helpers, pointer types, etc.). Always include it.

### Yog type declarations

Built-in Yog globals and intrinsics are declared in:

```
yog-core/yog.d.ts
```

This file is part of the monorepo. It defines things like `__asm__`, `__mmio_read`, `__mmio_write`, and bare-metal memory primitives. Including it in your `tsconfig.json` (as shown above) makes these available to IntelliSense without any imports.

---

## Neovim / Vim

There is no dedicated Yog plugin yet. Associate `.yog` with TypeScript and the built-in or plugin-provided TypeScript support takes over.

### Neovim with `nvim-lspconfig`

```lua
-- ~/.config/nvim/init.lua  (or wherever your LSP config lives)

-- 1. Teach Neovim that .yog files are TypeScript
vim.filetype.add({
  extension = { yog = "typescript" },
})

-- 2. If you use nvim-lspconfig, ts_ls (tsserver) will pick them up automatically
--    once the filetype is mapped. Make sure your tsconfig.json includes *.yog
--    (see the tsconfig snippet above).
require("lspconfig").ts_ls.setup({})
```

### Classic Vim

Add to your `~/.vimrc`:

```vim
autocmd BufNewFile,BufRead *.yog set filetype=typescript
```

Then install [vim-typescript](https://github.com/leafgarland/typescript-vim) or equivalent for syntax highlighting.

---

## JetBrains IDEs (WebStorm, IntelliJ IDEA)

JetBrains IDEs do not natively associate `.yog` with TypeScript. Register the file type manually:

1. Open **Settings / Preferences** → **Editor** → **File Types**.
2. Select **TypeScript** in the "Recognized File Types" list.
3. Under "File name patterns", click **+** and add `*.yog`.
4. Click **OK** and restart the IDE if prompted.

The TypeScript Language Service will then provide completions, type checking, and navigation for `.yog` files. Point the IDE at your `tsconfig.json` (containing the `*.yog` include glob) for best results.

---

## Zed

Add a file association in your Zed settings (`~/.config/zed/settings.json`):

```json
{
  "file_types": {
    "TypeScript": ["yog"]
  }
}
```

Zed's built-in TypeScript support (via `typescript-language-server`) will then handle `.yog` files. As with other editors, make sure your `tsconfig.json` includes the `**/*.yog` glob.

---

## Helix

Add to `~/.config/helix/languages.toml`:

```toml
[[language]]
name = "typescript"
file-types = ["ts", "tsx", "yog"]
```

---

## Other editors

For any editor with a TextMate grammar system, you can reuse the VS Code extension's grammar directly:

```
vscode-yog/syntaxes/yog.tmLanguage.json
```

The grammar simply delegates to `source.ts`, so it produces identical highlighting to TypeScript. Consult your editor's documentation for how to install a `.tmLanguage.json` file.

For IntelliSense in any LSP-capable editor, point `typescript-language-server` at your project and ensure your `tsconfig.json` includes `**/*.yog`.

---

## QEMU integration

After compiling a Yog kernel image you can launch it in QEMU directly from the terminal. A typical `x86_64` invocation:

```bash
qemu-system-x86_64 \
  -kernel build/kernel.elf \
  -nographic \
  -serial mon:stdio \
  -no-reboot
```

For ARM64 (Raspberry Pi 3 target):

```bash
qemu-system-aarch64 \
  -M raspi3b \
  -kernel build/kernel8.img \
  -serial stdio \
  -no-reboot
```

See [Running in QEMU](/guide/qemu) for the full guide, including how to attach GDB for source-level debugging and how to pipe UART output to a file.
