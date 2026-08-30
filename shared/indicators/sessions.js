/* Trading sessions — Asia, London, New York, and whatever else you define.
 *
 * A session is a window in a *market's own* local time, and that is the whole
 * difficulty. London runs 08:00–17:00 London, which is 07:00–16:00 UTC in
 * winter and 08:00–17:00 UTC minus an hour... in summer it is 07:00–16:00 UTC
 * again — but the two markets do not switch on the same weekend. Britain moves
 * on the last Sunday in March, the United States on the second Sunday in March,
 * and Australia moves the other way entirely. For three weeks a year, a session
 * defined in fixed UTC hours is simply in the wrong place.
 *
 * So sessions are stored with an IANA zone and read through Intl, which knows
 * every one of those rules and keeps knowing them when the rules change. No
 * offset table in this file, and none to maintain.
 *
 * Bar times must be milliseconds
 * ------------------------------
 * Everything here goes through `new Date(bar.time)`. Hand it seconds and every
 * bar lands in January 1970, where the session windows are meaningless but the
 * output still looks like a plausible list of sessions. The chart converts on
 * the way in for exactly this reason — see ChartPanel's indicatorBars.
 *
 * What comes out
 * --------------
 * One entry per session per day it actually appears in the data, carrying the
 * bars it spans and the high and low reached inside it:
 *
 *   { name, color, startIndex, endIndex, startTime, endTime, high, low }
 *
 * A session that runs over midnight (Asia, mostly) is one entry, not two. A
 * session cut off by the end of the loaded data is reported as far as it goes,
 * because the alternative is to hide the session currently being traded.
 */

/** Sessions as most desks actually watch them, in each market's local time. */
export const SESSION_PRESETS = {
  futures: [
    /* Index futures trade around the clock, so these are the stretches people
     * mean by "the Asia session" and so on, not exchange opening hours. New
     * York is the regular cash session, because that is when the volume is. */
    { name: 'Asia', zone: 'Asia/Tokyo', start: '09:00', end: '15:00', color: 'ind-2' },
    { name: 'London', zone: 'Europe/London', start: '08:00', end: '16:30', color: 'ind-1' },
    { name: 'New York', zone: 'America/New_York', start: '09:30', end: '16:00', color: 'ind-3' },
  ],
  forex: [
    // The classic four, each the local business day of its centre.
    { name: 'Sydney', zone: 'Australia/Sydney', start: '08:00', end: '17:00', color: 'ind-5' },
    { name: 'Tokyo', zone: 'Asia/Tokyo', start: '09:00', end: '18:00', color: 'ind-2' },
    { name: 'London', zone: 'Europe/London', start: '08:00', end: '17:00', color: 'ind-1' },
    { name: 'New York', zone: 'America/New_York', start: '08:00', end: '17:00', color: 'ind-3' },
  ],
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes past local midnight, or null if the string is not a clock time. */
export function parseClock(value) {
  const m = HHMM.exec(String(value ?? ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Validates one session definition, so a broken custom entry is refused where
 * it was entered rather than drawn in the wrong place.
 */
export function checkSession(session, where = 'session') {
  if (!session || typeof session !== 'object') throw new Error(`${where}: must be an object`);
  if (!session.name?.trim()) throw new Error(`${where}: needs a name`);
  if (parseClock(session.start) === null) {
    throw new Error(`${where} "${session.name}": start must be HH:MM, got "${session.start}"`);
  }
  if (parseClock(session.end) === null) {
    throw new Error(`${where} "${session.name}": end must be HH:MM, got "${session.end}"`);
  }
  if (parseClock(session.start) === parseClock(session.end)) {
    throw new Error(`${where} "${session.name}": start and end are the same time`);
  }
  if (!isKnownZone(session.zone)) {
    throw new Error(`${where} "${session.name}": "${session.zone}" is not a known time zone`);
  }
  return true;
}

export function isKnownZone(zone) {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/* One formatter per zone, reused across every bar. Building one costs far more
 * than using it, and a month of 15m bars asks the same question 3000 times. */
const formatters = new Map();

function formatterFor(zone) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour12: false,
    });
    formatters.set(zone, f);
  }
  return f;
}

/**
 * Local wall-clock reading of a timestamp in a zone.
 *
 * Returns minutes past local midnight and a local date stamp. The date is what
 * separates one occurrence of a session from the next; using UTC days instead
 * would split the Tokyo session in half every night.
 */
export function localReading(timeMs, zone) {
  const parts = formatterFor(zone).formatToParts(new Date(timeMs));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  // Some locales render midnight as 24; both mean the same instant.
  const hour = Number(get('hour')) % 24;
  return {
    minutes: hour * 60 + Number(get('minute')),
    day: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/** Whether a local time falls inside a window, wrapping over midnight if it must. */
export function inWindow(minutes, start, end) {
  // A window that ends before it starts runs through midnight — Asia, mostly.
  return start <= end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

/**
 * Session occurrences over the given bars.
 *
 * @param {Array<{time,open,high,low,close}>} bars  ascending, times in ms
 * @param {object} [params]
 * @param {'futures'|'forex'|'custom'} [params.preset='futures']
 * @param {Array<object>} [params.custom]  used when preset is 'custom'
 * @param {number} [params.days=0]  only the last N days of sessions; 0 = all
 */
export function computeSessions(bars, params = {}) {
  const { preset = 'futures', custom = [], days = 0 } = params;
  if (!Array.isArray(bars)) throw new Error('computeSessions: bars must be an array');

  const definitions = preset === 'custom' ? custom : SESSION_PRESETS[preset];
  if (!definitions) {
    throw new Error(`computeSessions: unknown preset "${preset}". `
      + `Known: ${Object.keys(SESSION_PRESETS).join(', ')}, custom`);
  }
  definitions.forEach((s, i) => checkSession(s, `session ${i + 1}`));
  if (bars.length === 0) return { sessions: [] };

  /* Start where the answer can still matter. Reading a wall clock costs an Intl
   * lookup per bar per session, so scanning three years to draw the last five
   * days is most of the work thrown away — 3000 bars took 81ms, the window
   * behind `days` takes a fraction of that. A day of slack on the left keeps a
   * session that began before the cutoff whole. */
  const first = days > 0
    ? firstIndexAfter(bars, bars[bars.length - 1].time - (days + 1) * 86_400_000)
    : 0;

  const out = [];

  for (const definition of definitions) {
    const start = parseClock(definition.start);
    const end = parseClock(definition.end);
    let open = null;

    for (let i = first; i < bars.length; i++) {
      const bar = bars[i];
      const { minutes, day } = localReading(bar.time, definition.zone);
      const inside = inWindow(minutes, start, end);

      /* A session is keyed by the local day it *started* on, so one that runs
       * past midnight stays a single block instead of breaking at 00:00. */
      if (inside && open && open.day === dayKeyFor(day, minutes, start, end)) {
        open.endIndex = i;
        open.endTime = bar.time;
        open.high = Math.max(open.high, bar.high);
        open.low = Math.min(open.low, bar.low);
        continue;
      }

      if (open) {
        out.push(open);
        open = null;
      }
      if (!inside) continue;

      open = {
        name: definition.name,
        color: definition.color ?? 'ind-1',
        zone: definition.zone,
        day: dayKeyFor(day, minutes, start, end),
        startIndex: i,
        endIndex: i,
        startTime: bar.time,
        endTime: bar.time,
        high: bar.high,
        low: bar.low,
      };
    }
    if (open) out.push(open);
  }

  // One list, in the order the sessions opened, whichever market they belong to.
  out.sort((a, b) => a.startIndex - b.startIndex);

  if (days > 0) {
    const cutoff = bars[bars.length - 1].time - days * 86_400_000;
    return { sessions: out.filter((s) => s.endTime >= cutoff) };
  }
  return { sessions: out };
}

/** First bar at or after a timestamp; bars are ascending. */
function firstIndexAfter(bars, timeMs) {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time < timeMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Which local day an occurrence belongs to.
 *
 * For a window that wraps midnight, the hours after midnight belong to the day
 * before — otherwise Tokyo's evening and its small hours count as two separate
 * sessions with a gap between them that never existed.
 */
function dayKeyFor(day, minutes, start, end) {
  if (start <= end || minutes >= start) return day;
  const [y, m, d] = day.split('-').map(Number);
  // Date.UTC normalises day 0 into the last day of the previous month.
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** Parameter schema — the panel builds its controls from this. */
export const SESSION_PARAMS = [
  {
    key: 'preset',
    label: 'Sessions',
    type: 'select',
    default: 'futures',
    hint: 'Which set of sessions to draw. Futures uses the stretches desks watch '
      + 'on index futures; forex uses the four classic centres. Custom lets you '
      + 'define your own below.',
    options: [
      { value: 'futures', label: 'Futures' },
      { value: 'forex', label: 'Forex' },
      { value: 'custom', label: 'Custom' },
    ],
  },
  {
    key: 'custom',
    label: 'Your sessions',
    type: 'sessions',
    default: [],
    hint: 'Your own sessions, each with a name, a time zone and a window in that '
      + 'zone. Times follow the zone through daylight saving, so a session stays '
      + 'put when the clocks change.',
  },
  {
    key: 'days',
    label: 'Last days',
    type: 'number',
    default: 5,
    min: 0,
    max: 365,
    step: 1,
    hint: 'Only draw sessions from the last N days of the loaded data. 0 draws '
      + 'every one of them, which on a long history is a lot of boxes.',
  },
  {
    key: 'extent',
    label: 'Draw as',
    type: 'select',
    default: 'range',
    hint: 'A box around the high and low the session actually reached, or a band '
      + 'spanning the full height of the chart to mark the hours alone.',
    options: [
      { value: 'range', label: 'Session high/low' },
      { value: 'full', label: 'Full height' },
    ],
  },
  {
    key: 'labels',
    label: 'Labels',
    type: 'select',
    default: 'on',
    hint: 'Writes the session name on its box. Worth turning off once you know '
      + 'the colours, or when several sessions overlap.',
    options: [
      { value: 'on', label: 'Show names' },
      { value: 'off', label: 'Hide names' },
    ],
  },
];

/* Time zones offered when defining a session.
 *
 * A curated list, not the full IANA set: there are several hundred of those,
 * and a dropdown of them is unusable. These are the centres sessions are
 * actually named after, plus UTC for anyone who wants fixed hours and no
 * daylight-saving behaviour at all. Any valid IANA name still works if it
 * arrives from a saved layout — `checkSession` accepts the zone, not the list.
 */
export const SESSION_ZONES = [
  { value: 'UTC', label: 'UTC' },
  { value: 'Australia/Sydney', label: 'Sydney' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Asia/Hong_Kong', label: 'Hong Kong' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Asia/Dubai', label: 'Dubai' },
  { value: 'Europe/Berlin', label: 'Frankfurt' },
  { value: 'Europe/London', label: 'London' },
  { value: 'America/New_York', label: 'New York' },
  { value: 'America/Chicago', label: 'Chicago' },
];

/** A blank session to start editing from, placed on a sensible weekday window. */
export function newSession() {
  return {
    name: 'Session', zone: 'UTC', start: '08:00', end: '16:00', color: 'ind-4',
  };
}
