/**
 * `meridian open` (ROADMAP Phase 11 §6, SUBPHASES 11B): open a `.meridian`
 * SQLite project — checkpoint load + oplog tail replay (ADR-0038) — then
 * report, import, export, or mutate it through the one write path with the
 * storage backend attached. `--salvage` is the ADR-0038 §6 corruption exit:
 * best-effort document export from a damaged file, never writing to it.
 */
import { writeFile } from 'node:fs/promises';
import {
  decode,
  encodePretty,
  MeridianError,
  stats,
  type GraphSpace,
} from '@meridian/graph-core';
import { decodeDeltaInput } from '@meridian/graph-store';
import { openProjectStore, salvageProject } from '@meridian/store-sqlite/node';

export interface OpenOptions {
  readonly json: boolean;
  readonly importDoc?: string;
  readonly exportDoc?: string;
  readonly script?: string;
  readonly salvage?: string;
}

interface OpenIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly readDocument: (file: string) => Promise<string>;
}

const PRODUCER = { name: '@meridian/cli', version: '0.1.0' };

export async function cmdOpen(file: string, opts: OpenOptions, io: OpenIo): Promise<number> {
  if (opts.salvage !== undefined) {
    return salvage(file, opts.salvage, opts.json, io);
  }

  let initialSpace: GraphSpace | undefined;
  if (opts.importDoc !== undefined) {
    const text = await io.readDocument(opts.importDoc);
    const decoded = decode(text);
    if (!decoded.ok) {
      io.err(`${opts.importDoc}: invalid document (${decoded.errors.length} errors) — first: [${decoded.errors[0]!.code}] ${decoded.errors[0]!.message}`);
      return 1;
    }
    initialSpace = decoded.space;
  }

  try {
    const { project, store } = await openProjectStore(file, {
      ...(initialSpace ? { initialSpace } : {}),
      onBackendError: (e) => io.err(`storage backend error: ${e instanceof Error ? e.message : String(e)}`),
    });
    try {
      if (opts.script !== undefined) {
        const parsed = decodeDeltaInput(await io.readDocument(opts.script));
        if (!parsed.ok) {
          io.err(`${opts.script}: invalid delta script — first: ${parsed.errors[0]!.message}`);
          return 1;
        }
        const applied = store.apply(parsed.delta);
        if (!applied.ok) {
          io.err(`delta rejected — first: [${applied.errors[0]!.code}] ${applied.errors[0]!.message}`);
          return 1;
        }
        await project.flush();
      }
      const space = store.snapshot();
      if (opts.exportDoc !== undefined) {
        await writeFile(opts.exportDoc, encodePretty(space, { producer: PRODUCER }), 'utf8');
      }
      const s = stats(space);
      const version = store.version();
      if (opts.json) {
        io.out(
          JSON.stringify({
            ok: true,
            file,
            version,
            replayedDeltas: project.replayedDeltas,
            ...(project.migrated ? { migrated: project.migrated } : {}),
            stats: s,
          }),
        );
      } else {
        io.out(`${file}: open ok`);
        io.out(`  version v${version.counter}@${version.site} · replayed ${project.replayedDeltas} oplog deltas at open`);
        if (project.migrated) io.out(`  storage schema migrated v${project.migrated.from} → v${project.migrated.to} (backup written)`);
        io.out(`  graphs ${s.graphs} · nodes ${s.nodes} · edges ${s.edges} · roots ${s.roots} · max depth ${s.maxDepth}`);
        if (opts.importDoc !== undefined) io.out(`  imported ${opts.importDoc}`);
        if (opts.exportDoc !== undefined) io.out(`  exported ${opts.exportDoc}`);
      }
      return 0;
    } finally {
      await project.close();
    }
  } catch (e) {
    if (e instanceof MeridianError) {
      io.err(`${file}: [${e.code}] ${e.message}`);
      return 1;
    }
    throw e;
  }
}

async function salvage(file: string, outPath: string, json: boolean, io: OpenIo): Promise<number> {
  try {
    const result = salvageProject(file);
    if (result.document === null) {
      io.err(`${file}: nothing salvageable — ${result.issues.length} issues`);
      for (const issue of result.issues) io.err(`  ${issue}`);
      return 1;
    }
    await writeFile(outPath, JSON.stringify(result.document, null, 2) + '\n', 'utf8');
    if (json) {
      io.out(JSON.stringify({ ok: true, file, salvagedTo: outPath, issues: result.issues }));
    } else {
      io.out(`${file}: salvaged to ${outPath} (${result.issues.length} issues)`);
      for (const issue of result.issues) io.out(`  ${issue}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof MeridianError) {
      io.err(`${file}: [${e.code}] ${e.message}`);
      return 1;
    }
    throw e;
  }
}
