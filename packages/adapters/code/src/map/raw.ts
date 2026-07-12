/**
 * The **graph-shaped, pre-ID** intermediate the mapping walk produces (7C).
 *
 * ADR-0027 draws the eager/lazy line at the function boundary: a declaration's
 * *signature* (name, kind, signature attrs, provenance span) is eager; its
 * *body* is lazy (7F). So a {@link RawDecl} carries everything the signature
 * needs and **never** descends into a function/method body — nested functions
 * are body-internal (ADR-0028 case 3) and are not present here.
 *
 * These types are **structured-clone-safe** (plain data): the walk runs where
 * the tree-sitter tree lives (the worker in production wiring, ADR-0017), and
 * ships this across the boundary — never the parse tree, never a re-walkable
 * flat-tree protocol. Final IDs are derived host-side by {@link buildCodeDocument}
 * through `ctx.ids` (ADR-0002/0028), so IDs are the composition root's, exactly
 * like the markdown adapter.
 */
import type { CodeLanguage } from '../languages.js';

/** The eager declaration kinds this adapter maps (7C). `namespace` is a scope
 * container (ADR-0028's `['ns','Type','member']`); `method` covers class members. */
export type RawDeclKind = 'class' | 'function' | 'method' | 'namespace';

/**
 * How a call-site's callee is written (7E) — this, not any type, is what the
 * ADR-0026 tiers can key on:
 * - `plain`   — `foo(…)`: an identifier. Tier 1 (local decl) / tier 2 (import).
 * - `self`    — `this.m(…)` / `self.m(…)` / `cls.m(…)`: a method on the own
 *               instance. Tier 1 within the enclosing class only.
 * - `member`  — `x.m(…)` on anything else: a call on a value of unknown type.
 *               Always tier 3 (unresolved) — ADR-0026 does not infer types.
 * - `dynamic` — `getFn()()`, `arr[0]()`, `(a||b)()`: callee is not an
 *               identifier. Higher-order / dynamic dispatch → always tier 3.
 */
export type CallReceiver = 'plain' | 'self' | 'member' | 'dynamic';

/** One call-site found by the transient body scan (ADR-0027: bodies are read,
 * never persisted as nodes — a `RawCallSite` is edge/counter input only). */
export interface RawCallSite {
  /** Callee identifier: the whole name for `plain`, the property for
   * `self`/`member`. Absent for `dynamic`. */
  readonly callee?: string;
  readonly receiver: CallReceiver;
  /** `[startIndex, endIndex]` byte span of the whole call expression. */
  readonly span: readonly [number, number];
}

/** One name a single import statement binds into the importing module (7E). */
export interface RawImportBinding {
  /** Local name introduced into the importing module's scope. */
  readonly local: string;
  /** Name as exported by the target: a declaration name, `default`, or the
   * sentinel `*` (a namespace/`import *`/`from x import *` — never a single
   * callable decl). */
  readonly imported: string;
}

/**
 * One import statement, language-normalized for host-side resolution (7E,
 * ADR-0026). Path resolution — never type resolution — happens host-side in
 * `resolveImports`, which is why only the *written* specifier and bindings
 * live here.
 */
export interface RawImport {
  /** Module reference as written. TypeScript: the string-literal specifier
   * (`'./x'`, `'react'`). Python: the module path including any leading dots —
   * `'.'`, `'.mod'`, `'..pkg.sub'`, or a dotted absolute `'a.b'`. */
  readonly specifier: string;
  /** `[startIndex, endIndex]` byte span of the import statement (provenance). */
  readonly span: readonly [number, number];
  /** Named/default/namespace bindings introduced (empty for a side-effect or
   * bare re-export import — which still contributes a `code:imports` edge). */
  readonly bindings: readonly RawImportBinding[];
  /** Python `from <spec> import a, b` — each imported name may name a
   * *submodule* of `<spec>` when `<spec>` resolves to a package (resolved
   * host-side). False for TypeScript and for Python `import a.b`. */
  readonly fromImport: boolean;
}

/** Signature attributes captured on a declaration (ADR-0027 "signature attrs"). */
export interface RawSignature {
  /** Parameter arity (count of formal parameters). */
  readonly params: number;
  /** Normalized parameter list as written, e.g. `(a: string, b?: number)`. */
  readonly signature: string;
  /** Each parameter's type annotation as-written (normalized), or '' if untyped.
   * The overload-hash input (ADR-0028 case 2): types, not parameter names. */
  readonly paramTypeList: readonly string[];
  /** Normalized return-type annotation as written (without a leading `:`), or ''. */
  readonly returns: string;
  readonly async: boolean;
  readonly generator: boolean;
  readonly static: boolean;
  readonly abstract: boolean;
  /** 'public' | 'private' | 'protected' for class members that declare it (TS). */
  readonly accessibility?: 'public' | 'private' | 'protected';
  /** Python `@classmethod` (7D). Descriptive, **not** an overload-hash input. */
  readonly classmethod?: boolean;
  /** Python `@property`/`@x.setter`/`@x.getter`/`@x.deleter` (7D). Descriptive,
   * **not** an overload-hash input. */
  readonly property?: boolean;
}

/** One eager declaration node, before ID derivation and discriminator assignment. */
export interface RawDecl {
  readonly kind: RawDeclKind;
  /** The declaration's own name — the *base* of its scope segment. `'default'`
   * only for a truly anonymous `export default` (ADR-0028 case 1). */
  readonly name: string;
  /** `[startIndex, endIndex]` byte span of the whole declaration (provenance). */
  readonly span: readonly [number, number];
  /** Whether the declaration is `export`ed from its module. */
  readonly exported: boolean;
  /** Whether it is the module's `export default`. */
  readonly defaultExport: boolean;
  /** True for an `abstract class` (class-level; method-level lives on the signature). */
  readonly abstract?: boolean;
  /** Decorator expressions as written (normalized, source order); Python only (7D).
   * Descriptive provenance — **not** an ID/overload-hash input. */
  readonly decorators?: readonly string[];
  /** True when a Python declaration carries `@overload` (typing.overload) (7D):
   * an honest flag on a signature stub, distinct IDs still come from `sigHash`. */
  readonly overload?: boolean;
  /** Present for `function`/`method`; absent for `class`/`namespace`. */
  readonly signature?: RawSignature;
  /** `[startIndex, endIndex]` byte span of the function/method **body** (7F,
   * ADR-0027): the `statement_block`/`block` (or a concise arrow's expression /
   * a `lambda`'s expression). Present iff the declaration has a materializable
   * body — **absent** for an abstract method, an overload/declaration stub, or
   * a `function_signature`. It is the `code:body-span` eager attr that the
   * `DetailResolver.canResolve` predicate keys on (a cold declaration with a
   * body is drill-in-able; one without a body is not). */
  readonly bodySpan?: readonly [number, number];
  /** Reorder-stable discriminator hash of the signature shape (ADR-0028 case 2);
   * '' when the declaration has no signature (class/namespace). */
  readonly sigHash: string;
  /** Eager children: methods of a class, members of a namespace. Functions and
   * methods have **no** eager children (bodies are lazy, ADR-0027). */
  readonly children: readonly RawDecl[];
  /** Call-sites found by the transient body scan (7E) — present for
   * `function`/`method`, absent for `class`/`namespace` (they have members,
   * not a body). Innermost-enclosing attribution: calls inside a nested
   * closure belong to that closure (a lazy 7F node), not to this decl. */
  readonly calls?: readonly RawCallSite[];
}

/** One source file mapped to its module skeleton (top-level declarations only). */
export interface RawModule {
  /** Repository-relative POSIX file path — the ADR-0028 `source` coordinate. */
  readonly source: string;
  readonly language: CodeLanguage;
  /** Display label (the file's basename). */
  readonly label: string;
  /** `[0, byteLength]` span of the whole file. */
  readonly span: readonly [number, number];
  readonly decls: readonly RawDecl[];
  /** Top-level import statements (7E), in source order — the import table
   * `resolveImports` resolves lexically against the ingested file set. */
  readonly imports: readonly RawImport[];
  /** True iff tree-sitter recovered from syntax errors (partial parse). */
  readonly hasErrors: boolean;
  readonly errorCount: number;
  /** Set when the file was not walked (ADR-0027 threshold table); decls is empty. */
  readonly excluded?: 'oversize' | 'generated';
}
