'use strict';

/**
 * compiler.js — Backend-agnostic TypeScript AST walker.
 *
 * The Compiler class traverses the TypeScript AST produced by the TypeScript
 * compiler API and delegates all code generation to the active backend.
 *
 * Supported Yog constructs (Phase 1):
 *   - function declarations
 *   - Intrinsic call expressions (delegated to backend.intrinsics)
 *
 * Unsupported constructs emit a warning and are skipped rather than throwing,
 * so the compiler remains usable as partial support is added.
 */

const ts = require('typescript');
const { Emitter } = require('./emitter');

class Compiler {
  /**
   * @param {string} inputPath — source file path (used for error messages and TS parser)
   * @param {string} source    — raw source text
   * @param {object} backend   — backend module (arm64.js or xtensa.js)
   */
  constructor(inputPath, source, backend) {
    this.inputPath = inputPath;
    this.backend   = backend;

    // Create the emitter: backends that need specialised emitters (e.g. XtensaEmitter)
    // export createEmitter(); otherwise fall back to the generic Emitter with the right wordSize.
    if (typeof backend.createEmitter === 'function') {
      this.e = backend.createEmitter();
    } else {
      this.e = new Emitter(backend.wordSize);
    }

    // Parse with TypeScript compiler API.  setParentNodes=true is needed so
    // parent references are available (some AST helpers require them).
    try {
      this.ast = ts.createSourceFile(
        inputPath,
        source,
        ts.ScriptTarget.ESNext,
        /* setParentNodes */ true,
        ts.ScriptKind.TS
      );
    } catch (err) {
      throw new Error(`[yogc] Parse error in "${inputPath}": ${err.message}`);
    }
  }

  /**
   * Walk the AST, emit code via the backend, and return the serialised binary.
   * @returns {Buffer}
   */
  compile() {
    // Emit architecture-specific prologue (boot stub, etc.)
    this.backend.emitProgramPrologue(this.e);

    // Walk top-level declarations
    ts.forEachChild(this.ast, (node) => {
      if (node.kind === ts.SyntaxKind.FunctionDeclaration) {
        this.compileFunction(node);
      }
      // Other top-level forms (variable declarations, class declarations, etc.)
      // are not yet supported; they are silently ignored at this level.
    });

    // Resolve patches and serialise
    return this.backend.resolveAndSerialize(this.e);
  }

  // ── Function Declarations ──────────────────────────────────────────────────

  compileFunction(fn) {
    const name = fn.name
      ? (fn.name.text || fn.name.escapedText)
      : '<anonymous>';

    this.backend.emitFunction(this.e, name, () => {
      if (fn.body && fn.body.statements) {
        for (const stmt of fn.body.statements) {
          this.compileStatement(stmt);
        }
      }
    });
  }

  // ── Statements ─────────────────────────────────────────────────────────────

  compileStatement(stmt) {
    switch (stmt.kind) {
      case ts.SyntaxKind.ExpressionStatement:
        this.compileExpr(stmt.expression);
        break;

      default: {
        const kindName = ts.SyntaxKind[stmt.kind] || String(stmt.kind);
        console.warn(`[yogc] Warning: unsupported statement kind "${kindName}" — skipped`);
      }
    }
  }

  // ── Expressions ────────────────────────────────────────────────────────────

  compileExpr(expr) {
    if (expr.kind !== ts.SyntaxKind.CallExpression) {
      const kindName = ts.SyntaxKind[expr.kind] || String(expr.kind);
      console.warn(`[yogc] Warning: non-call expression "${kindName}" ignored`);
      return;
    }
    this.compileCall(expr);
  }

  // ── Call Expressions (intrinsic dispatch) ──────────────────────────────────

  compileCall(expr) {
    const callee = expr.expression;
    const args   = expr.arguments;

    // Resolve the intrinsic key from the callee node
    const intrinsicKey = this._intrinsicKey(callee);
    if (!intrinsicKey) {
      console.warn(`[yogc] Warning: unresolvable callee "${this._calleeDesc(callee)}" — skipped`);
      return;
    }

    const handler = this.backend.intrinsics[intrinsicKey];
    if (!handler) {
      console.warn(`[yogc] Warning: unknown intrinsic "${intrinsicKey}" for target "${this.backend.name}" — skipped`);
      return;
    }

    // Resolve argument values (string and numeric literals only, for Phase 1)
    const resolvedArgs = args.map((a, i) => {
      if (a.kind === ts.SyntaxKind.StringLiteral) {
        return a.text;
      }
      if (a.kind === ts.SyntaxKind.NumericLiteral) {
        return Number(a.text);
      }
      const kindName = ts.SyntaxKind[a.kind] || String(a.kind);
      console.warn(`[yogc] Warning: unsupported argument type "${kindName}" at position ${i} in "${intrinsicKey}" — passing null`);
      return null;
    });

    handler(this.e, ...resolvedArgs);
  }

  // ── AST Helpers ────────────────────────────────────────────────────────────

  /**
   * Derive the intrinsic dispatch key from a callee node:
   *   Identifier            → "uart_init"
   *   PropertyAccessExpr    → "Memory.write32"
   * Returns null if the callee form is not supported.
   */
  _intrinsicKey(callee) {
    if (callee.kind === ts.SyntaxKind.Identifier) {
      return callee.text || callee.escapedText || null;
    }
    if (callee.kind === ts.SyntaxKind.PropertyAccessExpression) {
      const obj  = callee.expression.text || callee.expression.escapedText || null;
      const prop = callee.name.text        || callee.name.escapedText        || null;
      if (obj && prop) return `${obj}.${prop}`;
    }
    return null;
  }

  /**
   * Human-readable callee description for warning messages.
   */
  _calleeDesc(callee) {
    if (callee.kind === ts.SyntaxKind.Identifier) {
      return callee.text || callee.escapedText || '<identifier>';
    }
    if (callee.kind === ts.SyntaxKind.PropertyAccessExpression) {
      const obj  = callee.expression.text || callee.expression.escapedText || '?';
      const prop = callee.name.text        || callee.name.escapedText        || '?';
      return `${obj}.${prop}`;
    }
    return ts.SyntaxKind[callee.kind] || String(callee.kind);
  }
}

module.exports = { Compiler };
