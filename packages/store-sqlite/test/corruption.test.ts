/**
 * Corruption policy (ADR-0038 §6): detected → typed refusal with a salvage
 * path; salvage is best-effort, reads only, and produces a decodable
 * document with located issue notes.
 */
import { openSync, writeFileSync, writeSync, closeSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decode, encodePretty, MeridianError } from '@meridian/graph-core';
import { openProject, salvageProject, BetterSqlite3Driver } from '../src/node/index.js';
import { eid, tmpProjectPath, twoLevelSpace } from './helpers.js';

async function expectOpenFails(path: string, code: string): Promise<void> {
  try {
    const project = await openProject(path);
    await project.close();
    expect.unreachable(`open should have refused with ${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(MeridianError);
    expect((e as MeridianError).code).toBe(code);
  }
}

describe('corruption and refusal', () => {
  it('a file that is not SQLite refuses with storage-corrupt', async () => {
    const path = tmpProjectPath('garbage.meridian');
    writeFileSync(path, 'this is not a database, it is a haiku\n'.repeat(40));
    await expectOpenFails(path, 'storage-corrupt');
  });

  it('a SQLite db that is not a Meridian project refuses with storage-not-a-project', async () => {
    const path = tmpProjectPath('other.sqlite');
    const db = new BetterSqlite3Driver(path);
    db.exec('CREATE TABLE recipes (id INTEGER PRIMARY KEY, name TEXT)');
    db.close();
    await expectOpenFails(path, 'storage-not-a-project');
  });

  it('mid-file byte damage on a real project is detected, never half-opened', async () => {
    const path = tmpProjectPath();
    const project = await openProject(path, { initialSpace: twoLevelSpace() });
    await project.close();

    const size = statSync(path).size;
    expect(size).toBeGreaterThan(12288); // schema + data span several pages
    const fd = openSync(path, 'r+');
    // Stomp whole b-tree pages (pages 2–3, default 4 KiB page size), leaving
    // the header intact: valid SQLite file, invalid trees.
    writeSync(fd, Buffer.alloc(8192, 0xab), 0, 8192, 4096);
    closeSync(fd);

    try {
      const opened = await openProject(path);
      await opened.close();
      expect.unreachable('open should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(MeridianError);
      expect(['storage-corrupt', 'storage-io']).toContain((e as MeridianError).code);
    }
  });

  it('an overwrite of an existing project via initialSpace is refused', async () => {
    const path = tmpProjectPath();
    const project = await openProject(path, { initialSpace: twoLevelSpace() });
    await project.close();
    try {
      await openProject(path, { initialSpace: twoLevelSpace() });
      expect.unreachable('should have refused');
    } catch (e) {
      expect((e as MeridianError).code).toBe('storage-io');
    }
  });
});

describe('salvage export (reads only, best effort)', () => {
  it('a healthy project salvages to a decodable, complete document', async () => {
    const path = tmpProjectPath();
    const space = twoLevelSpace();
    const project = await openProject(path, { initialSpace: space });
    await project.close();

    const before = statSync(path).mtimeMs;
    const result = salvageProject(path);
    expect(result.issues).toEqual([]);
    expect(result.document).not.toBeNull();
    const decoded = decode(result.document);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      const producer = { name: 'test', version: '0' };
      expect(encodePretty(decoded.space, { producer })).toBe(encodePretty(space, { producer }));
    }
    expect(statSync(path).mtimeMs).toBe(before); // salvage never writes
  });

  it('dangling rows are dropped with located issues, output still decodes', async () => {
    const path = tmpProjectPath();
    const project = await openProject(path, { initialSpace: twoLevelSpace() });
    await project.close();

    const db = new BetterSqlite3Driver(path);
    db.run('DELETE FROM nodes WHERE id = ?', ['n-b']); // strands edge e-ab
    db.close();

    const result = salvageProject(path);
    expect(result.document).not.toBeNull();
    expect(result.issues.some((i) => i.includes(eid('e-ab')))).toBe(true);
    const decoded = decode(result.document);
    expect(decoded.ok).toBe(true);
  });
});
