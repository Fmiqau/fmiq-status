// Automatic incidents. Pure planning: returns the GitHub actions to take so the
// logic can be tested without the network. Idempotent because it reads the
// current open issues and their comments every run.

import { covers, isDone, AUTO_LABEL } from './notices.mjs';
import { formatSydney } from './time.mjs';

export const DEFAULT_MESSAGE =
  'We are aware that FMIQ Nexus is not responding and are investigating. Updates will follow here.';
export const RESTORED_PREFIX = 'Service restored at';
export const RECURRED_PREFIX = 'The service stopped responding again at';

function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function autoIssueBody(components) {
  const message = components.length === 1 && components[0].incidentMessage ? components[0].incidentMessage : DEFAULT_MESSAGE;
  return [
    'status: investigating',
    'eta: unknown',
    `components: ${components.map((c) => c.name).join(', ')}`,
    '',
    message,
  ].join('\n');
}

/**
 * @param components  [{ id, name, status, lastChangeAt, autoIncident, incidentMessage }]
 * @param notices     normalised GitHub notices (open and recently closed)
 * @param maintenanceNow  maintenance notices in progress
 * @param owner       repo owner login, used as assignee
 * @returns array of { type: 'open'|'comment'|'close', ... }
 */
export function planAutoIncidents({ components, notices, maintenanceNow = [], owner, now = new Date() }) {
  const actions = [];
  const openIncidents = notices.filter((n) => n.source === 'github' && n.kind === 'incident' && !isDone(n));

  // 1. Open one issue for components that are down and not already covered.
  const uncovered = components.filter(
    (c) =>
      c.autoIncident &&
      c.status === 'down' &&
      !openIncidents.some((n) => covers(n, c)) &&
      !maintenanceNow.some((m) => covers(m, c)),
  );
  if (uncovered.length) {
    actions.push({
      type: 'open',
      title: `${joinNames(uncovered.map((c) => c.name))} unavailable`,
      body: autoIssueBody(uncovered),
      labels: ['incident', AUTO_LABEL],
      assignees: owner ? [owner] : [],
      componentIds: uncovered.map((c) => c.id),
    });
  }

  // 2. Recovery and recurrence on open auto detected issues.
  for (const n of openIncidents.filter((x) => x.autoDetected)) {
    const covered = components.filter((c) => covers(n, c));
    if (!covered.length) continue;
    const lastBot = [...n.updates].reverse().find((u) => !u.byOwner && (u.message.startsWith(RESTORED_PREFIX) || u.message.startsWith(RECURRED_PREFIX)));
    const restoredPosted = !!lastBot && lastBot.message.startsWith(RESTORED_PREFIX);
    const allUp = covered.every((c) => c.status !== 'down');
    if (allUp) {
      if (!restoredPosted) {
        const at = covered.map((c) => c.lastChangeAt).filter(Boolean).sort().pop() || now.toISOString();
        actions.push({ type: 'comment', number: n.number, body: `status: monitoring\n\n${RESTORED_PREFIX} ${formatSydney(at)}. Monitoring.` });
      }
      if (!n.ownerCommentCount) actions.push({ type: 'close', number: n.number });
    } else if (restoredPosted) {
      actions.push({
        type: 'comment',
        number: n.number,
        body: `status: investigating\neta: unknown\n\n${RECURRED_PREFIX} ${formatSydney(now)}. We are investigating. Updates will follow here.`,
      });
    }
  }
  return actions;
}
