/**
 * The roadmap Phase 2 manual-exploratory exercise, kept alive as code: a toy
 * TODO-list parser written against plugin-api docs alone, run through the
 * conformance kit. It proves the kit works for a second, unrelated adapter —
 * the kit is written against the contract, not against any one domain — and
 * its friction findings seeded docs/guides/plugin-authors.md.
 *
 * Source format:
 *   Project: Home
 *   - [ ] buy milk
 *   - [x] wash car
 */
import type {
  GraphDocument,
  MeridianPlugin,
  PluginContext,
  SourceDescriptor,
} from '@meridian/plugin-api';
import { describe, expect, it } from 'vitest';
import { describeParserConformance, idFacade } from '../src/index.js';

const DOMAIN = 'todo';

function buildDocument(ctx: PluginContext, src: SourceDescriptor): GraphDocument {
  if (src.text === undefined) {
    throw new Error(`todo parser needs text, got ${src.bytes ? 'bytes' : 'nothing'} for ${src.uri}`);
  }
  const coords = (path: string[]) => ({ domain: DOMAIN, source: src.uri, path });
  const rootId = ctx.ids.graphId(coords([]));

  interface ProjectAcc {
    name: string;
    slug: string;
    span: [number, number];
    tasks: { text: string; done: boolean; span: [number, number] }[];
  }
  const projects: ProjectAcc[] = [];
  const slugCounts = new Map<string, number>();
  let offset = 0;
  for (const line of src.text.split('\n')) {
    const span: [number, number] = [offset, offset + line.length];
    offset += line.length + 1;
    const project = /^Project:\s*(.+)$/.exec(line);
    if (project) {
      const base = project[1]!.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const n = slugCounts.get(base) ?? 0;
      slugCounts.set(base, n + 1);
      projects.push({
        name: project[1]!.trim(),
        slug: n === 0 ? base : `${base}~${n}`,
        span,
        tasks: [],
      });
      continue;
    }
    const task = /^- \[([ x])\]\s*(.+)$/.exec(line);
    if (task) {
      const current = projects[projects.length - 1];
      if (!current) throw new Error(`task before any "Project:" line at offset ${span[0]}`);
      current.tasks.push({ text: task[2]!, done: task[1] === 'x', span });
    } else if (line.trim() !== '') {
      throw new Error(`unparseable line at offset ${span[0]}: ${JSON.stringify(line)}`);
    }
  }
  if (projects.length === 0) throw new Error(`no "Project:" lines in ${src.uri}`);

  const provenance = (span: [number, number]) => ({
    origin: 'source' as const,
    uri: src.uri,
    span,
  });

  const graphs: GraphDocument['graphs'] = [];
  const rootNodes: GraphDocument['graphs'][number]['nodes'] = [];
  for (const project of projects) {
    const detailId = ctx.ids.graphId(coords([project.slug]));
    rootNodes.push({
      id: ctx.ids.nodeId(coords([project.slug])),
      kind: 'todo:project',
      label: project.name,
      ...(project.tasks.length > 0 ? { detail: { graph: detailId } } : {}),
      attrs: { 'todo:tasks': project.tasks.length },
      provenance: provenance(project.span),
    });
    if (project.tasks.length > 0) {
      graphs.push({
        id: detailId,
        meta: { label: project.name, domain: DOMAIN, provenance: provenance(project.span) },
        nodes: project.tasks.map((task, i) => ({
          id: ctx.ids.nodeId(coords([project.slug, `task-${i}`])),
          kind: 'todo:task',
          label: task.text,
          attrs: { 'todo:done': task.done, 'todo:index': i },
          provenance: provenance(task.span),
        })),
        edges: [],
      });
    }
  }
  graphs.unshift({
    id: rootId,
    meta: {
      label: src.uri,
      domain: DOMAIN,
      provenance: { origin: 'source', uri: src.uri },
    },
    nodes: rootNodes,
    edges: [],
  });

  return {
    formatVersion: 1,
    producer: { name: 'toy-todo', version: '0.0.1' },
    roots: [rootId],
    graphs,
  };
}

const toyPlugin: MeridianPlugin = {
  manifest: {
    name: 'toy-todo',
    version: '0.0.1',
    apiVersion: '^0.2.0',
    capabilities: [{ kind: 'domain-parser', id: DOMAIN }],
    kinds: ['todo:project', 'todo:task'],
    attrSchemas: {
      'todo:tasks': { type: 'number', description: 'task count of a project' },
      'todo:done': { type: 'boolean', description: 'task completion' },
      'todo:index': { type: 'number', description: '0-based task order' },
    },
  },
  activate: (ctx) => ({
    parsers: [
      {
        domain: DOMAIN,
        sniff: (src) =>
          src.uri.endsWith('.todo') ? 0.9 : src.text?.startsWith('Project:') ? 0.6 : 0,
        ingest: async (src, sink) => {
          sink.emitDocument(buildDocument(ctx, src));
        },
      },
    ],
  }),
};

describeParserConformance({
  plugin: toyPlugin,
  corpus: [
    {
      name: 'two-projects',
      source: {
        uri: 'home.todo',
        text: 'Project: Home\n- [ ] buy milk\n- [x] wash car\n\nProject: Work\n- [ ] ship phase 2\n',
      },
    },
    {
      name: 'duplicate-project-names',
      source: {
        uri: 'dup.todo',
        text: 'Project: X\n- [ ] a\nProject: X\n- [x] b\n',
      },
    },
    { name: 'empty-project', source: { uri: 'empty.todo', text: 'Project: Nothing yet\n' } },
    {
      name: 'reject/binary',
      source: { uri: 'junk.todo', bytes: new Uint8Array([0, 1, 2, 255]) },
      expect: 'reject',
    },
    {
      name: 'reject/task-before-project',
      source: { uri: 'orphan.todo', text: '- [ ] homeless task\n' },
      expect: 'reject',
    },
  ],
});

describe('kit specifics the factory cannot self-test', () => {
  it('idFacade derives the tagged, hash-shaped IDs of ADR-0002', () => {
    const ids = idFacade();
    const nodeId = ids.nodeId({ domain: 'd', source: 's', path: ['p'] });
    const graphId = ids.graphId({ domain: 'd', source: 's', path: ['p'] });
    expect(nodeId).toMatch(/^n[a-z2-7]{26}$/);
    expect(graphId).toMatch(/^g[a-z2-7]{26}$/);
    expect(ids.nodeId({ domain: 'd', source: 's', path: ['p'] })).toBe(nodeId);
  });
});
