/**
 * The code adapter against the reusable **incremental** conformance harness
 * (7G; the generic machinery lives in `@meridian/conformance-kit`, driven here
 * for both languages). Each scenario is a scripted edit sequence with the
 * minimal delta expected at every step — whitespace ⇒ empty, a one-declaration
 * edit ⇒ one op, a file added / deleted ⇒ its module's ops — and the harness
 * additionally proves gate-validity, convergence to a cold ingest (I6), and
 * determinism, using only plugin-api + graph-core.
 */
import {
  describeIncrementalConformance,
  type IncrementalScenario,
  type ScenarioFile,
} from '@meridian/conformance-kit';
import { afterAll } from 'vitest';
import { codeManifest, createCodeIncrementalSession } from '../src/index.js';
import { inProcessMapper, testContext } from './support.js';

const mapper = inProcessMapper();
afterAll(() => mapper.dispose());
const ids = testContext().ids;

const setup = async (initial: readonly ScenarioFile[]) => {
  const session = await createCodeIncrementalSession({ mapper, ids }, { root: 'proj', files: [...initial] });
  return { adapter: session, document: () => session.document() };
};
const freshDocument = async (files: readonly ScenarioFile[]) => {
  const session = await createCodeIncrementalSession({ mapper, ids }, { root: 'proj', files: [...files] });
  return session.document();
};

// -- TypeScript edit script --------------------------------------------------

const TS0 = `export function add(a: number, b: number): number {
  return a + b;
}

export function mul(a: number, b: number): number {
  return a * b;
}
`;
const TS_WS = '\n' + TS0.replace('\n\n', '\n\n\n'); // pure reformat
const TS_RET = TS_WS.replace('function add(a: number, b: number): number', 'function add(a: number, b: number): Big');
const TS_NEW = 'export function helper(): void {}\n';

const tsScenario: IncrementalScenario = {
  name: 'TypeScript — whitespace, one-decl edit, file add, file delete',
  initial: [{ path: 'add.ts', text: TS0 }],
  edits: [
    { name: 'reformat (whitespace only)', change: { path: 'add.ts', newText: TS_WS }, expectEmpty: true },
    { name: 'change add() return type', change: { path: 'add.ts', newText: TS_RET }, expectOps: 1 },
    {
      name: 'add helper.ts',
      change: { path: 'helper.ts', newText: TS_NEW },
      expectOpsMatch: (ops) => {
        if (!ops.some((o) => o.t === 'node:add')) throw new Error('file-add should node:add');
      },
    },
    {
      name: 'delete helper.ts',
      change: { path: 'helper.ts' },
      expectOpsMatch: (ops) => {
        if (!ops.some((o) => o.t === 'node:remove')) throw new Error('file-delete should node:remove');
        if (!ops.some((o) => o.t === 'graph:remove')) throw new Error('file-delete should graph:remove');
      },
    },
  ],
};

// -- Python edit script ------------------------------------------------------

const PY0 = `def add(a: int, b: int) -> int:
    return a + b


def mul(a: int, b: int) -> int:
    return a * b
`;
const PY_WS = '\n' + PY0.replace('\n\n\n', '\n\n\n\n');
const PY_RET = PY_WS.replace('def add(a: int, b: int) -> int:', 'def add(a: int, b: int) -> Big:');
const PY_NEW = 'def helper() -> None:\n    pass\n';

const pyScenario: IncrementalScenario = {
  name: 'Python — whitespace, one-decl edit, file add, file delete',
  initial: [{ path: 'add.py', text: PY0 }],
  edits: [
    { name: 'reformat (whitespace only)', change: { path: 'add.py', newText: PY_WS }, expectEmpty: true },
    { name: 'change add() return type', change: { path: 'add.py', newText: PY_RET }, expectOps: 1 },
    {
      name: 'add helper.py',
      change: { path: 'helper.py', newText: PY_NEW },
      expectOpsMatch: (ops) => {
        if (!ops.some((o) => o.t === 'node:add')) throw new Error('file-add should node:add');
      },
    },
    {
      name: 'delete helper.py',
      change: { path: 'helper.py' },
      expectOpsMatch: (ops) => {
        if (!ops.some((o) => o.t === 'node:remove')) throw new Error('file-delete should node:remove');
      },
    },
  ],
};

describeIncrementalConformance({
  manifest: codeManifest,
  setup,
  freshDocument,
  scenarios: [tsScenario, pyScenario],
});
