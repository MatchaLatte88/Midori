import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  listSymbolsWithDrawings, loadDrawings, saveDrawings,
} from '../electron/data/store/drawingStore.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'midori-draw-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const line = (id = 'a') => ({
  id, type: 'horizontal', points: [{ time: 1000, price: 50 }], color: 'ind-1', width: 1,
});

test('drawings survive a save and load', async () => {
  await withTempDir(async (dir) => {
    await saveDrawings(dir, 'BTCUSDT', [line('one'), line('two')]);
    const back = await loadDrawings(dir, 'BTCUSDT');

    assert.equal(back.length, 2);
    assert.equal(back[0].id, 'one');
    assert.deepEqual(back[0].points, [{ time: 1000, price: 50 }]);
  });
});

test('an unknown symbol simply has no drawings', async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(await loadDrawings(dir, 'NOTHING'), []);
  });
});

test('symbols are matched case-insensitively through the filename', async () => {
  await withTempDir(async (dir) => {
    await saveDrawings(dir, 'btcusdt', [line()]);
    const back = await loadDrawings(dir, 'BTCUSDT');
    assert.equal(back.length, 1, 'the same symbol in another case is the same file');
  });
});

test('a symbol cannot escape the drawings directory', async () => {
  // The symbol comes from a text field, so it must never shape a path.
  await withTempDir(async (dir) => {
    const refused = [
      '../evil', 'a/b', 'a\\b', 'a:b',       // path separators
      '..', '.', '.hidden',                   // names that start with a dot
      '-flag',                                // reads as a flag to anything shelling out
      '', 'x'.repeat(33),                     // empty and over-long
      null, undefined, 42,                    // not even a string
    ];
    for (const bad of refused) {
      await assert.rejects(
        () => saveDrawings(dir, bad, [line()]),
        /Invalid symbol/,
        `${JSON.stringify(bad)} should be refused`,
      );
      await assert.rejects(() => loadDrawings(dir, bad), /Invalid symbol/);
    }
    assert.deepEqual(await readdir(dir), [], 'nothing was written anywhere');
  });
});

test('a dot inside a symbol is still allowed', async () => {
  // BRK.B and BTC.X are real tickers — the rule is about leading dots only.
  await withTempDir(async (dir) => {
    await saveDrawings(dir, 'BRK.B', [line()]);
    assert.equal((await loadDrawings(dir, 'BRK.B')).length, 1);
  });
});

test('saving an empty set removes the file rather than leaving an empty one', async () => {
  await withTempDir(async (dir) => {
    await saveDrawings(dir, 'BTCUSDT', [line()]);
    assert.ok(existsSync(path.join(dir, 'BTCUSDT.json')));

    const result = await saveDrawings(dir, 'BTCUSDT', []);
    assert.equal(result.count, 0);
    assert.equal(existsSync(path.join(dir, 'BTCUSDT.json')), false);
    assert.deepEqual(await loadDrawings(dir, 'BTCUSDT'), []);
  });
});

test('a corrupt file is set aside instead of being silently replaced', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'BTCUSDT.json');
    await writeFile(file, '{ this is not json');

    await assert.rejects(() => loadDrawings(dir, 'BTCUSDT'), /is not valid JSON/);
    assert.equal(existsSync(file), false, 'the broken file was moved out of the way');
    assert.ok(existsSync(`${file}.broken`), 'and kept, in case it can be recovered');

    // The symbol works again from here on.
    await saveDrawings(dir, 'BTCUSDT', [line()]);
    assert.equal((await loadDrawings(dir, 'BTCUSDT')).length, 1);
  });
});

test('a file without a drawings array reads as empty, not as a crash', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'BTCUSDT.json'), JSON.stringify({ symbol: 'BTCUSDT' }));
    assert.deepEqual(await loadDrawings(dir, 'BTCUSDT'), []);
  });
});

test('non-arrays and absurd counts are refused', async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(() => saveDrawings(dir, 'BTCUSDT', 'nope'), /expected an array/);
    await assert.rejects(
      () => saveDrawings(dir, 'BTCUSDT', new Array(5001).fill(line())),
      /exceeds the limit/,
    );
  });
});

test('the stored file records the symbol and a version', async () => {
  await withTempDir(async (dir) => {
    await saveDrawings(dir, 'ETHUSDT', [line()]);
    const raw = JSON.parse(await readFile(path.join(dir, 'ETHUSDT.json'), 'utf8'));
    assert.equal(raw.symbol, 'ETHUSDT');
    assert.equal(raw.version, 1);
    assert.ok(raw.updatedAt);
  });
});

test('symbols with drawings can be listed', async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(await listSymbolsWithDrawings(dir), []);
    await saveDrawings(dir, 'BTCUSDT', [line()]);
    await saveDrawings(dir, 'ETHUSDT', [line()]);
    const list = await listSymbolsWithDrawings(dir);
    assert.deepEqual(list.sort(), ['BTCUSDT', 'ETHUSDT']);
  });
});
