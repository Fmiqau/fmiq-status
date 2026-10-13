// Email notifications to subscribers. Planning is pure and idempotent: every
// message has a key, and keys already in history.sent are never sent again.

import { formatSydney, toDate } from './time.mjs';
import { STATUS_LABELS, isDone } from './notices.mjs';

const STALE_MS = 24 * 3600000; // never email about something that happened more than a day ago
const DAY_MS = 24 * 3600000;

export const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'NOTIFY_FROM', 'NOTIFY_TO'];

/** Returns the SMTP settings when every secret is present, otherwise null. */
export function smtpSettings(env = process.env) {
  if (!SMTP_KEYS.every((k) => env[k] && String(env[k]).trim())) return null;
  const to = String(env.NOTIFY_TO).split(',').map((s) => s.trim()).filter((s) => /^[^\s@<>]+@[^\s@<>]+$/.test(s));
  if (!to.length) return null;
  return {
    host: env.SMTP_HOST.trim(),
    port: Number(env.SMTP_PORT),
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.NOTIFY_FROM.trim(),
    to,
  };
}

/**
 * @returns {{ send: Array<{key, subject, text}>, skip: string[] }}
 * `skip` holds keys that are due but too old to be worth sending. They are
 * recorded as handled so a newly configured mailer does not send a backlog.
 */
export function planNotifications(notices, sent, { now = new Date(), siteUrl } = {}) {
  const send = [];
  const skip = [];
  const due = (key, at, build) => {
    if (sent[key]) return;
    const t = toDate(at);
    if (t && now - t > STALE_MS) { skip.push(key); return; }
    send.push({ key, ...build() });
  };

  for (const n of notices) {
    const id = n.uid;
    if (n.kind === 'incident') {
      due(`incident-open:${id}`, n.createdAt || n.startsAt, () => compose(n, 'open', null, siteUrl));
      const opened = toDate(n.createdAt)?.getTime() ?? 0;
      for (const u of n.updates) {
        if (n.source === 'github' && u.byOwner === false && !u.status) continue;
        if ((toDate(u.createdAt)?.getTime() ?? 0) <= opened + 60000) continue; // first update repeats the opening
        if (isDone(n) && u.status === 'resolved') continue; // covered by the resolution email
        due(`update:${id}:${u.id || u.createdAt}`, u.createdAt, () => compose(n, 'update', u, siteUrl));
      }
      if (isDone(n)) due(`resolved:${id}`, n.resolvedAt || n.updatedAt, () => compose(n, 'resolved', null, siteUrl));
      continue;
    }
    // Maintenance
    if (n.status === 'cancelled') {
      if (sent[`maint-announce:${id}`]) due(`maint-cancelled:${id}`, n.updatedAt, () => compose(n, 'cancelled', null, siteUrl));
      continue;
    }
    if (isDone(n)) continue;
    const start = toDate(n.startsAt);
    const announceKey = `maint-announce:${id}`;
    const remindKey = `maint-remind:${id}`;
    const announcingNow = !sent[announceKey];
    due(announceKey, n.createdAt || n.updatedAt, () => compose(n, 'announce', null, siteUrl));
    if (start && now < start && start - now <= DAY_MS && !sent[remindKey]) {
      // Announced inside the last day: the announcement already serves as the reminder.
      if (announcingNow) skip.push(remindKey);
      else send.push({ key: remindKey, ...compose(n, 'remind', null, siteUrl) });
    }
    for (const u of n.updates) {
      if (u.byOwner === false) continue;
      if ((toDate(u.createdAt)?.getTime() ?? 0) <= (toDate(n.createdAt)?.getTime() ?? 0) + 60000) continue;
      due(`update:${id}:${u.id || u.createdAt}`, u.createdAt, () => compose(n, 'update', u, siteUrl));
    }
  }
  return { send, skip };
}

function timeLine(n, u) {
  if (n.kind === 'maintenance') {
    const s = n.startsAt ? formatSydney(n.startsAt) : 'to be confirmed';
    const e = n.endsAt ? formatSydney(n.endsAt) : 'to be confirmed';
    return `Maintenance window: ${s} to ${e}`;
  }
  if (isDone(n)) return `Resolved: ${formatSydney(n.resolvedAt || n.updatedAt)}`;
  const eta = u?.estimatedRestoreAt || n.estimatedRestoreAt;
  return `Estimated restore time: ${eta ? formatSydney(eta) : 'not yet known. We will update this as soon as we can.'}`;
}

export function compose(n, event, update, siteUrl = 'https://status.fmiqnexus.au') {
  const statusLabel = STATUS_LABELS[update?.status || n.status] || 'Update';
  const subjects = {
    open: `Incident: ${n.title}`,
    update: `${statusLabel}: ${n.title}`,
    resolved: `Resolved: ${n.title}`,
    announce: `Planned maintenance: ${n.title}`,
    remind: `Reminder, maintenance within 24 hours: ${n.title}`,
    cancelled: `Maintenance cancelled: ${n.title}`,
  };
  const message = event === 'update' ? update.message : n.body;
  const lines = [
    n.title,
    '',
    `Status: ${event === 'resolved' ? 'Resolved' : statusLabel}`,
    timeLine(n, update),
  ];
  if (event === 'update') lines.push(`Posted: ${formatSydney(update.createdAt)}`);
  if (message) lines.push('', message);
  lines.push(
    '',
    `Follow updates at ${siteUrl}`,
    '',
    'You receive this because you asked to hear about FMIQ Nexus service notices. Reply to this email to stop.',
  );
  return { subject: `[FMIQ Nexus Status] ${subjects[event]}`, text: lines.join('\n') };
}
