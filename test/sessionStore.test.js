/* Sessions that are not finished yet, on disk.
 *
 * The store itself is small; what it has to get right is that putting the same
 * afternoon down twice leaves one entry rather than a trail of them, and that
 * the index and the files never drift apart — a listing that shows a session
 * whose file is gone is worse than no listing at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  deleteSession, listSessions, loadSession, saveSession,
} from '../electron/data/store/sessionStore.js';

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'midori-sessions-'));
}

/** A session in the shape the renderer hands over. */
function makeSession(over = {}) {
  return {
    name: 'an afternoon',
    symbol: 'BTCUSDT',
    timeframe: '5m',
    startTime: Date.UTC(2026, 0, 1),
    clock: Date.UTC(2026, 0, 1, 4),
    stats: { bars: 48, trades: 3, openPositions: 1, equity: 10_250, initialBalance: 10_000 },
    session: {
      version: 1,
      stepMs: 300_000,
      startTime: Date.UTC(2026, 0, 1),
      clock: Date.UTC(2026, 0, 1, 4),
      broker: { initialBalance: 10_000, balance: 10_250, orders: [], fills: [], trades: [] },
      equityCurve: [{ time: 1, equity: 10_000, balance: 10_000, drawdown: 0 }],
    },
    ...over,
  };
}

test('a stored session comes back as it went in', async () => {
  const dir = await tempDir();
  try {
    const { id } = await saveSession(dir, makeSession());
    const back = await loadSession(dir, id);

    assert.equal(back.id, id);
    assert.equal(back.name, 'an afternoon');
    assert.equal(back.session.clock, Date.UTC(2026, 0, 1, 4));
    assert.ok(back.savedAt > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the listing summarises without opening every file', async () => {
  const dir = await tempDir();
  try {
    await saveSession(dir, makeSession({ name: 'one' }));
    await saveSession(dir, makeSession({ name: 'two', symbol: 'ETHUSDT' }));

    const list = await listSessions(dir);
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'two', 'newest first');
    assert.equal(list[0].trades, 3);
    assert.equal(list[0].equity, 10_250);
    assert.ok(!('session' in list[0]), 'the account itself is not in the index');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saving under the same id replaces the entry rather than adding one', async () => {
  const dir = await tempDir();
  try {
    const first = await saveSession(dir, makeSession({ name: 'monday' }));
    const second = await saveSession(dir, makeSession({ id: first.id, name: 'monday' }));

    assert.equal(second.id, first.id);
    const list = await listSessions(dir);
    assert.equal(list.length, 1);

    const files = (await readdir(dir)).filter((f) => f.startsWith('s'));
    assert.equal(files.length, 1, 'and one file, not two');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deleting takes the file and the entry together', async () => {
  const dir = await tempDir();
  try {
    const { id } = await saveSession(dir, makeSession());
    await deleteSession(dir, id);

    assert.deepEqual(await listSessions(dir), []);
    await assert.rejects(() => loadSession(dir, id), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deleting one that is already gone is not an error', async () => {
  const dir = await tempDir();
  try {
    const { id } = await saveSession(dir, makeSession());
    await deleteSession(dir, id);
    assert.equal(await deleteSession(dir, id), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a lost index is rebuilt from the files rather than read as an empty library', async () => {
  const dir = await tempDir();
  try {
    await saveSession(dir, makeSession({ name: 'one' }));
    await saveSession(dir, makeSession({ name: 'two' }));
    await writeFile(path.join(dir, 'index.json'), 'not json at all', 'utf8');

    const list = await listSessions(dir);
    assert.equal(list.length, 2);
    assert.deepEqual(
      list.map((s) => s.name).sort(),
      ['one', 'two'],
    );

    // And it was written back, so the next read is a single file again.
    const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
    assert.equal(index.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an id that is not one is refused before it can shape a path', async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(() => loadSession(dir, '../../etc/passwd'), /Invalid session id/);
    await assert.rejects(() => deleteSession(dir, 'r123456'), /Invalid session id/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listing a directory that does not exist yet is empty, not a failure', async () => {
  const dir = path.join(tmpdir(), `midori-missing-${Date.now()}`);
  assert.deepEqual(await listSessions(dir), []);
});
