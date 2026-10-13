import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyProbe, probeWithRetry } from '../scripts/lib/probe.mjs';
import { recordCheck, prune, dayBars, uptimePercent, emptyHistory, MAX_CHANGES } from '../scripts/lib/history.mjs';
import { formatSydney, sydneyDateKey, parseTimeInput, sydneyZoneName } from '../scripts/lib/time.mjs';
import {
  parseHeader, issueToNotice, isTrustedIssue, sanitiseAppStatus, classify, overallState, parseWindow,
} from '../scripts/lib/notices.mjs';
import { planAutoIncidents, RESTORED_PREFIX } from '../scripts/lib/auto-incident.mjs';
import { planNotifications, smtpSettings } from '../scripts/lib/notify.mjs';
import { buildMessage } from '../scripts/lib/smtp.mjs';

const OWNER = 'Fmiqau';
const t = (s) => new Date(s);
const OK = { ok: true, httpStatus: 200, ms: 120 };
const FAIL = { ok: false, httpStatus: null, ms: 10000, error: 'timeout' };

// ---------- probe state machine ----------

test('one failed run is not an outage, two are', () => {
  let s = applyProbe(null, OK, { now: t('2026-10-13T00:00Z') }).state;
  assert.equal(s.status, 'up');
  const r1 = applyProbe(s, FAIL, { now: t('2026-10-13T00:05Z') });
  assert.equal(r1.state.status, 'up');
  assert.equal(r1.state.consecutiveFailures, 1);
  assert.equal(r1.change, null);
  const r2 = applyProbe(r1.state, FAIL, { now: t('2026-10-13T00:10Z') });
  assert.equal(r2.state.status, 'down');
  assert.deepEqual(r2.change, { at: '2026-10-13T00:10:00.000Z', from: 'up', to: 'down' });
});

test('a blip between good runs never changes state', () => {
  let s = applyProbe(null, OK).state;
  s = applyProbe(s, FAIL).state;
  const r = applyProbe(s, OK);
  assert.equal(r.state.status, 'up');
  assert.equal(r.state.consecutiveFailures, 0);
  assert.equal(r.change, null);
});

test('one good run recovers, and a single failure while down holds down', () => {
  let s = applyProbe(null, OK).state;
  s = applyProbe(s, FAIL).state;
  s = applyProbe(s, FAIL).state;
  assert.equal(s.status, 'down');
  const rec = applyProbe(s, OK, { now: t('2026-10-13T01:00Z') });
  assert.equal(rec.state.status, 'up');
  assert.equal(rec.change.to, 'up');
  assert.equal(rec.state.lastChangeAt, '2026-10-13T01:00:00.000Z');
});

test('degraded components use their own fail status', () => {
  let s = applyProbe(null, OK, { failStatus: 'degraded' }).state;
  s = applyProbe(s, { ok: false, httpStatus: 503, ms: 50 }, { failStatus: 'degraded' }).state;
  s = applyProbe(s, { ok: false, httpStatus: 503, ms: 50 }, { failStatus: 'degraded' }).state;
  assert.equal(s.status, 'degraded');
  assert.equal(s.lastError, 'HTTP 503');
});

test('probe retries up to three times, then reports the last failure', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; return { status: 500, arrayBuffer: async () => new ArrayBuffer(0) }; };
  const r = await probeWithRetry('https://x', { attempts: 3, backoffMs: [1, 1] }, fakeFetch, async () => {});
  assert.equal(calls, 3);
  assert.equal(r.ok, false);
  assert.equal(r.httpStatus, 500);
  let n = 0;
  const flaky = async () => ({ status: ++n === 2 ? 200 : 502, arrayBuffer: async () => new ArrayBuffer(0) });
  const r2 = await probeWithRetry('https://x', { attempts: 3 }, flaky, async () => {});
  assert.equal(r2.ok, true);
  assert.equal(r2.attempts, 2);
  assert.equal(typeof r2.ms, 'number');
});

// ---------- history roll up ----------

test('history rolls checks into Sydney days and charges down minutes', () => {
  let entry;
  let prev = null;
  const runs = [
    ['2026-10-13T00:00Z', OK], ['2026-10-13T00:05Z', FAIL], ['2026-10-13T00:10Z', FAIL], ['2026-10-13T00:15Z', OK],
  ];
  for (const [at, res] of runs) {
    const { state, change } = applyProbe(prev, res, { now: t(at) });
    entry = recordCheck(entry, { prevState: prev, next: state, change, ok: res.ok, now: t(at) });
    prev = { ...state };
  }
  const day = entry.days['2026-10-13'];
  assert.equal(day.checks, 4);
  assert.equal(day.failures, 2);
  assert.equal(day.minutesDown, 10); // 00:05 to 00:10 and 00:10 to 00:15
  assert.equal(entry.changes.length, 2);
  assert.equal(entry.status, 'up');
});

test('history caps long gaps, keeps 20 changes and prunes to 90 days', () => {
  const h = emptyHistory();
  const e = { days: {}, changes: [] };
  for (let i = 0; i < 30; i++) e.changes.push({ at: `x${i}`, from: 'up', to: 'down' });
  e.days['2026-01-01'] = { checks: 1, failures: 0, minutesObserved: 5, minutesDown: 0, minutesDegraded: 0 };
  e.days['2026-10-12'] = { checks: 1, failures: 0, minutesObserved: 5, minutesDown: 0, minutesDegraded: 0 };
  h.components.app = e;
  h.sent.old = '2026-01-01T00:00:00Z';
  h.sent.recent = '2026-10-12T00:00:00Z';
  prune(h, { days: 90, now: t('2026-10-13T00:00Z') });
  assert.equal(e.changes.length, MAX_CHANGES);
  assert.deepEqual(Object.keys(e.days), ['2026-10-12']);
  assert.deepEqual(Object.keys(h.sent), ['recent']);

  const r = recordCheck(undefined, {
    prevState: { status: 'down', lastCheckedAt: '2026-10-13T00:00Z' }, next: { status: 'down' }, change: null, ok: false,
    now: t('2026-10-13T05:00Z'),
  });
  assert.equal(r.days['2026-10-13'].minutesDown, 30);
});

test('uptime and day bars', () => {
  const now = t('2026-10-13T03:00Z');
  const e = { days: { '2026-10-13': { checks: 10, failures: 2, minutesObserved: 1000, minutesDown: 10, minutesDegraded: 0 } } };
  const bars = dayBars(e, { days: 90, now });
  assert.equal(bars.length, 90);
  assert.equal(bars[89].key, '2026-10-13');
  assert.equal(bars[89].level, 'partial');
  assert.equal(bars[0].level, 'none');
  assert.equal(uptimePercent(e, { days: 90, now }), 99);
  assert.equal(uptimePercent({}, { now }), null);
});

// ---------- AEST and AEDT ----------

test('formats Sydney time with the right zone through daylight saving', () => {
  assert.equal(formatSydney('2026-10-13T03:05:00Z'), 'Tue 13 Oct 2026, 2:05 pm AEDT');
  assert.equal(formatSydney('2026-07-01T00:00:00Z'), 'Wed 1 Jul 2026, 10:00 am AEST');
  // DST starts 2:00 am Sun 4 Oct 2026, ends 3:00 am Sun 5 Apr 2026
  assert.equal(sydneyZoneName(t('2026-10-03T15:59:00Z')), 'AEST');
  assert.equal(sydneyZoneName(t('2026-10-03T16:00:00Z')), 'AEDT');
  assert.equal(sydneyZoneName(t('2026-04-04T15:59:00Z')), 'AEDT');
  assert.equal(sydneyZoneName(t('2026-04-04T16:00:00Z')), 'AEST');
  assert.equal(sydneyDateKey('2026-10-12T14:00:00Z'), '2026-10-13'); // 1 am in Sydney next day
  assert.equal(formatSydney('garbage'), '');
});

test('parses typed times as Sydney local or full ISO', () => {
  assert.equal(parseTimeInput('2026-10-13 15:30').toISOString(), '2026-10-13T04:30:00.000Z');
  assert.equal(parseTimeInput('2026-07-01T09:00').toISOString(), '2026-06-30T23:00:00.000Z');
  assert.equal(parseTimeInput('2026-10-13T15:30+11:00').toISOString(), '2026-10-13T04:30:00.000Z');
  assert.equal(parseTimeInput('unknown'), null);
  assert.equal(parseTimeInput('next tuesday'), null);
  const w = parseWindow('2026-10-18 22:00 to 2026-10-19 00:00');
  assert.equal(w.startsAt, '2026-10-18T11:00:00.000Z');
  assert.equal(w.endsAt, '2026-10-18T13:00:00.000Z');
  assert.equal(parseWindow('2026-10-18T22:00+11:00/2026-10-19T00:00+11:00').endsAt, '2026-10-18T13:00:00.000Z');
});

// ---------- issue parsing and owner filtering ----------

const issue = (over = {}) => ({
  number: 1, html_url: 'u', title: 'Slow sign in', state: 'open', user: { login: OWNER }, author_association: 'OWNER',
  labels: [{ name: 'incident' }], created_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T00:00:00Z', closed_at: null,
  body: 'status: identified\nseverity: S1\neta: 2026-10-13 15:30\ncomponents: FMIQ Nexus app, Website\n\nWe know what is wrong.\n\nMore soon.',
  ...over,
});
const comment = (over = {}) => ({ id: 5, user: { login: OWNER }, author_association: 'OWNER', created_at: '2026-10-13T01:00:00Z', body: 'x', ...over });

test('parses key value lines then the public message', () => {
  const { fields, message } = parseHeader('\r\nstatus: Monitoring\r\nETA: unknown\r\n\r\nAll good now.\nstatus: not a header');
  assert.deepEqual(fields, { status: 'Monitoring', eta: 'unknown' });
  assert.equal(message, 'All good now.\nstatus: not a header');
  assert.deepEqual(parseHeader('Just a message').fields, {});
  assert.equal(parseHeader('Note: this is prose').message, 'Note: this is prose');
});

test('issue becomes a notice with fields from body and owner comments', () => {
  const n = issueToNotice(issue(), [
    comment({ body: 'status: monitoring\neta: unknown\n\nFix applied.' }),
    comment({ id: 6, user: { login: 'stranger' }, author_association: 'NONE', body: 'status: resolved\n\nfake' }),
    comment({ id: 7, user: { login: 'collab' }, author_association: 'COLLABORATOR', body: 'status: resolved\n\nnot owner' }),
  ], OWNER);
  assert.equal(n.kind, 'incident');
  assert.equal(n.severity, 'S1');
  assert.deepEqual(n.components, ['FMIQ Nexus app', 'Website']);
  assert.equal(n.body, 'We know what is wrong.\n\nMore soon.');
  assert.equal(n.updates.length, 1);
  assert.equal(n.status, 'monitoring');
  assert.equal(n.estimatedRestoreAt, null); // eta: unknown in the update clears it
});

test('only the owner (or the workflow bot with auto-detected) can raise notices', () => {
  assert.equal(isTrustedIssue(issue(), OWNER), true);
  assert.equal(isTrustedIssue(issue({ user: { login: 'stranger' }, author_association: 'NONE' }), OWNER), false);
  assert.equal(isTrustedIssue(issue({ author_association: 'COLLABORATOR' }), OWNER), false);
  assert.equal(isTrustedIssue(issue({ user: { login: 'github-actions[bot]' }, author_association: 'NONE' }), OWNER), false);
  assert.equal(isTrustedIssue(issue({ user: { login: 'github-actions[bot]' }, labels: [{ name: 'incident' }, { name: 'auto-detected' }] }), OWNER), true);
  assert.equal(isTrustedIssue(issue({ pull_request: {} }), OWNER), false);
  assert.equal(issueToNotice(issue({ user: { login: 'stranger' }, author_association: 'NONE' }), [], OWNER), null);
  assert.equal(issueToNotice(issue({ labels: [{ name: 'bug' }] }), [], OWNER), null);
});

test('closed issue is resolved for 24 hours, then in the past list for 30 days', () => {
  const closed = issueToNotice(issue({ state: 'closed', closed_at: '2026-10-13T02:00:00Z' }), [], OWNER);
  assert.equal(closed.status, 'resolved');
  let s = classify([closed], { now: t('2026-10-13T10:00Z') });
  assert.equal(s.active.length, 1);
  s = classify([closed], { now: t('2026-10-15T10:00Z') });
  assert.equal(s.active.length, 0);
  assert.equal(s.past.length, 1);
  s = classify([closed], { now: t('2026-11-20T10:00Z') });
  assert.equal(s.past.length, 0);
});

test('maintenance window from the issue body, and overall state', () => {
  const m = issueToNotice(issue({ labels: [{ name: 'maintenance' }], body: 'window: 2026-10-18 22:00 to 2026-10-19 00:00\n\nDatabase upgrade.' }), [], OWNER);
  assert.equal(m.status, 'scheduled');
  let s = classify([m], { now: t('2026-10-13T00:00Z') });
  assert.equal(s.upcoming.length, 1);
  s = classify([m], { now: t('2026-10-18T12:00Z') });
  assert.equal(s.maintenanceNow.length, 1);
  const down = [{ id: 'app', name: 'FMIQ Nexus app', status: 'down' }];
  assert.equal(overallState(down, s).state, 'maintenance');
  const none = classify([], {});
  assert.equal(overallState(down, none).label, 'Major outage');
  assert.equal(overallState([{ id: 'a', name: 'a', status: 'degraded' }], none).label, 'Some systems degraded');
  assert.equal(overallState([{ id: 'a', name: 'a', status: 'up' }], none).label, 'All systems operating');
});

test('app status.json tolerates garbage', () => {
  assert.equal(sanitiseAppStatus(null), null);
  assert.equal(sanitiseAppStatus('<html>'), null);
  assert.equal(sanitiseAppStatus({ notices: 'x' }), null);
  const r = sanitiseAppStatus({ generatedAt: 'x', notices: [1, null, { kind: 'bad', title: 't' }, { kind: 'incident', title: '<b>T</b>', status: 'Identified', updates: [{ createdAt: 'nope' }] }] });
  assert.equal(r.notices.length, 1);
  assert.equal(r.notices[0].status, 'identified');
  assert.equal(r.notices[0].updates.length, 0);
});

// ---------- automatic incident ----------

const comps = (status) => [
  { id: 'app', name: 'FMIQ Nexus app', status, autoIncident: true, lastChangeAt: '2026-10-13T02:00:00Z' },
  { id: 'data', name: 'Sign in and data', status: 'up', autoIncident: false },
];
const autoIssue = (over = {}, comments = []) =>
  issueToNotice(issue({
    number: 40, user: { login: 'github-actions[bot]' }, author_association: 'NONE', labels: [{ name: 'incident' }, { name: 'auto-detected' }],
    body: 'status: investigating\neta: unknown\ncomponents: FMIQ Nexus app\n\nWe are aware.', ...over,
  }), comments, OWNER);

test('opens one auto incident when down and nothing covers it', () => {
  const a = planAutoIncidents({ components: comps('down'), notices: [], owner: OWNER });
  assert.equal(a.length, 1);
  assert.equal(a[0].type, 'open');
  assert.equal(a[0].title, 'FMIQ Nexus app unavailable');
  assert.deepEqual(a[0].labels, ['incident', 'auto-detected']);
  assert.deepEqual(a[0].assignees, [OWNER]);
  assert.match(a[0].body, /^status: investigating\neta: unknown\ncomponents: FMIQ Nexus app\n\nWe are aware that FMIQ Nexus is not responding/);
  // Idempotent: the open auto issue now covers it.
  assert.deepEqual(planAutoIncidents({ components: comps('down'), notices: [autoIssue()], owner: OWNER }), []);
  // An owner incident without a components line covers everything.
  const ownerIssue = issueToNotice(issue({ body: 'Investigating.' }), [], OWNER);
  assert.deepEqual(planAutoIncidents({ components: comps('down'), notices: [ownerIssue], owner: OWNER }), []);
  // Maintenance in progress suppresses it.
  assert.deepEqual(planAutoIncidents({ components: comps('down'), notices: [], maintenanceNow: [{ components: [] }], owner: OWNER }), []);
});

test('recovery comments once and closes only when there are no owner comments', () => {
  const a = planAutoIncidents({ components: comps('up'), notices: [autoIssue()], owner: OWNER });
  assert.deepEqual(a.map((x) => x.type), ['comment', 'close']);
  assert.match(a[0].body, /Service restored at Tue 13 Oct 2026, 1:00 pm AEDT\. Monitoring\./);

  const restored = { id: 1, user: { login: 'github-actions[bot]' }, author_association: 'NONE', created_at: '2026-10-13T02:05:00Z', body: a[0].body };
  // Close failed last time: do not comment again, just close.
  assert.deepEqual(planAutoIncidents({ components: comps('up'), notices: [autoIssue({}, [restored])], owner: OWNER }).map((x) => x.type), ['close']);
  // Owner has commented: comment restored but leave it open for the owner.
  const ownerC = comment({ id: 2, created_at: '2026-10-13T01:30:00Z', body: 'status: identified\n\nDatabase restarting.' });
  assert.deepEqual(planAutoIncidents({ components: comps('up'), notices: [autoIssue({}, [ownerC])], owner: OWNER }).map((x) => x.type), ['comment']);
  assert.deepEqual(planAutoIncidents({ components: comps('up'), notices: [autoIssue({}, [ownerC, restored])], owner: OWNER }), []);
  // Goes down again while still open after restore: one recurrence comment.
  const again = planAutoIncidents({ components: comps('down'), notices: [autoIssue({}, [ownerC, restored])], owner: OWNER });
  assert.deepEqual(again.map((x) => x.type), ['comment']);
  assert.match(again[0].body, /^status: investigating/);
  // Never touches owner issues.
  const ownerIssue = issueToNotice(issue({ body: 'components: FMIQ Nexus app\n\nx' }), [], OWNER);
  assert.deepEqual(planAutoIncidents({ components: comps('up'), notices: [ownerIssue], owner: OWNER }), []);
});

// ---------- email ----------

test('email plan is idempotent and covers each event', () => {
  const now = t('2026-10-13T03:00Z');
  const inc = issueToNotice(issue({ created_at: '2026-10-13T02:00:00Z' }), [comment({ created_at: '2026-10-13T02:30:00Z', body: 'status: monitoring\n\nFixed.' })], OWNER);
  const sent = {};
  const p1 = planNotifications([inc], sent, { now, siteUrl: 'https://status.fmiqnexus.au' });
  assert.deepEqual(p1.send.map((m) => m.key), ['incident-open:gh-1', 'update:gh-1:5']);
  assert.match(p1.send[0].text, /Estimated restore time: Tue 13 Oct 2026, 3:30 pm AEDT/);
  assert.match(p1.send[0].text, /https:\/\/status\.fmiqnexus\.au/);
  for (const m of p1.send) sent[m.key] = now.toISOString();
  assert.equal(planNotifications([inc], sent, { now }).send.length, 0);

  const done = issueToNotice(issue({ created_at: '2026-10-13T02:00:00Z', state: 'closed', closed_at: '2026-10-13T02:50:00Z' }), [], OWNER);
  const p2 = planNotifications([done], sent, { now });
  assert.deepEqual(p2.send.map((m) => m.key), ['resolved:gh-1']);
});

test('maintenance announcement, 24 hour reminder, and stale events skipped', () => {
  const m = issueToNotice(issue({ labels: [{ name: 'maintenance' }], created_at: '2026-10-12T00:00:00Z', body: 'window: 2026-10-18 22:00 to 2026-10-19 00:00\n\nUpgrade.' }), [], OWNER);
  const sent = {};
  let p = planNotifications([m], sent, { now: t('2026-10-12T01:00Z') });
  assert.deepEqual(p.send.map((x) => x.key), ['maint-announce:gh-1']);
  assert.match(p.send[0].text, /Maintenance window: Sun 18 Oct 2026, 10:00 pm AEDT to Mon 19 Oct 2026, 12:00 am AEDT/);
  sent['maint-announce:gh-1'] = 'x';
  p = planNotifications([m], sent, { now: t('2026-10-15T00:00Z') });
  assert.equal(p.send.length, 0);
  p = planNotifications([m], sent, { now: t('2026-10-17T12:00Z') });
  assert.deepEqual(p.send.map((x) => x.key), ['maint-remind:gh-1']);
  sent['maint-remind:gh-1'] = 'x';
  assert.equal(planNotifications([m], sent, { now: t('2026-10-17T13:00Z') }).send.length, 0);

  // A first run with old history sends nothing and records the backlog as handled.
  const old = issueToNotice(issue({ created_at: '2026-09-01T00:00:00Z' }), [], OWNER);
  const p3 = planNotifications([old], {}, { now: t('2026-10-13T00:00Z') });
  assert.equal(p3.send.length, 0);
  assert.deepEqual(p3.skip, ['incident-open:gh-1']);
});

test('smtp settings need every secret, and messages blind copy subscribers', () => {
  const env = { SMTP_HOST: 'h', SMTP_PORT: '465', SMTP_USER: 'u', SMTP_PASS: 'p', NOTIFY_FROM: 'Status <s@fmiqnexus.au>', NOTIFY_TO: 'a@x.au, b@y.au' };
  assert.deepEqual(smtpSettings(env).to, ['a@x.au', 'b@y.au']);
  assert.equal(smtpSettings({ ...env, SMTP_PASS: '' }), null);
  assert.equal(smtpSettings({}), null);
  const msg = buildMessage({ from: env.NOTIFY_FROM, subject: 'Résolu', text: 'hi' });
  assert.match(msg, /^To: Status <s@fmiqnexus\.au>\r$/m);
  assert.doesNotMatch(msg, /a@x\.au/);
  assert.match(msg, /Subject: =\?UTF-8\?B\?/);
});
