/**
 * Python → module skeleton (7D). Maps **eager levels only** (ADR-0027):
 * module → class → function/method **signatures**. The walk descends into
 * `class_definition` bodies (their methods and nested classes are eager) but
 * **never** into a `function_definition` body (`block`) — nested functions are
 * body-internal (ADR-0028 case 3), materialized lazily in 7F, exactly as the TS
 * walk treats them.
 *
 * The same {@link RawModule}/{@link RawDecl} structures the TypeScript walk
 * produces, so {@link buildCodeDocument} (ADR-0002/0028 IDs), {@link
 * assignSegments} (the overload/duplicate discriminators), and {@link
 * signatureHash} are shared unchanged. Signature *extraction* is grammar-shaped,
 * so it is Python-specific here; only the language-agnostic helpers
 * ({@link nameOf}, {@link normalizeWs}, {@link hasTokenChild}, {@link
 * signatureHash}) are reused (SUBPHASES §7D: factor only where it repeats).
 *
 * Python-specific readings (see the 7D report's deviations):
 * - **No `export`/`default`.** Python has no export syntax; every declaration is
 *   `exported: false`, `defaultExport: false`.
 * - **Generators are undetectable at the signature level** (a generator is a
 *   `yield` in the *body*, which is lazy) → `generator` is always `false`.
 * - **`@overload`** stubs get the same `#signatureHash` discriminator as TS
 *   overloads; the Python hash inputs are param arity + param type annotations
 *   as-written + `async`/`static`/`abstract` markers + return annotation
 *   (generator excluded per above; param names excluded), matching ADR-0028
 *   case 2 adapted to Python annotations.
 * - **`@staticmethod`/`@classmethod`/`@property`** stay `code:method` (kind), and
 *   are recorded as signature flags/attrs (`static`, `classmethod`, `property`).
 *   Only `static`/`abstract` feed the hash.
 *
 * Pure over the tree-sitter tree; imports web-tree-sitter *types* only.
 */
import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import { summarizeTree } from '../parse.js';
import type { RawCallSite, RawDecl, RawImport, RawImportBinding, RawModule, RawSignature } from './raw.js';
import { collectCalls, type CallGrammar } from './scan.js';
import { hasTokenChild, nameOf, normalizeWs, signatureHash } from './signature.js';

/** Nodes that open a new function/class scope (their calls are not the
 * enclosing decl's — ADR-0027 innermost-enclosing attribution). */
const PY_SCOPES = new Set(['function_definition', 'lambda', 'class_definition']);

/** The Python call grammar for the transient body scan (7E). `self`/`cls`
 * receivers are the tier-1 own-class case; every other attribute call is a
 * call on a value of unknown type → tier 3 (ADR-0026 does not infer types). */
const PY_CALLS: CallGrammar = {
  isFunctionScope: (n) => PY_SCOPES.has(n.type),
  isCall: (n) => n.type === 'call',
  classify: (call): RawCallSite => {
    const span: [number, number] = [call.startIndex, call.endIndex];
    const fn = call.childForFieldName('function');
    if (fn === null) return { receiver: 'dynamic', span };
    if (fn.type === 'identifier') return { callee: fn.text, receiver: 'plain', span };
    if (fn.type === 'attribute') {
      const object = fn.childForFieldName('object');
      const attribute = fn.childForFieldName('attribute');
      if (attribute === null) return { receiver: 'dynamic', span };
      const isSelf =
        object !== null && object.type === 'identifier' && (object.text === 'self' || object.text === 'cls');
      return { callee: attribute.text, receiver: isSelf ? 'self' : 'member', span };
    }
    return { receiver: 'dynamic', span };
  },
};

/** Scan a `function_definition` / `lambda` body for call-sites (7E). */
function callsOf(node: SyntaxNode): RawCallSite[] {
  return collectCalls(node.childForFieldName('body'), PY_CALLS);
}

/** The declaration kind for members of a scope: module/nested-in-class. */
type MemberKind = 'function' | 'method';

/** Normalized text of a decorator's expression (the part after `@`). */
function decoratorName(decorator: SyntaxNode): string {
  const expr = decorator.namedChild(0);
  return expr === null ? '' : normalizeWs(expr.text);
}

/** Classify a Python decorator into the flags it implies. */
interface DecoratorFlags {
  readonly staticmethod: boolean;
  readonly classmethod: boolean;
  readonly property: boolean;
  readonly abstract: boolean;
  readonly overload: boolean;
}

function classifyDecorators(names: readonly string[]): DecoratorFlags {
  const has = (pred: (n: string) => boolean): boolean => names.some(pred);
  // A decorator may be dotted (`abc.abstractmethod`, `typing.overload`,
  // `foo.setter`); match on the final dotted segment so aliasing the import
  // does not defeat recognition of the stdlib shapes.
  const tail = (n: string): string => {
    const dot = n.lastIndexOf('.');
    return dot === -1 ? n : n.slice(dot + 1);
  };
  return {
    staticmethod: has((n) => tail(n) === 'staticmethod'),
    classmethod: has((n) => tail(n) === 'classmethod'),
    // `@property`, and `@x.setter`/`@x.getter`/`@x.deleter` descriptor forms.
    property: has((n) => tail(n) === 'property' || /\.(setter|getter|deleter)$/.test(n)),
    abstract: has((n) => tail(n) === 'abstractmethod' || tail(n) === 'abstractproperty'),
    overload: has((n) => tail(n) === 'overload'),
  };
}

/** Each formal parameter's type annotation as-written (normalized), '' if none. */
function paramTypes(params: SyntaxNode | null): string[] {
  if (params === null) return [];
  const types: string[] = [];
  for (let i = 0; i < params.namedChildCount; i++) {
    const param = params.namedChild(i);
    if (param === null) continue;
    const typeNode = param.childForFieldName('type');
    types.push(typeNode === null ? '' : normalizeWs(typeNode.text));
  }
  return types;
}

/** Extract signature attributes from a `function_definition` node. `decorators`
 * are already classified into the flags they contribute. */
function extractPySignature(fn: SyntaxNode, flags: DecoratorFlags): RawSignature {
  const params = fn.childForFieldName('parameters');
  const returnType = fn.childForFieldName('return_type');
  const sig: RawSignature = {
    params: params === null ? 0 : params.namedChildCount,
    signature: params === null ? '()' : normalizeWs(params.text),
    paramTypeList: paramTypes(params),
    returns: returnType === null ? '' : normalizeWs(returnType.text),
    async: hasTokenChild(fn, 'async'),
    generator: false, // undetectable without the (lazy) body; see file header.
    static: flags.staticmethod,
    abstract: flags.abstract,
    ...(flags.classmethod ? { classmethod: true } : {}),
    ...(flags.property ? { property: true } : {}),
  };
  return sig;
}

/** A `lambda`'s signature, for a module-/class-level `name = lambda …` binding. */
function extractLambdaSignature(lambda: SyntaxNode): RawSignature {
  const params = lambda.childForFieldName('parameters');
  const inner = params === null ? '' : normalizeWs(params.text);
  return {
    params: params === null ? 0 : params.namedChildCount,
    signature: `(${inner})`,
    paramTypeList: paramTypes(params),
    returns: '',
    async: false,
    generator: false,
    static: false,
    abstract: false,
  };
}

/** Build a function/method decl from a `function_definition` and its decorators. */
function makeFunction(fn: SyntaxNode, memberKind: MemberKind, decorators: readonly SyntaxNode[]): RawDecl[] {
  const name = nameOf(fn);
  if (name === undefined) return [];
  const names = decorators.map(decoratorName);
  const flags = classifyDecorators(names);
  const signature = extractPySignature(fn, flags);
  return [
    {
      kind: memberKind,
      name,
      span: [fn.startIndex, fn.endIndex],
      exported: false,
      defaultExport: false,
      ...(names.length > 0 ? { decorators: names } : {}),
      ...(flags.overload ? { overload: true } : {}),
      signature,
      sigHash: signatureHash(signature),
      children: [],
      calls: callsOf(fn),
    },
  ];
}

/** Build a class decl (and recurse into its body — members are eager). */
function makeClass(cls: SyntaxNode, decorators: readonly SyntaxNode[]): RawDecl[] {
  const name = nameOf(cls);
  if (name === undefined) return [];
  const names = decorators.map(decoratorName);
  return [
    {
      kind: 'class',
      name,
      span: [cls.startIndex, cls.endIndex],
      exported: false,
      defaultExport: false,
      ...(names.length > 0 ? { decorators: names } : {}),
      sigHash: '',
      children: mapBody(cls.childForFieldName('body'), 'method'),
    },
  ];
}

/** A module-/class-level `name = lambda …` → a binding-named function (ADR-0028
 * case 1). Non-lambda assignments are not in the eager level chain. */
function mapAssignment(assignment: SyntaxNode, memberKind: MemberKind): RawDecl[] {
  const left = assignment.childForFieldName('left');
  const right = assignment.childForFieldName('right');
  if (left === null || right === null || left.type !== 'identifier' || right.type !== 'lambda') {
    return [];
  }
  const signature = extractLambdaSignature(right);
  return [
    {
      kind: memberKind,
      name: left.text,
      span: [assignment.startIndex, assignment.endIndex],
      exported: false,
      defaultExport: false,
      signature,
      sigHash: signatureHash(signature),
      children: [],
      // The body is the lambda's expression, scanned for its own calls.
      calls: callsOf(right),
    },
  ];
}

/** Map one statement in a module or class body into eager decls. */
function mapStatement(stmt: SyntaxNode, memberKind: MemberKind): RawDecl[] {
  switch (stmt.type) {
    case 'function_definition':
      return makeFunction(stmt, memberKind, []);
    case 'class_definition':
      return makeClass(stmt, []);
    case 'decorated_definition': {
      const decorators: SyntaxNode[] = [];
      for (let i = 0; i < stmt.namedChildCount; i++) {
        const child = stmt.namedChild(i);
        if (child !== null && child.type === 'decorator') decorators.push(child);
      }
      const def = stmt.childForFieldName('definition');
      if (def === null) return [];
      if (def.type === 'function_definition') return makeFunction(def, memberKind, decorators);
      if (def.type === 'class_definition') return makeClass(def, decorators);
      return [];
    }
    case 'expression_statement': {
      const inner = stmt.namedChild(0);
      return inner !== null && inner.type === 'assignment' ? mapAssignment(inner, memberKind) : [];
    }
    default:
      // Imports, control-flow, plain assignments, docstrings: not eager. We do
      // not descend into top-level `if`/`try` blocks (mirrors the TS walk).
      return [];
  }
}

/** Map a module or class body (`block` or `module`) into eager child decls. */
function mapBody(body: SyntaxNode | null, memberKind: MemberKind): RawDecl[] {
  if (body === null) return [];
  const out: RawDecl[] = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (child !== null) out.push(...mapStatement(child, memberKind));
  }
  return out;
}

/** One imported name in a `from … import …` (name / `name as alias` / `*`). */
function fromBinding(node: SyntaxNode): RawImportBinding | undefined {
  if (node.type === 'wildcard_import') return { local: '*', imported: '*' };
  if (node.type === 'aliased_import') {
    const name = node.childForFieldName('name');
    if (name === null) return undefined;
    const alias = node.childForFieldName('alias');
    return { local: alias?.text ?? name.text, imported: name.text };
  }
  if (node.type === 'dotted_name' || node.type === 'identifier') {
    return { local: node.text, imported: node.text };
  }
  return undefined;
}

/** One imported module in a plain `import a.b[, c] [as x]` statement. */
function importModule(node: SyntaxNode): RawImport | undefined {
  const span: [number, number] = [node.startIndex, node.endIndex];
  if (node.type === 'aliased_import') {
    const name = node.childForFieldName('name');
    if (name === null) return undefined;
    const alias = node.childForFieldName('alias');
    const local = alias?.text ?? name.text.split('.')[0]!;
    return { specifier: name.text, span, bindings: [{ local, imported: '' }], fromImport: false };
  }
  if (node.type === 'dotted_name') {
    return {
      specifier: node.text,
      span,
      bindings: [{ local: node.text.split('.')[0]!, imported: '' }],
      fromImport: false,
    };
  }
  return undefined;
}

/** Top-level `import …` / `from … import …` statements → the import table. */
function extractPyImports(root: SyntaxNode): RawImport[] {
  const imports: RawImport[] = [];
  for (let i = 0; i < root.namedChildCount; i++) {
    const stmt = root.namedChild(i);
    if (stmt === null) continue;
    if (stmt.type === 'import_statement') {
      for (let j = 0; j < stmt.namedChildCount; j++) {
        const child = stmt.namedChild(j);
        if (child === null) continue;
        const im = importModule(child);
        if (im !== undefined) imports.push(im);
      }
    } else if (stmt.type === 'import_from_statement') {
      const moduleName = stmt.childForFieldName('module_name');
      if (moduleName === null) continue;
      const span: [number, number] = [stmt.startIndex, stmt.endIndex];
      const bindings: RawImportBinding[] = [];
      for (let j = 0; j < stmt.namedChildCount; j++) {
        const child = stmt.namedChild(j);
        if (child === null || child.id === moduleName.id) continue;
        const b = fromBinding(child);
        if (b !== undefined) bindings.push(b);
      }
      imports.push({ specifier: normalizeWs(moduleName.text), span, bindings, fromImport: true });
    }
  }
  return imports;
}

/**
 * Map a parsed Python file into its {@link RawModule} skeleton. `source` is the
 * repository-relative POSIX path (the ADR-0028 `source` coordinate) and `label`
 * the display name (basename). An `__init__.py` is an ordinary `code:module`
 * (its declarations are its children) — a directory with one is a Python
 * package, which the directory-node rule already renders as a `code:package`.
 */
export function mapPythonModule(
  tree: Tree,
  opts: { readonly source: string; readonly label: string },
): RawModule {
  const outcome = summarizeTree(tree, 'python');
  const root = tree.rootNode;
  return {
    source: opts.source,
    language: 'python',
    label: opts.label,
    span: [0, root.endIndex],
    decls: mapBody(root, 'function'),
    imports: extractPyImports(root),
    hasErrors: outcome.hasErrors,
    errorCount: outcome.errorCount,
  };
}
