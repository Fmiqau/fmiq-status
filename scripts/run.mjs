#!/usr/bin/env node
// One monitor run: probe, update history, read notices, manage the automatic
// incident, send emails, render the site. Designed to never fail the job for a
// soft problem: the page must always be published.
//
// Environment:
//   DATA_DIR      folder holding history.json (status-data branch), default ./data
//   OUT_DIR       folder for the built site, default ./_site
//   SKIP_PROBES   "true" to reuse the last results (issue events)
//   GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_REPOSITORY_OWNER
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, NOTIFY_FROM, NOTIFY_TO (optional)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeWithRetry, applyProbe } from './lib/probe.mjs';
import { normaliseHistory, recordCheck, prune } from './lib/history.mjs';
import { sanitiseAppStatus, issueToNotice, issueKind, isTrustedIssue, classify } from './lib/notices.mjs';
import { planAutoIncidents } from './lib/auto-incident.mjs';
import { planNotifications, smtpSettings } from './lib/notify.mjs';
import { sendMail } from './lib/smtp.mjs';
import { github } from './lib/github.mjs';
import { buildModel, renderHtml, renderJson, renderFeed } from './lib/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.log('[status]', ...a);
const warn = (...a) => console.warn('::warning::', ...a);

export async function loadConfig(file = path.join(ROOT, 'status.config.json')) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function writeSite(outDir, model) {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'index.html'), renderHtml(model));
  await fs.writeFile(path.join(outDir, 'status.json'), renderJson(model));
  await fs.writeFile(path.join(outDir, 'feed.xml'), renderFeed(model));
  await fs.writeFile(path.join(outDir, '.nojekyll'), '');
  await fs.copyFile(path.join(ROOT, 'CNAME'), path.join(outDir, 'CNAME')).catch(() => {});
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

async function fetchAppStatus(url) {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'FMIQ-Nexus-Status/1.0' }, signal: AbortSignal.timeout(10000), cache: 'no-store' });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const text = await res.text();
    if (text.length > 1_000_000) return { error: 'too large' };
    const data = sanitiseAppStatus(JSON.parse(text));
    return data ? { data } : { error: 'unexpected shape' };
  } catch (err) {
    return { error: err?.name === 'TimeoutError' ? 'timeout' : String(err?.message || err).slice(0, 120) };
  }
}

async function loadGithubNotices(gh, owner, now, pastDays) {
  const since = new Date(now.getTime() - (pastDays + 2) * 86400000).toISOString();
  const issues = (await gh.listIssues(since)).filter((i) => issueKind(i) && isTrustedIssue(i, owner));
  const notices = [];
  for (const issue of issues) {
    const comments = issue.comments > 0 ? await gh.listComments(issue.number) : [];
    const n = issueToNotice(issue, comments, owner);
    if (n) notices.push(n);
  }
  return notices;
}

async function main() {
  const now = new Date();
  const config = await loadConfig();
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
  const outDir = path.resolve(process.env.OUT_DIR || path.join(ROOT, '_site'));
  const historyFile = path.join(dataDir, 'history.json');
  const history = normaliseHistory(await readJson(historyFile));
  const owner = config.owner || process.env.GITHUB_REPOSITORY_OWNER || '';
  const repo = process.env.GITHUB_REPOSITORY || '';
  const token = process.env.GITHUB_TOKEN || '';
  const skipProbes = String(process.env.SKIP_PROBES || '').toLowerCase() === 'true' && history.lastRunAt;

  // 1. Probes
  if (!skipProbes) {
    const p = config.probe || {};
    const results = await Promise.all(config.components.map((c) => probeWithRetry(c.url, p)));
    config.components.forEach((c, i) => {
      const prevState = history.components[c.id] ? { ...history.components[c.id] } : null;
      const { state, change } = applyProbe(prevState, results[i], { failStatus: c.failStatus || 'down', threshold: p.failuresBeforeChange ?? 2, now });
      history.components[c.id] = recordCheck(history.components[c.id], { prevState, next: state, change, ok: results[i].ok, now });
      log(`${c.id}: ${results[i].ok ? 'ok' : 'fail'} ${results[i].httpStatus ?? results[i].error} ${results[i].ms}ms attempts=${results[i].attempts} -> ${state.status}${change ? ` (was ${change.from})` : ''}`);
    });
    history.lastRunAt = now.toISOString();
  } else {
    log('issue event: reusing the last probe results');
  }

  // 2. Notices from the app, keeping the last good copy
  const app = await fetchAppStatus(config.appStatusUrl);
  if (app.data) history.appNotices = { fetchedAt: now.toISOString(), ...app.data };
  else log(`app status.json not used (${app.error}), keeping last good copy from ${history.appNotices?.fetchedAt || 'never'}`);

  // 3. Notices from GitHub issues, keeping the last good copy
  const gh = token && repo ? github({ token, repo }) : null;
  let ghNotices = history.githubNotices?.notices || [];
  if (gh) {
    try {
      ghNotices = await loadGithubNotices(gh, owner, now, config.pastNoticeDays ?? 30);
      history.githubNotices = { fetchedAt: now.toISOString(), notices: ghNotices };
    } catch (err) {
      warn(`Could not read GitHub issues: ${err.message}`);
    }
  }

  // 4. Automatic incident
  if (gh && owner) {
    const comps = config.components.map((c) => ({ ...c, ...(history.components[c.id] || {}), id: c.id, name: c.name }));
    const sections = classify([...ghNotices, ...(history.appNotices?.notices || [])], { now });
    const actions = planAutoIncidents({ components: comps, notices: ghNotices, maintenanceNow: sections.maintenanceNow, owner, now });
    let changed = false;
    for (const a of actions) {
      try {
        if (a.type === 'open') {
          await gh.ensureLabel('incident', 'B42318', 'Public incident on the status page');
          await gh.ensureLabel('auto-detected', '279CBE', 'Opened automatically by the status monitor');
          await gh.ensureLabel('maintenance', '1F4E79', 'Planned maintenance on the status page');
          const issue = await gh.createIssue({ title: a.title, body: a.body, labels: a.labels, assignees: a.assignees }).catch(async (err) => {
            warn(`Create with assignee failed, retrying without: ${err.message}`);
            return gh.createIssue({ title: a.title, body: a.body, labels: a.labels });
          });
          log(`opened incident #${issue.number}: ${a.title}`);
        } else if (a.type === 'comment') {
          await gh.comment(a.number, a.body);
          log(`commented on #${a.number}`);
        } else if (a.type === 'close') {
          await gh.close(a.number);
          log(`closed #${a.number}`);
        }
        changed = true;
      } catch (err) {
        warn(`Auto incident action ${a.type} failed: ${err.message}`);
      }
    }
    if (changed) {
      try {
        ghNotices = await loadGithubNotices(gh, owner, now, config.pastNoticeDays ?? 30);
        history.githubNotices = { fetchedAt: now.toISOString(), notices: ghNotices };
      } catch (err) {
        warn(`Could not refresh GitHub issues: ${err.message}`);
      }
    }
  }

  const notices = [...ghNotices, ...(history.appNotices?.notices || [])];

  // 5. Email
  const smtp = smtpSettings();
  const plan = planNotifications(notices, history.sent, { now, siteUrl: config.siteUrl });
  for (const key of plan.skip) history.sent[key] = now.toISOString();
  if (smtp && plan.send.length) {
    for (const m of plan.send) {
      try {
        await sendMail(smtp, m);
        history.sent[m.key] = new Date().toISOString();
        log(`emailed: ${m.key}`);
      } catch (err) {
        warn(`Email ${m.key} failed, will retry next run: ${err.message}`);
      }
    }
  } else if (plan.send.length) {
    log(`email not configured, ${plan.send.length} notification(s) not sent`);
  }

  // 6. Save and render
  prune(history, { days: config.historyDays || 90, now });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(historyFile, `${JSON.stringify(history, null, 1)}\n`);
  const model = buildModel({ config, history, notices, now });
  await writeSite(outDir, model);
  log(`overall: ${model.overall.label}. Site written to ${outDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
