/* Trading sessions.
 *
 * The thing worth testing here is not "does it find three blocks" but whether a
 * session stays put when a clock changes. A session defined in fixed UTC hours
 * looks right for most of the year and is silently an hour out for the rest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_PRESETS, SESSION_ZONES, checkSession, computeSessions, inWindow,
  isKnownZone, newSession, parseClock,
} from '../shared/indicators/sessions.js';
import { INDICATORS, computeIndicator } from '../shared/indicators/index.js';

const DAY = 86_400_000;

/** 15m bars, in milliseconds, from a UTC start. */
function bars(count, startMs, priceAt = () => 100) {
  return Array.from({ length: count }, (_, i) => {
    const price = priceAt(i);
    return {
      time: startMs + i * 900_000,
      open: price, high: price + 1, low: price - 1, close: price, volume: 1,
    };
  });
}

const utcHour = (t) => new Date(t).getUTCHours();

test('a session lands on its own local hours, not on UTC ones', () => {
  const { sessions } = computeSessions(bars(96, Date.UTC(2026, 7, 27)), { preset: 'futures' });
  const london = sessions.find((s) => s.name === 'London');

  // 08:00 London in August is 07:00 UTC.
  assert.equal(utcHour(london.startTime), 7);
  assert.equal(london.zone, 'Europe/London');
});

test('the same session sits an hour later in UTC once the clocks go back', () => {
  /* The whole reason zones are stored rather than offsets. August is BST
   * (UTC+1), January is GMT (UTC+0), so the same 08:00 London session sits at a
   * different UTC hour in each. */
  const summer = computeSessions(bars(96, Date.UTC(2026, 7, 27)), { preset: 'futures' });
  const winter = computeSessions(bars(96, Date.UTC(2027, 0, 27)), { preset: 'futures' });

  const at = (result) => utcHour(result.sessions.find((s) => s.name === 'London').startTime);
  assert.equal(at(summer), 7);
  assert.equal(at(winter), 8);
  assert.notEqual(at(summer), at(winter), 'a fixed-offset table would return the same hour');
});

test('a session carries the high and low actually reached inside it', () => {
  /* A spike at 03:00 UTC. Tokyo runs 09:00-18:00 JST, which in August is
   * 00:00-09:00 UTC, so the spike is inside it; London only opens at 07:00 UTC. */
  const rows = bars(96, Date.UTC(2026, 7, 27), (i) => (i === 12 ? 500 : 100));

  const { sessions } = computeSessions(rows, { preset: 'forex' });
  const tokyo = sessions.find((s) => s.name === 'Tokyo');
  const london = sessions.find((s) => s.name === 'London');

  assert.equal(tokyo.high, 501, 'the spike falls inside Tokyo');
  assert.equal(london.high, 101, 'and outside London');
  assert.ok(tokyo.low <= 99);
});

test('a window through midnight stays one block', () => {
  const overnight = [{ name: 'Overnight', zone: 'UTC', start: '22:00', end: '04:00', color: 'ind-1' }];
  const { sessions } = computeSessions(bars(192, Date.UTC(2026, 7, 27)), {
    preset: 'custom', custom: overnight,
  });

  for (const s of sessions) {
    const hours = (s.endTime - s.startTime) / 3_600_000;
    assert.ok(hours <= 6, `a wrapped block must not span ${hours} hours`);
  }

  const full = sessions.find((s) => utcHour(s.startTime) === 22);
  assert.ok(full, 'a block starting at 22:00 UTC');
  assert.equal(utcHour(full.endTime), 3, 'and running to just before 04:00');
});

test('inWindow wraps only when the window does', () => {
  assert.equal(inWindow(9 * 60, 8 * 60, 17 * 60), true);
  assert.equal(inWindow(17 * 60, 8 * 60, 17 * 60), false, 'the end is exclusive');
  assert.equal(inWindow(2 * 60, 22 * 60, 4 * 60), true);
  assert.equal(inWindow(12 * 60, 22 * 60, 4 * 60), false);
});

test('days keeps only recent sessions', () => {
  const rows = bars(96 * 5, Date.UTC(2026, 7, 24));
  const all = computeSessions(rows, { preset: 'futures', days: 0 }).sessions;
  const recent = computeSessions(rows, { preset: 'futures', days: 2 }).sessions;

  assert.ok(recent.length < all.length);
  const cutoff = rows.at(-1).time - 2 * DAY;
  assert.ok(recent.every((s) => s.endTime >= cutoff));
});

test('a broken session definition is refused with its own name', () => {
  const of = (patch) => ({ name: 'X', zone: 'UTC', start: '08:00', end: '09:00', ...patch });
  assert.throws(() => checkSession(of({ name: '' })), /needs a name/);
  assert.throws(() => checkSession(of({ start: '25:00' })), /must be HH:MM/);
  assert.throws(() => checkSession(of({ end: '8:00' })), /must be HH:MM/);
  assert.throws(() => checkSession(of({ end: '08:00' })), /same time/);
  assert.throws(() => checkSession(of({ zone: 'Mars/Olympus' })), /not a known time zone/);
  assert.throws(
    () => computeSessions(bars(4, Date.UTC(2026, 0, 1)), { preset: 'lunar' }),
    /unknown preset/,
  );
});

test('parseClock accepts a clock and nothing else', () => {
  assert.equal(parseClock('00:00'), 0);
  assert.equal(parseClock('09:30'), 570);
  assert.equal(parseClock('23:59'), 1439);
  for (const bad of ['24:00', '9:30', '0930', '', null, undefined, '12:60']) {
    assert.equal(parseClock(bad), null, `${bad} is not a clock time`);
  }
});

test('every offered zone and preset is one Intl actually knows', () => {
  // A zone name with a typo throws deep inside the formatter, on the first bar.
  for (const z of SESSION_ZONES) {
    assert.ok(isKnownZone(z.value), `${z.value} is not a real IANA zone`);
  }
  for (const [preset, list] of Object.entries(SESSION_PRESETS)) {
    list.forEach((s, i) => checkSession(s, `${preset}[${i}]`));
  }
  checkSession(newSession());
});

test('the registry runs sessions and validates a custom list', () => {
  const rows = bars(96, Date.UTC(2026, 7, 27));
  const { sessions } = computeIndicator('sessions', rows, { days: 0 });
  assert.ok(sessions.length > 0);
  assert.equal(INDICATORS.sessions.kind, 'sessions');

  assert.throws(
    () => computeIndicator('sessions', rows, { preset: 'custom', custom: 'nope' }),
    /expected a list of sessions/,
  );
  assert.throws(
    () => computeIndicator('sessions', rows, {
      preset: 'custom',
      custom: [
        { name: 'A', zone: 'UTC', start: '08:00', end: '09:00' },
        { name: 'B', zone: 'X/Y', start: '01:00', end: '02:00' },
      ],
    }),
    /custom\[1\]/,
  );
});

test('bars in seconds are the documented failure, and land in 1970', () => {
  /* This file cannot tell seconds from milliseconds — both are numbers — so it
   * is unambiguous about which it wants and the chart converts once. Left
   * undetected, the output still looks like a plausible list of sessions. */
  const secondsBars = bars(96, Date.UTC(2026, 7, 27)).map((b) => ({ ...b, time: b.time / 1000 }));
  const { sessions } = computeSessions(secondsBars, { preset: 'futures', days: 0 });
  assert.equal(new Date(sessions[0].startTime).getUTCFullYear(), 1970);
});
