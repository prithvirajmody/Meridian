/**
 * Signature extraction and the reorder-stable overload discriminator (ADR-0028
 * case 2). The discriminator is a short hash of the **signature shape** —
 * parameter arity + parameter type annotations as-written + `async`/`static`/
 * generator/`abstract` markers + return type — **text-normalized**, so
 * reformatting a signature does not change it (whitespace-invariance, the
 * ADR-0028 flagship's foundation) but changing a parameter or return type does
 * (a genuinely different overload).
 *
 * Pure over the tree-sitter tree; imports only web-tree-sitter *types* (erased
 * at compile time), so this module loads no grammar and no WASM — the
 * "grammars only in workers" gate is about the shim, not these type imports.
 */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { RawSignature } from './raw.js';

/** Collapse all whitespace runs to a single space and trim (text-normalize). */
export function normalizeWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Deterministic 32-bit FNV-1a of a string → 8 lowercase hex chars. Used only
 * as a *scope-local* discriminator segment (then fed through `ctx.ids`'
 * SHA-256 coordinate hash), so collision pressure is tiny (overloads of one
 * name in one scope) and the tie-break `~n` (ADR-0028 case 4) handles the rest.
 */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Field `name`'s text, or a fallback (anonymous). */
export function nameOf(node: SyntaxNode): string | undefined {
  const name = node.childForFieldName('name');
  return name === null ? undefined : name.text;
}

/** True when an unnamed token of the given text is a direct child (a modifier). */
export function hasTokenChild(node: SyntaxNode, text: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child !== null && !child.isNamed && child.text === text) return true;
  }
  return false;
}

function accessibilityOf(node: SyntaxNode): RawSignature['accessibility'] {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child !== null && child.type === 'accessibility_modifier') {
      const t = child.text;
      if (t === 'public' || t === 'private' || t === 'protected') return t;
    }
  }
  return undefined;
}

/** Text of a `type_annotation` node without its leading `:` (normalized). */
function annotationText(annotation: SyntaxNode | null): string {
  if (annotation === null) return '';
  // A `type_annotation` is `: T`; take the inner type so `:string` and
  // `: string` normalize identically (whitespace-invariance, ADR-0028).
  const inner = annotation.namedChild(0);
  return normalizeWs((inner ?? annotation).text);
}

/** Ordered list of each formal parameter's type (or '' if untyped). */
function paramTypes(formalParams: SyntaxNode | null): string[] {
  if (formalParams === null) return [];
  const types: string[] = [];
  for (let i = 0; i < formalParams.namedChildCount; i++) {
    const param = formalParams.namedChild(i);
    if (param === null) continue;
    types.push(annotationText(param.childForFieldName('type')));
  }
  return types;
}

/** Return-type annotation text without the leading `:` (normalized), or ''. */
function returnType(node: SyntaxNode): string {
  return annotationText(node.childForFieldName('return_type'));
}

/**
 * Extract signature attributes from a function/method-like declaration node.
 * `generatorByType` is true when the node type itself denotes a generator
 * (`generator_function_declaration`), since those carry no `*` token modifier
 * position we scan for on methods.
 */
export function extractSignature(node: SyntaxNode, generatorByType = false): RawSignature {
  const formalParams = node.childForFieldName('parameters');
  const params = formalParams === null ? 0 : formalParams.namedChildCount;
  const signature = formalParams === null ? '()' : normalizeWs(formalParams.text);
  const accessibility = accessibilityOf(node);
  return {
    params,
    signature,
    paramTypeList: paramTypes(formalParams),
    returns: returnType(node),
    async: hasTokenChild(node, 'async'),
    generator: generatorByType || hasTokenChild(node, '*'),
    static: hasTokenChild(node, 'static'),
    abstract: hasTokenChild(node, 'abstract'),
    ...(accessibility !== undefined ? { accessibility } : {}),
  };
}

/**
 * The overload discriminator hash (ADR-0028 case 2): a pure function of the
 * signature *shape*, resolving open question 1 by including the return type (so
 * return-type-only TS overloads get distinct IDs). Param *names* are excluded —
 * only arity, param types, modifiers, and return type. Empty string for a
 * declaration with no signature (class/namespace).
 */
export function signatureHash(sig: RawSignature | undefined): string {
  if (sig === undefined) return '';
  const shape = [
    sig.async ? 'async' : '',
    sig.static ? 'static' : '',
    sig.generator ? 'gen' : '',
    sig.abstract ? 'abstract' : '',
    `arity=${sig.params}`,
    `params=${sig.paramTypeList.join(',')}`,
    `returns=${sig.returns}`,
  ].join('|');
  return fnv1a(shape);
}

export { paramTypes };
