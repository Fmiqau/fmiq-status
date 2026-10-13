// Time helpers. All public times are printed in Sydney time (AEST or AEDT).

export const TZ = 'Australia/Sydney';

const offsetFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, timeZoneName: 'longOffset' });
// Numeric parts only, with our own names, so output does not drift between ICU versions.
const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
});
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function toDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Sydney UTC offset in minutes at the given instant (600 for AEST, 660 for AEDT). */
export function sydneyOffsetMinutes(date) {
  const name = offsetFmt.formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || 'GMT+10:00';
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return 600;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

export function sydneyZoneName(date) {
  return sydneyOffsetMinutes(date) === 660 ? 'AEDT' : 'AEST';
}

/** "Tue 13 Oct 2026, 2:05 pm AEDT" */
export function formatSydney(input) {
  const date = toDate(input);
  if (!date) return '';
  const p = Object.fromEntries(partsFmt.formatToParts(date).map((x) => [x.type, Number(x.value)]));
  const h24 = p.hour % 24;
  const h12 = h24 % 12 || 12;
  const dow = DAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
  return `${dow} ${p.day} ${MONTHS[p.month - 1]} ${p.year}, ${h12}:${String(p.minute).padStart(2, '0')} ${h24 < 12 ? 'am' : 'pm'} ${sydneyZoneName(date)}`;
}

/** Calendar day in Sydney, as YYYY-MM-DD. */
export function sydneyDateKey(input) {
  const date = toDate(input);
  if (!date) return '';
  const p = Object.fromEntries(partsFmt.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month.padStart(2, '0')}-${p.day.padStart(2, '0')}`;
}

/** "Tue 13 Oct 2026" for a YYYY-MM-DD key. */
export function formatDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
}

/** Shift a YYYY-MM-DD key by n days. */
export function addDaysToKey(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n, 12));
  return t.toISOString().slice(0, 10);
}

/** Convert a wall clock time in Sydney to a UTC Date. */
export function sydneyLocalToDate(y, mo, d, h = 0, mi = 0) {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  let guess = new Date(naive - 600 * 60000);
  for (let i = 0; i < 3; i++) {
    const next = new Date(naive - sydneyOffsetMinutes(guess) * 60000);
    if (next.getTime() === guess.getTime()) break;
    guess = next;
  }
  return guess;
}

/**
 * Parse a time typed by a person. Accepts full ISO with zone, or a local
 * Sydney time like "2026-10-14 15:30" or "2026-10-14T15:30". Returns null for
 * "unknown", blanks and anything unreadable.
 */
export function parseTimeInput(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || /^(unknown|tbc|tba|n\/a|none|-)$/i.test(s)) return null;
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/.exec(s);
  if (local) {
    const [, y, mo, d, h, mi] = local;
    return sydneyLocalToDate(+y, +mo, +d, +(h || 0), +(mi || 0));
  }
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return toDate(s);
  return null;
}

export function iso(d) {
  const x = toDate(d);
  return x ? x.toISOString() : null;
}
