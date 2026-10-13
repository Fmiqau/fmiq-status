// Notices: incidents and maintenance from the app's status.json and from GitHub issues,
// normalised into one shape and sorted into the sections the page shows.

import { parseTimeInput, toDate, iso } from './time.mjs';

export const BOT_LOGIN = 'github-actions[bot]';
export const AUTO_LABEL = 'auto-detected';
const KINDS = ['incident', 'maintenance'];
const HEADER_KEYS = ['status', 'severity', 'eta', 'window', 'components'];
const MAX_TEXT = 4000;

export const STATUS_LABELS = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  verifying: 'Verifying',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
const DONE = new Set(['resolved', 'completed', 'cancelled']);

export function normStatus(s, kind = 'incident') {
  const v = String(s || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (v === 'canceled') return 'cancelled';
  if (v === 'complete' || v === 'done') return 'completed';
  if (v === 'inprogress' || v === 'underway' || v === 'started') return 'in_progress';
  if (STATUS_LABELS[v]) return v;
  return kind === 'maintenance' ? 'scheduled' : 'investigating';
}

/** S1 to S3, also accepting critical/major/minor words. */
export function normSeverity(s) {
  const v = String(s || '').trim().toLowerCase();
  if (/^(s1|sev1|critical|major|high)$/.test(v)) return 'S1';
  if (/^(s3|sev3|minor|low)$/.test(v)) return 'S3';
  if (/^(s2|sev2|medium|moderate|partial)$/.test(v)) return 'S2';
  return null;
}
export const SEVERITY_LABELS = { S1: 'Major impact', S2: 'Partial impact', S3: 'Minor impact' };

const clean = (s, max = MAX_TEXT) =>
  String(s ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);

/**
 * Read leading `key: value` lines from an issue or comment body.
 * Leading blank lines are skipped. Parsing stops at the first line that is not
 * a known key. The rest is the public message.
 */
export function parseHeader(body, keys = HEADER_KEYS) {
  const lines = clean(body, 20000).split('\n');
  const fields = {};
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  for (; i < lines.length; i++) {
    const m = /^\s*\**([A-Za-z]+)\**\s*:\s*(.*?)\s*$/.exec(lines[i]);
    if (!m || !keys.includes(m[1].toLowerCase())) break;
    fields[m[1].toLowerCase()] = m[2];
  }
  return { fields, message: lines.slice(i).join('\n').trim().slice(0, MAX_TEXT) };
}

export function parseWindow(v) {
  if (!v) return { startsAt: null, endsAt: null };
  const parts = String(v).split(/\s*(?:\/|\bto\b|\buntil\b)\s*/i).filter(Boolean);
  return { startsAt: iso(parseTimeInput(parts[0])), endsAt: iso(parseTimeInput(parts[1])) };
}

export function parseComponents(v) {
  if (!v) return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
}

const loginOf = (x) => String(x?.user?.login || '').toLowerCase();

/** Issues raised by the repo owner, or by this workflow's bot when labelled auto-detected. */
export function isTrustedIssue(issue, owner) {
  if (!issue || issue.pull_request) return false;
  const login = loginOf(issue);
  if (login === BOT_LOGIN) return labelNames(issue).includes(AUTO_LABEL);
  return issue.author_association === 'OWNER' && login === String(owner).toLowerCase();
}

/** Comments that count as public updates: the owner's, and this workflow's own. */
export function isTrustedComment(c, owner) {
  const login = loginOf(c);
  if (login === BOT_LOGIN) return true;
  return c?.author_association === 'OWNER' && login === String(owner).toLowerCase();
}
export const isOwnerComment = (c, owner) =>
  c?.author_association === 'OWNER' && loginOf(c) === String(owner).toLowerCase();

export function labelNames(issue) {
  return (issue?.labels || []).map((l) => String(typeof l === 'string' ? l : l?.name || '').toLowerCase());
}

export function issueKind(issue) {
  const names = labelNames(issue);
  return KINDS.find((k) => names.includes(k)) || null;
}

/** Convert a trusted GitHub issue plus its comments into a notice. */
export function issueToNotice(issue, comments, owner) {
  const kind = issueKind(issue);
  if (!kind || !isTrustedIssue(issue, owner)) return null;
  const { fields, message } = parseHeader(issue.body);
  const win = parseWindow(fields.window);
  const updates = (comments || [])
    .filter((c) => isTrustedComment(c, owner))
    .map((c) => {
      const h = parseHeader(c.body, ['status', 'eta']);
      return {
        id: String(c.id),
        status: h.fields.status ? normStatus(h.fields.status, kind) : null,
        message: h.message,
        estimatedRestoreAt: 'eta' in h.fields ? iso(parseTimeInput(h.fields.eta)) : undefined,
        createdAt: c.created_at,
        byOwner: isOwnerComment(c, owner),
      };
    })
    .filter((u) => u.message || u.status)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  let status = normStatus(fields.status, kind);
  let eta = 'eta' in fields ? iso(parseTimeInput(fields.eta)) : null;
  for (const u of updates) {
    if (u.status) status = u.status;
    if (u.estimatedRestoreAt !== undefined) eta = u.estimatedRestoreAt;
  }
  const closed = issue.state === 'closed';
  if (closed && !DONE.has(status)) status = kind === 'maintenance' ? 'completed' : 'resolved';
  if (!closed && DONE.has(status) && kind === 'incident') status = 'monitoring'; // open issue is not finished
  const last = updates[updates.length - 1];
  return {
    uid: `gh-${issue.number}`,
    source: 'github',
    number: issue.number,
    url: issue.html_url,
    kind,
    severity: normSeverity(fields.severity) || (kind === 'incident' ? 'S2' : null),
    title: clean(issue.title, 200),
    body: message,
    status,
    components: parseComponents(fields.components),
    startsAt: kind === 'maintenance' ? win.startsAt : issue.created_at,
    endsAt: kind === 'maintenance' ? win.endsAt : null,
    estimatedRestoreAt: eta,
    createdAt: issue.created_at,
    updatedAt: last?.createdAt && last.createdAt > issue.updated_at ? last.createdAt : issue.updated_at,
    resolvedAt: closed ? issue.closed_at : null,
    autoDetected: loginOf(issue) === BOT_LOGIN,
    ownerCommentCount: updates.filter((u) => u.byOwner).length,
    updates: updates.map((u) => ({ ...u, estimatedRestoreAt: u.estimatedRestoreAt ?? null })),
  };
}

/** Validate and normalise the app's status.json. Returns null when unusable. */
export function sanitiseAppStatus(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.notices)) return null;
  const notices = [];
  for (const n of data.notices.slice(0, 50)) {
    if (!n || typeof n !== 'object') continue;
    const kind = KINDS.includes(n.kind) ? n.kind : null;
    const title = clean(n.title, 200);
    if (!kind || !title) continue;
    const id = clean(n.id, 80) || title;
    const status = normStatus(n.status, kind);
    const updates = (Array.isArray(n.updates) ? n.updates : []).slice(0, 50)
      .filter((u) => u && typeof u === 'object' && toDate(u.createdAt))
      .map((u, i) => ({
        id: `${i}-${iso(u.createdAt)}`,
        status: u.status ? normStatus(u.status, kind) : null,
        message: clean(u.message),
        estimatedRestoreAt: iso(u.estimatedRestoreAt),
        createdAt: iso(u.createdAt),
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const updatedAt = iso(n.updatedAt) || updates[updates.length - 1]?.createdAt || iso(data.generatedAt);
    notices.push({
      uid: `app-${id.replace(/[^A-Za-z0-9_.-]/g, '_')}`,
      source: 'app',
      kind,
      severity: normSeverity(n.severity) || (kind === 'incident' ? 'S2' : null),
      title,
      body: clean(n.body),
      status,
      components: [],
      startsAt: iso(n.startsAt),
      endsAt: iso(n.endsAt),
      estimatedRestoreAt: iso(n.estimatedRestoreAt),
      createdAt: iso(n.startsAt) || updates[0]?.createdAt || updatedAt,
      updatedAt,
      resolvedAt: DONE.has(status) ? (iso(n.endsAt) && kind === 'incident' ? iso(n.endsAt) : updatedAt) : null,
      updates,
    });
  }
  return { generatedAt: iso(data.generatedAt), notices };
}

export const isDone = (n) => DONE.has(n.status) || !!n.resolvedAt;

/** True when the notice applies to the component (no list means everything). */
export function covers(notice, component) {
  if (!notice.components?.length) return true;
  const want = [component.id, component.name].map((s) => s.toLowerCase());
  return notice.components.some((c) => want.includes(c.toLowerCase()));
}

export function maintenanceInProgress(n, now) {
  if (n.kind !== 'maintenance' || isDone(n)) return false;
  if (n.status === 'in_progress' || n.status === 'verifying') return true;
  const s = toDate(n.startsAt);
  const e = toDate(n.endsAt);
  return !!s && s <= now && (!e || now < e);
}

/**
 * Sort notices into page sections.
 * Resolved incidents stay in "active" for `resolvedHours`, then move to "past"
 * for `pastDays`. Finished maintenance goes straight to "past".
 */
export function classify(notices, { now = new Date(), resolvedHours = 24, pastDays = 30 } = {}) {
  const active = [];
  const maintenanceNow = [];
  const upcoming = [];
  const past = [];
  const recentMs = resolvedHours * 3600000;
  const pastMs = pastDays * 86400000;
  for (const n of notices) {
    const doneAt = toDate(n.resolvedAt) || (isDone(n) ? toDate(n.updatedAt) : null);
    if (n.kind === 'incident') {
      if (!isDone(n)) active.push(n);
      else if (doneAt && now - doneAt < recentMs) active.push(n);
      else if (doneAt && now - doneAt < pastMs) past.push(n);
      continue;
    }
    if (isDone(n)) {
      if (n.status !== 'cancelled' && doneAt && now - doneAt < pastMs) past.push(n);
      continue;
    }
    const end = toDate(n.endsAt);
    if (maintenanceInProgress(n, now)) maintenanceNow.push(n);
    else if (end && end <= now) { if (now - end < pastMs) past.push({ ...n, status: 'completed', resolvedAt: n.endsAt }); }
    else upcoming.push(n);
  }
  const byStart = (a, b) => String(a.startsAt || '').localeCompare(String(b.startsAt || ''));
  const byRecent = (a, b) => String(b.resolvedAt || b.updatedAt || '').localeCompare(String(a.resolvedAt || a.updatedAt || ''));
  active.sort((a, b) => Number(isDone(a)) - Number(isDone(b)) || byRecent(a, b));
  return { active, maintenanceNow: maintenanceNow.sort(byStart), upcoming: upcoming.sort(byStart), past: past.sort(byRecent) };
}

/**
 * The headline. A component that is down outside a maintenance window means a
 * major outage. Maintenance comes next, then any degradation or open incident.
 */
export function overallState(components, sections, now = new Date()) {
  const inMaint = (c) => sections.maintenanceNow.some((m) => covers(m, c));
  const openIncidents = sections.active.filter((n) => !isDone(n));
  const down = components.filter((c) => c.status === 'down' && !inMaint(c));
  if (down.length || openIncidents.some((n) => n.severity === 'S1')) return { state: 'major', label: 'Major outage' };
  if (sections.maintenanceNow.length) return { state: 'maintenance', label: 'Maintenance in progress' };
  if (components.some((c) => c.status === 'degraded' || c.status === 'down') || openIncidents.length)
    return { state: 'degraded', label: 'Some systems degraded' };
  void now;
  return { state: 'ok', label: 'All systems operating' };
}

/** Component status as shown, taking maintenance into account. */
export function displayStatus(component, sections) {
  if (component.status !== 'up' && sections.maintenanceNow.some((m) => covers(m, component))) return 'maintenance';
  return component.status || 'unknown';
}
