/* Drawings on disk — one JSON file per symbol.
 *
 * Kept beside the market data but in its own folder: a redownload replaces
 * candles, and it must never take a year of annotations with it.
 *
 * Drawings are stored per symbol, not per timeframe. A level that matters on
 * the hourly matters on the daily; splitting them by timeframe would mean the
 * same line drawn four times.
 */
import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Guards against a runaway loop filling the disk with one symbol's file. */
const MAX_PER_SYMBOL = 5000;

/* Symbols come from a text field, so they must never shape a path.
 *
 * The first character has to be alphanumeric: dots are legitimate inside a
 * symbol (BRK.B, BTC.X) but a name that starts with one gives ".", ".." and
 * hidden files, and a leading dash reads as a flag to anything shelling out. */
const SAFE_SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

function safeName(symbol) {
  if (typeof symbol !== 'string' || !SAFE_SYMBOL.test(symbol)) {
    throw new Error(`Invalid symbol for a drawing file: ${JSON.stringify(symbol)}`);
  }
  return symbol.toUpperCase();
}

function fileFor(dir, symbol) {
  return path.join(dir, `${safeName(symbol)}.json`);
}

export async function loadDrawings(dir, symbol) {
  const file = fileFor(dir, symbol);
  if (!existsSync(file)) return [];

  const text = await readFile(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // A corrupt file must not take the chart down with it, but it also must
    // not be silently replaced — keep it aside and say so.
    const broken = `${file}.broken`;
    await rename(file, broken).catch(() => {});
    throw new Error(
      `${file} is not valid JSON (${err.message}). It was moved to ${path.basename(broken)} `
      + `and the symbol now starts with no drawings.`,
    );
  }

  if (!Array.isArray(parsed?.drawings)) return [];
  return parsed.drawings;
}

export async function saveDrawings(dir, symbol, drawings) {
  if (!Array.isArray(drawings)) {
    throw new Error(`saveDrawings(${symbol}): expected an array, got ${typeof drawings}`);
  }
  if (drawings.length > MAX_PER_SYMBOL) {
    throw new Error(
      `saveDrawings(${symbol}): ${drawings.length} drawings exceeds the limit of ${MAX_PER_SYMBOL}`,
    );
  }

  await mkdir(dir, { recursive: true });
  const file = fileFor(dir, symbol);

  // Nothing left to store: remove the file rather than leaving an empty one.
  if (drawings.length === 0) {
    if (existsSync(file)) await unlink(file);
    return { count: 0 };
  }

  const payload = JSON.stringify({
    symbol: safeName(symbol),
    version: 1,
    updatedAt: new Date().toISOString(),
    drawings,
  }, null, 2);

  // Temp file then rename — a crash mid-write must not truncate the set.
  const tmp = `${file}.tmp`;
  await writeFile(tmp, payload, 'utf8');
  await rename(tmp, file);

  return { count: drawings.length };
}

/** Symbols that have drawings, for a future overview. */
export async function listSymbolsWithDrawings(dir) {
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length));
}
