/* How the account is written down.
 *
 * These were copied into every panel that showed a number, and the copies had
 * started to disagree — one of them wrote a loss as $-250.00. The rule is worth
 * stating once: the currency goes in front of the digits and the sign in front
 * of that, so a loss reads −$250.00, which is how money is written down
 * everywhere except in a program that forgot.
 *
 * Only the components written for the trade dock read this so far. The older
 * panels keep their own copies until something else takes them there; a sweep
 * through five files to change nothing anybody can see is not an improvement.
 */

/** An amount of account money, signed, to the cent. */
export function money(value) {
  if (value == null) return '—';
  const digits = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return `${value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString(undefined, digits)}`;
}

/** The same, with a + in front of a gain — for a result rather than a balance. */
export function signedMoney(value) {
  if (value == null) return '—';
  return `${value > 0 ? '+' : ''}${money(value)}`;
}

/**
 * A price.
 *
 * Up to eight decimals because a symbol can cost 0.00001, and never padded,
 * because a price of 94,000 written as 94,000.00000000 is unreadable at the
 * speed these are read at.
 */
export function price(value) {
  if (value == null) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

/**
 * A position size, in base units.
 *
 * Six significant digits and then trimmed: enough for any size anyone types,
 * and it throws away the 0.30000000000000004 that comes out of taking three
 * quarters off a 0.4.
 */
export function units(value) {
  if (value == null) return '—';
  return Number(Number(value).toPrecision(6)).toString();
}

/** A fraction as a percentage. */
export function percent(value, digits = 1) {
  return value == null ? '—' : `${(value * 100).toFixed(digits)}%`;
}

/**
 * A result in R — what the trade made against what it risked.
 *
 * Two decimals, and always signed: R is only ever read as a comparison, and
 * "0.94R" without a sign has to be looked up against the P&L beside it to know
 * which way it went.
 */
export function rMultiple(value, digits = 2) {
  if (value == null) return '—';
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}R`;
}

/** A moment, as date and time to the minute, in UTC like the bars. */
export function stamp(ms) {
  return ms == null ? '—' : new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

/** The same, without the year — for a list where every row is the same week. */
export function shortStamp(ms) {
  return ms == null ? '—' : new Date(ms).toISOString().replace('T', ' ').slice(5, 16);
}
