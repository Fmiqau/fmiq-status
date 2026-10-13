// history.json: the only state the monitor keeps. Lives on the status-data branch.

import { sydneyDateKey, addDaysToKey, toDate } from './time.mjs';

export const MAX_CHANGES = 20;
const MAX_INTERVAL_MIN = 30; // cap so a long GitHub scheduling gap is not all counted as down
const DEFAULT_INTERVAL_MIN = 5;
const SENT_KEEP_DAYS = 120;

export function emptyHistory() {
  return { version: 1, lastRunAt: null, components: {}, appNotices: null, githubNotices: null, sent: {} };
}

export function normaliseHistory(raw) {
  const h = emptyHistory();
  if (!raw || typeof raw !== 'object') return h;
  h.lastRunAt = typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null;
  h.components = raw.components && typeof raw.components === 'object' ? raw.components : {};
  h.appNotices = raw.appNotices && typeof raw.appNotices === 'object' ? raw.appNotices : null;
  h.githubNotices = raw.githubNotices && typeof raw.githubNotices === 'object' ? raw.githubNotices : null;
  h.sent = raw.sent && typeof raw.sent === 'object' ? raw.sent : {};
  return h;
}

/**
 * Roll one check into a component's history entry.
 * `prevState` is the state before this run (it held for the elapsed interval),
 * `next` is the state machine output, `change` any transition.
 */
export function recordCheck(entry, { prevState, next, change, ok, now = new Date() }) {
  const e = entry && typeof entry === 'object' ? entry : {};
  e.days = e.days || {};
  e.changes = Array.isArray(e.changes) ? e.changes : [];
  const last = toDate(prevState?.lastCheckedAt);
  let minutes = DEFAULT_INTERVAL_MIN;
  if (last) minutes = Math.max(0, Math.min(MAX_INTERVAL_MIN, (now - last) / 60000));
  const key = sydneyDateKey(now);
  const day = (e.days[key] = e.days[key] || { checks: 0, failures: 0, minutesObserved: 0, minutesDown: 0, minutesDegraded: 0 });
  day.checks += 1;
  if (!ok) day.failures += 1;
  day.minutesObserved = round1(day.minutesObserved + minutes);
  // The interval since the previous check is charged to the state we now
  // believe held during it: down if either end of the interval was down.
  const held = worst(prevState?.status, next.status);
  if (held === 'down') day.minutesDown = round1(day.minutesDown + minutes);
  else if (held === 'degraded') day.minutesDegraded = round1(day.minutesDegraded + minutes);
  if (change) e.changes = [...e.changes, change].slice(-MAX_CHANGES);
  Object.assign(e, next, { days: e.days, changes: e.changes });
  return e;
}

function worst(a, b) {
  const rank = { down: 3, degraded: 2, up: 1 };
  return (rank[a] || 0) >= (rank[b] || 0) ? a : b;
}
const round1 = (n) => Math.round(n * 10) / 10;

/** Drop days older than `days` and sent keys older than SENT_KEEP_DAYS. */
export function prune(history, { days = 90, now = new Date() } = {}) {
  const cutoff = addDaysToKey(sydneyDateKey(now), -(days - 1));
  for (const c of Object.values(history.components)) {
    if (!c?.days) continue;
    for (const k of Object.keys(c.days)) if (k < cutoff) delete c.days[k];
    if (Array.isArray(c.changes)) c.changes = c.changes.slice(-MAX_CHANGES);
  }
  const sentCutoff = now.getTime() - SENT_KEEP_DAYS * 86400000;
  for (const [k, v] of Object.entries(history.sent)) {
    const t = toDate(v);
    if (!t || t.getTime() < sentCutoff) delete history.sent[k];
  }
  return history;
}

/** Ordered list of the last `days` day keys ending today, each with its stats or null. */
export function dayBars(entry, { days = 90, now = new Date() } = {}) {
  const today = sydneyDateKey(now);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = addDaysToKey(today, -i);
    const d = entry?.days?.[key] || null;
    let level = 'none';
    if (d && d.checks > 0) {
      if (d.minutesDown >= 60) level = 'major';
      else if (d.minutesDown > 0) level = 'partial';
      else if (d.minutesDegraded > 0) level = 'degraded';
      else level = 'ok';
    }
    out.push({ key, stats: d, level });
  }
  return out;
}

/** Uptime percentage over the window, or null when nothing was observed. */
export function uptimePercent(entry, opts) {
  let observed = 0;
  let down = 0;
  for (const b of dayBars(entry, opts)) {
    if (!b.stats) continue;
    observed += b.stats.minutesObserved || 0;
    down += b.stats.minutesDown || 0;
  }
  if (observed <= 0) return null;
  return Math.max(0, Math.min(100, ((observed - down) / observed) * 100));
}

export function formatPercent(p) {
  if (p == null) return 'No data yet';
  if (p >= 100) return '100%';
  return `${(Math.floor(p * 100) / 100).toFixed(2)}%`;
}
