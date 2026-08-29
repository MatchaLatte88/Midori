import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseKlineCsv } from '../electron/data/providers/binance.js';

// Real rows, copied from the published archives.
const MS_ROW = '1672531200000,16541.77000000,16544.76000000,16538.45000000,16543.67000000,'
  + '83.08143000,1672531259999,1374268.84886160,2687,40.18369000,664706.01106360,0';
const US_ROW = '1748736000000000,104591.88000000,104647.11000000,104591.88000000,104647.11000000,'
  + '10.71688000,1748736059999999,1121053.19051460,1136,9.99825000,1045871.17272520,0';

test('millisecond timestamps are read as-is', () => {
  const [bar] = parseKlineCsv(MS_ROW);
  assert.equal(bar.time, 1672531200000);
  assert.equal(new Date(bar.time).toISOString(), '2023-01-01T00:00:00.000Z');
  assert.equal(bar.open, 16541.77);
  assert.equal(bar.high, 16544.76);
  assert.equal(bar.low, 16538.45);
  assert.equal(bar.close, 16543.67);
  assert.equal(bar.volume, 83.08143);
});

test('taker buy volume is read from column 9', () => {
  const [bar] = parseKlineCsv(MS_ROW);
  assert.equal(bar.buyVolume, 40.18369);
  assert.ok(bar.buyVolume < bar.volume, 'the aggressive side is part of the total');

  const [us] = parseKlineCsv(US_ROW);
  assert.equal(us.buyVolume, 9.99825);
});

test('a row without the column reports unknown rather than zero', () => {
  // Zero would claim every trade was a sell; NaN says it was never recorded.
  const [bar] = parseKlineCsv('1672531200000,1,2,0.5,1.5,10');
  assert.ok(Number.isNaN(bar.buyVolume));
});

test('buy volume larger than total volume is rejected', () => {
  const broken = '1672531200000,1,2,0.5,1.5,10,1672531259999,100,5,999,50,0';
  assert.throws(() => parseKlineCsv(broken), /exceeds total volume/);
});

test('microsecond timestamps are converted', () => {
  // Binance switched units during 2025; unconverted, this row lands in year 57385.
  const [bar] = parseKlineCsv(US_ROW);
  assert.equal(new Date(bar.time).toISOString(), '2025-06-01T00:00:00.000Z');
  assert.equal(bar.close, 104647.11);
});

test('both units survive in one file', () => {
  const bars = parseKlineCsv(`${MS_ROW}\n${US_ROW}\n`);
  assert.equal(bars.length, 2);
  assert.ok(bars.every((b) => b.time < 2e12), 'every timestamp normalized to ms');
});

test('blank lines and a header row are skipped', () => {
  const csv = `open_time,open,high,low,close,volume\n${MS_ROW}\n\n`;
  assert.equal(parseKlineCsv(csv).length, 1);
});

test('a malformed row throws instead of being dropped', () => {
  assert.throws(() => parseKlineCsv('1672531200000,16541.77,not-a-number,1,2,3'),
    /unparseable row/);
  assert.throws(() => parseKlineCsv('1672531200000,1,2'), /expected >= 6 columns/);
  assert.throws(() => parseKlineCsv('1672531200000,1,5,9,2,3'), /high 5 below low 9/);
});
