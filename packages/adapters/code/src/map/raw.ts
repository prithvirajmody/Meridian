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
  /** Reorder-stable discriminator hash of the signature shape (ADR-0028 case 2);
   * '' when the declaration has no signature (class/namespace). */
  readonly sigHash: string;
  /** Eager children: methods of a class, members of a namespace. Functions and
   * methods have **no** eager children (bodies are lazy, ADR-0027). */
  readonly children: readonly RawDecl[];
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
  /** True iff tree-sitter recovered from syntax errors (partial parse). */
  readonly hasErrors: boolean;
  readonly errorCount: number;
  /** Set when the file was not walked (ADR-0027 threshold table); decls is empty. */
  readonly excluded?: 'oversize' | 'generated';
}
