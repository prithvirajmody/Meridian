/**
 * Text → IR: the one entry the document builder calls. It accepts exactly the
 * two AutoBuild org contract documents (ADR-0047, `contracts/org-v1/`):
 *
 *   - `autobuild-org-bundle-v1`      — definition + expansion attribution + runs
 *   - `autobuild-org-definition-v1`  — a bare definition (structure-only)
 *
 * and normalizes both into one {@link OrgBundleIR}. Validation here is
 * *shape* validation (parse-don't-validate into narrow types): AutoBuild's
 * linter is the semantic authority and its seven rules are not re-implemented
 * on this side of the repository boundary. Anything structurally unusable is a
 * located {@link OrgParseError}; nothing is normalized, defaulted, or dropped.
 */
import { OrgParseError } from './errors.js';

export const BUNDLE_SCHEMA_VERSION = 'autobuild-org-bundle-v1';
export const DEFINITION_SCHEMA_VERSION = 'autobuild-org-definition-v1';

export interface OrgTeam {
  readonly instancePrefix: string;
  readonly templateRef: string;
}

/** A conditional edge: every verdict maps to the next workflow kind. */
export type WorkflowNext = readonly string[] | { readonly onVerdict: ReadonlyMap<string, string> };

export interface OrgWorkflowRow {
  readonly kind: string;
  readonly assignee: string;
  readonly reviewer: string;
  readonly requestedBy: string;
  readonly escalationRoute: string;
  readonly requiredInputs: readonly string[];
  readonly produces: string;
  readonly next: WorkflowNext;
}

export interface OrgGate {
  readonly gateId: string;
  readonly over: readonly string[];
}

export interface OrgDefinition {
  readonly orgId: string;
  readonly orgVersion: string;
  readonly digest?: string;
  readonly brainStore: string;
  readonly brainRootRef: string;
  readonly teams: readonly OrgTeam[];
  readonly workflow: readonly OrgWorkflowRow[];
  readonly gates: readonly OrgGate[];
}

/** One executable role instance with its team attribution. For a bundle this
 * is the expansion (team-minted instances included, `team` computed by
 * AutoBuild); for a bare definition it is the declared instances (all
 * team-less — a team's internals live in its template and are not visible). */
export interface OrgInstance {
  readonly instanceId: string;
  readonly roleType: string;
  readonly team: string | null;
  readonly engine: string | null;
}

export interface OrgRunEvent {
  readonly seq: number;
  readonly eventId: string;
  readonly timestamp: string;
  readonly role: string;
  readonly kind: string;
  readonly rawEvent: string;
  readonly detail: string;
}

export interface OrgRun {
  readonly jobId: string;
  readonly orgDigest: string | null;
  readonly events: readonly OrgRunEvent[];
}

export interface OrgBundleIR {
  readonly definition: OrgDefinition;
  readonly instances: readonly OrgInstance[];
  readonly runs: readonly OrgRun[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, uri: string, at: string): string {
  if (typeof value !== 'string') throw new OrgParseError('expected a string', { uri, at });
  return value;
}

function strOrNull(value: unknown, uri: string, at: string): string | null {
  if (value === null || value === undefined) return null;
  return str(value, uri, at);
}

function strArray(value: unknown, uri: string, at: string): readonly string[] {
  if (!Array.isArray(value)) throw new OrgParseError('expected an array of strings', { uri, at });
  return value.map((item, i) => str(item, uri, `${at}[${i}]`));
}

function rec(value: unknown, uri: string, at: string): Record<string, unknown> {
  if (!isRecord(value)) throw new OrgParseError('expected an object', { uri, at });
  return value;
}

function arr(value: unknown, uri: string, at: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new OrgParseError('expected an array', { uri, at });
  return value;
}

export function containsNul(text: string): boolean {
  return text.includes('\u0000');
}

function parseNext(value: unknown, uri: string, at: string): WorkflowNext {
  if (Array.isArray(value)) return strArray(value, uri, at);
  const record = rec(value, uri, at);
  const onVerdict = rec(record['on_verdict'], uri, `${at}.on_verdict`);
  const map = new Map<string, string>();
  for (const key of Object.keys(onVerdict).sort()) {
    map.set(key, str(onVerdict[key], uri, `${at}.on_verdict.${key}`));
  }
  return { onVerdict: map };
}

function parseDefinition(value: unknown, uri: string, at: string): OrgDefinition {
  const doc = rec(value, uri, at);
  const brain = rec(doc['brain_binding'], uri, `${at}.brain_binding`);
  const digest = doc['digest_sha256'];
  return {
    orgId: str(doc['org_id'], uri, `${at}.org_id`),
    orgVersion: str(doc['org_version'], uri, `${at}.org_version`),
    ...(typeof digest === 'string' ? { digest } : {}),
    brainStore: str(brain['store'], uri, `${at}.brain_binding.store`),
    brainRootRef: str(brain['root_ref'], uri, `${at}.brain_binding.root_ref`),
    teams: arr(doc['teams'] ?? [], uri, `${at}.teams`).map((team, i) => {
      const t = rec(team, uri, `${at}.teams[${i}]`);
      return {
        instancePrefix: str(t['instance_prefix'], uri, `${at}.teams[${i}].instance_prefix`),
        templateRef: str(t['template_ref'], uri, `${at}.teams[${i}].template_ref`),
      };
    }),
    workflow: arr(doc['workflow'], uri, `${at}.workflow`).map((row, i) => {
      const r = rec(row, uri, `${at}.workflow[${i}]`);
      const rowAt = `${at}.workflow[${i}]`;
      return {
        kind: str(r['kind'], uri, `${rowAt}.kind`),
        assignee: str(r['assignee'], uri, `${rowAt}.assignee`),
        reviewer: str(r['reviewer'], uri, `${rowAt}.reviewer`),
        requestedBy: str(r['requested_by'], uri, `${rowAt}.requested_by`),
        escalationRoute: str(r['escalation_route'], uri, `${rowAt}.escalation_route`),
        requiredInputs: strArray(r['required_inputs'], uri, `${rowAt}.required_inputs`),
        produces: str(r['produces'], uri, `${rowAt}.produces`),
        next: parseNext(r['next'], uri, `${rowAt}.next`),
      };
    }),
    gates: arr(doc['gates'] ?? [], uri, `${at}.gates`).map((gate, i) => {
      const g = rec(gate, uri, `${at}.gates[${i}]`);
      return {
        gateId: str(g['gate_id'], uri, `${at}.gates[${i}].gate_id`),
        over: strArray(g['over'], uri, `${at}.gates[${i}].over`),
      };
    }),
  };
}

function declaredInstances(value: unknown, uri: string, at: string): readonly OrgInstance[] {
  return arr(value, uri, at).map((instance, i) => {
    const inst = rec(instance, uri, `${at}[${i}]`);
    return {
      instanceId: str(inst['instance_id'], uri, `${at}[${i}].instance_id`),
      roleType: str(inst['role_type'], uri, `${at}[${i}].role_type`),
      team: null,
      engine: strOrNull(inst['engine'], uri, `${at}[${i}].engine`),
    };
  });
}

function parseRun(value: unknown, uri: string, at: string): OrgRun {
  const run = rec(value, uri, at);
  const version = str(run['schema_version'], uri, `${at}.schema_version`);
  if (version !== 'autobuild-org-run-events-v1') {
    throw new OrgParseError(`unsupported run schema_version ${JSON.stringify(version)}`, { uri, at });
  }
  return {
    jobId: str(run['job_id'], uri, `${at}.job_id`),
    orgDigest: strOrNull(run['org_digest'], uri, `${at}.org_digest`),
    events: arr(run['events'], uri, `${at}.events`).map((event, i) => {
      const e = rec(event, uri, `${at}.events[${i}]`);
      const eventAt = `${at}.events[${i}]`;
      const seq = e['seq'];
      if (typeof seq !== 'number' || !Number.isInteger(seq)) {
        throw new OrgParseError('expected an integer seq', { uri, at: `${eventAt}.seq` });
      }
      return {
        seq,
        eventId: str(e['event_id'], uri, `${eventAt}.event_id`),
        timestamp: str(e['timestamp'], uri, `${eventAt}.timestamp`),
        role: str(e['role'], uri, `${eventAt}.role`),
        kind: str(e['kind'], uri, `${eventAt}.kind`),
        rawEvent: str(e['raw_event'], uri, `${eventAt}.raw_event`),
        detail: str(e['detail'], uri, `${eventAt}.detail`),
      };
    }),
  };
}

/** Parse an org source text into the unified IR, or throw a located error. */
export function parseOrgSource(text: string, uri: string): OrgBundleIR {
  if (containsNul(text)) {
    throw new OrgParseError('source is not text (contains a NUL byte)', { uri });
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (e) {
    throw new OrgParseError(`not valid JSON: ${(e as Error).message}`, { uri });
  }

  const doc = rec(value, uri, '$');
  const version = doc['schema_version'];
  if (version === BUNDLE_SCHEMA_VERSION) {
    const expansion = rec(doc['expansion'], uri, '$.expansion');
    const instances = arr(expansion['instances'], uri, '$.expansion.instances').map(
      (instance, i) => {
        const inst = rec(instance, uri, `$.expansion.instances[${i}]`);
        const at = `$.expansion.instances[${i}]`;
        return {
          instanceId: str(inst['instance_id'], uri, `${at}.instance_id`),
          roleType: str(inst['role_type'], uri, `${at}.role_type`),
          team: strOrNull(inst['team'], uri, `${at}.team`),
          engine: strOrNull(inst['engine'], uri, `${at}.engine`),
        };
      },
    );
    return {
      definition: parseDefinition(doc['definition'], uri, '$.definition'),
      instances,
      runs: arr(doc['runs'], uri, '$.runs').map((run, i) => parseRun(run, uri, `$.runs[${i}]`)),
    };
  }
  if (version === DEFINITION_SCHEMA_VERSION) {
    return {
      definition: parseDefinition(doc, uri, '$'),
      instances: declaredInstances(doc['instances'], uri, '$.instances'),
      runs: [],
    };
  }
  throw new OrgParseError(
    `unrecognized org document (schema_version ${JSON.stringify(version ?? null)})`,
    { uri, at: '$.schema_version' },
  );
}
