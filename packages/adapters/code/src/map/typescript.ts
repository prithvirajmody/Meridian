/**
 * TypeScript → module skeleton (7C). Maps **eager levels only** (ADR-0027):
 * module → class/function/method **signatures**, plus `namespace` scope
 * containers. The walk descends into class and namespace bodies (their members
 * are eager) but **never** into a function/method `statement_block` — nested
 * functions are body-internal (ADR-0028 case 3), materialized lazily in 7F.
 *
 * Pure over the tree-sitter tree; imports web-tree-sitter *types* only. IDs are
 * not derived here — {@link buildCodeDocument} assigns coordinates and
 * discriminators host-side through `ctx.ids`.
 */
import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import { summarizeTree } from '../parse.js';
import type { RawCallSite, RawDecl, RawImport, RawImportBinding, RawModule, RawSignature } from './raw.js';
import { collectCalls, type CallGrammar } from './scan.js';
import { extractSignature, nameOf, signatureHash } from './signature.js';

/** Nodes that open a new function/class scope (their calls are not the
 * enclosing decl's — ADR-0027 innermost-enclosing attribution). */
const TS_SCOPES = new Set([
  'arrow_function',
  'function_expression',
  'function_declaration',
  'generator_function',
  'generator_function_declaration',
  'function_signature',
  'method_definition',
  'class',
  'class_declaration',
  'abstract_class_declaration',
]);

/** The TypeScript call grammar for the transient body scan (7E). */
const TS_CALLS: CallGrammar = {
  isFunctionScope: (n) => TS_SCOPES.has(n.type),
  isCall: (n) => n.type === 'call_expression',
  classify: (call): RawCallSite => {
    const span: [number, number] = [call.startIndex, call.endIndex];
    const fn = call.childForFieldName('function');
    if (fn === null) return { receiver: 'dynamic', span };
    if (fn.type === 'identifier') return { callee: fn.text, receiver: 'plain', span };
    if (fn.type === 'member_expression') {
      const object = fn.childForFieldName('object');
      const property = fn.childForFieldName('property');
      if (property === null) return { receiver: 'dynamic', span };
      const receiver = object !== null && object.type === 'this' ? 'self' : 'member';
      return { callee: property.text, receiver, span };
    }
    return { receiver: 'dynamic', span };
  },
};

/** Scan a function/method node's body for call-sites (its `body` field, which
 * may be a `statement_block` or an arrow's concise expression body). */
function callsOf(node: SyntaxNode): RawCallSite[] {
  return collectCalls(node.childForFieldName('body'), TS_CALLS);
}

/** Declaration node types that carry an eager signature/scope. */
const MAPPABLE = new Set([
  'function_declaration',
  'function_signature',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'class',
  'function_expression',
  'arrow_function',
  'lexical_declaration',
  'variable_declaration',
  'internal_module',
]);

function isFunctionValue(node: SyntaxNode | null): boolean {
  return node !== null && (node.type === 'arrow_function' || node.type === 'function_expression');
}

function makeFunction(
  node: SyntaxNode,
  name: string,
  span: readonly [number, number],
  exported: boolean,
  defaultExport: boolean,
  generatorByType = false,
): RawDecl {
  const signature = extractSignature(node, generatorByType);
  return {
    kind: 'function',
    name,
    span,
    exported,
    defaultExport,
    signature,
    sigHash: signatureHash(signature),
    children: [],
    calls: callsOf(node),
  };
}

/** Map a namespace/class body's statements/members into eager child decls. */
function mapMembers(body: SyntaxNode | null, classBody: boolean): RawDecl[] {
  if (body === null) return [];
  const out: RawDecl[] = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const member = body.namedChild(i);
    if (member === null) continue;
    if (classBody) out.push(...mapClassMember(member));
    else out.push(...mapStatement(member));
  }
  return out;
}

/** A class member → 0..1 method decls (constructors, accessors, arrow fields). */
function mapClassMember(member: SyntaxNode): RawDecl[] {
  if (member.type === 'method_definition' || member.type === 'abstract_method_signature') {
    const name = nameOf(member);
    if (name === undefined) return [];
    const signature = extractSignature(member);
    return [
      {
        kind: 'method',
        name,
        span: [member.startIndex, member.endIndex],
        exported: false,
        defaultExport: false,
        signature,
        sigHash: signatureHash(signature),
        children: [],
        calls: callsOf(member),
      },
    ];
  }
  if (member.type === 'public_field_definition') {
    const value = member.childForFieldName('value');
    const name = nameOf(member);
    if (name === undefined || !isFunctionValue(value)) return [];
    // Params/return/async/generator come from the arrow; static/accessibility
    // are the *field's* modifiers, so merge the two sources.
    const fromValue = extractSignature(value!);
    const fromField = extractSignature(member);
    const signature: RawSignature = {
      ...fromValue,
      static: fromField.static,
      abstract: fromField.abstract,
      ...(fromField.accessibility !== undefined ? { accessibility: fromField.accessibility } : {}),
    };
    return [
      {
        kind: 'method',
        name,
        span: [member.startIndex, member.endIndex],
        exported: false,
        defaultExport: false,
        signature,
        sigHash: signatureHash(signature),
        children: [],
        // The body lives on the arrow value, not the field wrapper.
        calls: callsOf(value!),
      },
    ];
  }
  return [];
}

/** Map one top-level (or namespace-level) statement into eager decls. */
function mapStatement(stmt: SyntaxNode): RawDecl[] {
  // `namespace X {}` surfaces as `expression_statement > internal_module`.
  if (stmt.type === 'expression_statement') {
    const inner = stmt.namedChild(0);
    return inner !== null && inner.type === 'internal_module' ? mapDecl(inner, false, false) : [];
  }
  if (stmt.type === 'export_statement') {
    const isDefault = childToken(stmt, 'default');
    for (let i = 0; i < stmt.namedChildCount; i++) {
      const child = stmt.namedChild(i);
      if (child !== null && MAPPABLE.has(child.type)) return mapDecl(child, true, isDefault);
    }
    return [];
  }
  return MAPPABLE.has(stmt.type) ? mapDecl(stmt, false, false) : [];
}

function childToken(node: SyntaxNode, text: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c !== null && !c.isNamed && c.text === text) return true;
  }
  return false;
}

/** Map a resolved declaration node (already unwrapped from any export). */
function mapDecl(node: SyntaxNode, exported: boolean, defaultExport: boolean): RawDecl[] {
  const span: [number, number] = [node.startIndex, node.endIndex];
  switch (node.type) {
    case 'function_declaration':
    case 'function_signature': {
      const name = nameOf(node) ?? (defaultExport ? 'default' : undefined);
      return name === undefined ? [] : [makeFunction(node, name, span, exported, defaultExport)];
    }
    case 'generator_function_declaration': {
      const name = nameOf(node) ?? (defaultExport ? 'default' : undefined);
      return name === undefined ? [] : [makeFunction(node, name, span, exported, defaultExport, true)];
    }
    case 'function_expression':
    case 'arrow_function': {
      // Only reachable at declaration position as an anonymous `export default`.
      return defaultExport ? [makeFunction(node, 'default', span, exported, true)] : [];
    }
    case 'class_declaration':
    case 'abstract_class_declaration':
    case 'class': {
      const name = nameOf(node) ?? (defaultExport ? 'default' : undefined);
      if (name === undefined) return [];
      return [
        {
          kind: 'class',
          name,
          span,
          exported,
          defaultExport,
          ...(node.type === 'abstract_class_declaration' ? { abstract: true } : {}),
          sigHash: '',
          children: mapMembers(node.childForFieldName('body'), true),
        },
      ];
    }
    case 'internal_module': {
      const name = nameOf(node);
      if (name === undefined) return [];
      return [
        {
          kind: 'namespace',
          name,
          span,
          exported,
          defaultExport,
          sigHash: '',
          children: mapMembers(node.childForFieldName('body'), false),
        },
      ];
    }
    case 'lexical_declaration':
    case 'variable_declaration': {
      const out: RawDecl[] = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        const declr = node.namedChild(i);
        if (declr === null || declr.type !== 'variable_declarator') continue;
        const value = declr.childForFieldName('value');
        const name = nameOf(declr);
        if (name === undefined || !isFunctionValue(value)) continue;
        out.push(makeFunction(value!, name, [declr.startIndex, declr.endIndex], exported, false));
      }
      return out;
    }
    default:
      return [];
  }
}

/** The literal text of a `source` string node, without its surrounding quotes. */
function specifierText(source: SyntaxNode): string {
  const text = source.text;
  if (text.length >= 2) {
    const q = text[0];
    if ((q === "'" || q === '"' || q === '`') && text[text.length - 1] === q) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/** Bindings of an `import_clause` (default / `* as ns` / `{ a, b as c }`). */
function importClauseBindings(clause: SyntaxNode): RawImportBinding[] {
  const bindings: RawImportBinding[] = [];
  for (let i = 0; i < clause.namedChildCount; i++) {
    const child = clause.namedChild(i);
    if (child === null) continue;
    if (child.type === 'identifier') {
      bindings.push({ local: child.text, imported: 'default' });
    } else if (child.type === 'namespace_import') {
      const name = nameOf(child) ?? child.namedChild(0)?.text;
      if (name !== undefined) bindings.push({ local: name, imported: '*' });
    } else if (child.type === 'named_imports') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const spec = child.namedChild(j);
        if (spec === null || spec.type !== 'import_specifier') continue;
        const imported = spec.childForFieldName('name')?.text;
        if (imported === undefined) continue;
        const alias = spec.childForFieldName('alias')?.text;
        bindings.push({ local: alias ?? imported, imported });
      }
    }
  }
  return bindings;
}

/** Top-level `import`/`export … from` statements → the module's import table. */
function extractImports(root: SyntaxNode): RawImport[] {
  const imports: RawImport[] = [];
  for (let i = 0; i < root.namedChildCount; i++) {
    const stmt = root.namedChild(i);
    if (stmt === null) continue;
    // A re-export (`export { x } from './y'`, `export * from './y'`) is a
    // module dependency (ADR-0028 case 6) but binds no local callable name.
    if (stmt.type !== 'import_statement' && stmt.type !== 'export_statement') continue;
    const source = stmt.childForFieldName('source');
    if (source === null || source.type !== 'string') continue;
    const clause =
      stmt.type === 'import_statement'
        ? Array.from({ length: stmt.namedChildCount }, (_, j) => stmt.namedChild(j)).find(
            (c) => c !== null && c.type === 'import_clause',
          )
        : undefined;
    imports.push({
      specifier: specifierText(source),
      span: [stmt.startIndex, stmt.endIndex],
      bindings: clause != null ? importClauseBindings(clause) : [],
      fromImport: false,
    });
  }
  return imports;
}

/**
 * Map a parsed TypeScript file into its {@link RawModule} skeleton. `source` is
 * the repository-relative POSIX path (the ADR-0028 `source` coordinate) and
 * `label` the display name (basename).
 */
export function mapTypeScriptModule(
  tree: Tree,
  opts: { readonly source: string; readonly label: string },
): RawModule {
  const outcome = summarizeTree(tree, 'typescript');
  const root = tree.rootNode;
  const decls: RawDecl[] = [];
  for (let i = 0; i < root.namedChildCount; i++) {
    const stmt = root.namedChild(i);
    if (stmt !== null) decls.push(...mapStatement(stmt));
  }
  return {
    source: opts.source,
    language: 'typescript',
    label: opts.label,
    span: [0, root.endIndex],
    decls,
    imports: extractImports(root),
    hasErrors: outcome.hasErrors,
    errorCount: outcome.errorCount,
  };
}
