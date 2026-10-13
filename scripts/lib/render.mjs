import { readFileSync } from 'node:fs';
// Builds the page model and renders index.html, status.json and feed.xml.

import crypto from 'node:crypto';
import { formatSydney, formatDayKey, toDate, iso } from './time.mjs';
import { dayBars, uptimePercent, formatPercent } from './history.mjs';
import { classify, overallState, displayStatus, isDone, covers, STATUS_LABELS, SEVERITY_LABELS } from './notices.mjs';

const COMPONENT_LABELS = {
  up: 'Operational',
  degraded: 'Degraded',
  down: 'Not responding',
  maintenance: 'Under maintenance',
  unknown: 'No data yet',
};

export function buildModel({ config, history, notices, now = new Date() }) {
  const days = config.historyDays || 90;
  const sections = classify(notices, { now, resolvedHours: config.resolvedVisibleHours ?? 24, pastDays: config.pastNoticeDays ?? 30 });
  const components = config.components.map((c) => {
    const h = history.components[c.id] || {};
    const base = { id: c.id, name: c.name, status: h.status || 'unknown' };
    return {
      ...base,
      display: displayStatus(base, sections),
      responseMs: h.lastResponseMs ?? null,
      lastCheckedAt: h.lastCheckedAt || null,
      lastChangeAt: h.lastChangeAt || null,
      uptime: uptimePercent(h, { days, now }),
      bars: dayBars(h, { days, now }),
    };
  });
  const overall = overallState(components, sections, now);
  const appFetched = history.appNotices?.fetchedAt || null;
  return { now, generatedAt: now.toISOString(), lastCheckedAt: history.lastRunAt || now.toISOString(), config, days, sections, components, overall, appNoticesFetchedAt: appFetched };
}

// ---------- helpers ----------

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function time(v) {
  const d = toDate(v);
  if (!d) return '';
  return `<time datetime="${esc(d.toISOString())}" data-local>${esc(formatSydney(d))}</time>`;
}

function paragraphs(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  return t.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}

export function duration(from, to) {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b || b < a) return '';
  const mins = Math.round((b - a) / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const part = (n, w) => (n ? `${n} ${w}${n === 1 ? '' : 's'}` : '');
  return [part(d, 'day'), part(h, 'hour'), part(m, 'minute')].filter(Boolean).join(' ') || 'under a minute';
}

const statusLabel = (s) => STATUS_LABELS[s] || 'Update';

function fact(label, valueHtml) {
  return valueHtml ? `<div><dt>${esc(label)}</dt><dd>${valueHtml}</dd></div>` : '';
}

function affects(n, components) {
  if (!n.components?.length) return '';
  const names = components.filter((c) => covers(n, c)).map((c) => c.name);
  return esc((names.length ? names : n.components).join(', '));
}

function noticeArticle(n, components) {
  const done = isDone(n);
  const id = `n-${n.uid}`;
  const facts = [];
  if (n.kind === 'maintenance') {
    facts.push(fact('Window', n.startsAt ? `${time(n.startsAt)} to ${n.endsAt ? time(n.endsAt) : 'to be confirmed'}` : 'To be confirmed'));
  } else {
    facts.push(fact('Started', time(n.startsAt || n.createdAt)));
    if (done) {
      facts.push(fact('Resolved', time(n.resolvedAt || n.updatedAt)));
      const dur = duration(n.startsAt || n.createdAt, n.resolvedAt || n.updatedAt);
      if (dur) facts.push(fact('Duration', esc(dur)));
    } else {
      facts.push(fact('Estimated restore', n.estimatedRestoreAt ? time(n.estimatedRestoreAt) : 'Not yet known. We will update this as soon as we can.'));
    }
  }
  facts.push(fact('Affects', affects(n, components)));
  facts.push(fact('Last updated', time(n.updatedAt)));
  const updates = [...n.updates].reverse().filter((u) => u.message || u.status);
  const timeline = updates.length
    ? `<h4>Updates</h4><ol class="timeline">${updates
        .map(
          (u) => `<li><p class="u-head"><strong>${esc(statusLabel(u.status || n.status))}</strong> ${time(u.createdAt)}</p>${paragraphs(u.message)}${
            u.estimatedRestoreAt && !done ? `<p class="u-eta">Estimated restore ${time(u.estimatedRestoreAt)}</p>` : ''
          }</li>`,
        )
        .join('')}</ol>`
    : '';
  const sev = n.kind === 'incident' && n.severity && !done ? ` <span class="pill pill-sev">${esc(SEVERITY_LABELS[n.severity])}</span>` : '';
  const pillClass = done ? 'ok' : n.kind === 'maintenance' ? 'maint' : n.severity === 'S1' ? 'bad' : 'warn';
  return `<article class="notice notice-${pillClass}" aria-labelledby="${esc(id)}">
<div class="n-head"><h3 id="${esc(id)}">${esc(n.title)}</h3><p class="pills"><span class="pill pill-${pillClass}">${esc(statusLabel(n.status))}</span>${sev}</p></div>
<dl class="facts">${facts.join('')}</dl>
${n.body ? `<div class="n-body">${paragraphs(n.body)}</div>` : ''}
${timeline}
</article>`;
}

function barsHtml(c, days) {
  const counts = { ok: 0, degraded: 0, partial: 0, major: 0, none: 0 };
  for (const b of c.bars) counts[b.level]++;
  const words = [
    [counts.ok, 'with no downtime'],
    [counts.degraded, 'with reduced performance'],
    [counts.partial, 'with some downtime'],
    [counts.major, 'with an hour or more of downtime'],
    [counts.none, 'with no data'],
  ]
    .filter(([n]) => n)
    .map(([n, w]) => `${n} ${n === 1 ? 'day' : 'days'} ${w}`);
  const summary = `Last ${days} days for ${c.name}: ${words.join(', ')}. Uptime ${formatPercent(c.uptime)}.`;
  const tip = (b) => {
    const day = formatDayKey(b.key);
    if (!b.stats) return `${day}: no data`;
    const s = b.stats;
    if (s.minutesDown > 0) return `${day}: about ${Math.round(s.minutesDown)} minutes not responding`;
    if (s.minutesDegraded > 0) return `${day}: about ${Math.round(s.minutesDegraded)} minutes degraded`;
    return `${day}: no downtime`;
  };
  return `<div class="bars" role="img" aria-label="${esc(summary)}">${c.bars
    .map((b) => `<span class="bar bar-${b.level}" title="${esc(tip(b))}"></span>`)
    .join('')}</div>`;
}

function componentItem(c, days) {
  const resp = c.responseMs != null && c.status !== 'unknown' ? `Response time ${c.responseMs} ms` : '';
  return `<li class="component">
<div class="c-head"><h3>${esc(c.name)}</h3><span class="state state-${esc(c.display)}">${esc(COMPONENT_LABELS[c.display] || c.display)}</span></div>
${barsHtml(c, days)}
<div class="c-foot" aria-hidden="true"><span>${days} days ago</span><span>Today</span></div>
<p class="c-meta"><span class="uptime">${esc(formatPercent(c.uptime))} uptime over ${days} days</span>${resp ? `<span>${esc(resp)}</span>` : ''}</p>
</li>`;
}

function pastItem(n) {
  const end = n.resolvedAt || n.updatedAt;
  const what = n.kind === 'maintenance' ? 'Planned maintenance' : 'Incident';
  const dur = duration(n.kind === 'maintenance' ? n.startsAt : n.startsAt || n.createdAt, end);
  return `<li><h3>${esc(n.title)}</h3><p class="p-meta">${what}, ${n.kind === 'maintenance' ? 'completed' : 'resolved'} ${time(end)}${dur ? `. Lasted ${esc(dur)}` : ''}.</p>${
    n.updates.length ? paragraphs(n.updates[n.updates.length - 1].message) : paragraphs(n.body)
  }</li>`;
}

// ---------- page ----------

const CSS = `
:root{--charcoal:#292A29;--cyan:#279CBE;--offwhite:#E3E5E5;--bg:#F4F5F5;--card:#FFFFFF;--text:#292A29;--muted:#555957;--line:#D5D8D8;--head-bg:#292A29;--head-text:#E3E5E5;
--ok:#1D6F38;--ok-bg:#E5F3E9;--warn:#7A4F00;--warn-bg:#FBF0D9;--bad:#A3241A;--bad-bg:#FBE6E4;--maint:#1F4E79;--maint-bg:#E3EDF7;
--bar-ok:#2E9E55;--bar-degraded:#C99A1C;--bar-partial:#D9822B;--bar-major:#C8382D;--bar-none:#C9CDCD;--focus:#279CBE;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#1D1E1D;--card:#292A29;--text:#E3E5E5;--muted:#B4B9B7;--line:#3D3F3D;--head-bg:#141514;--head-text:#E3E5E5;
--ok:#7FD69A;--ok-bg:#1E3325;--warn:#F2C46B;--warn-bg:#3A2F17;--bad:#FF9B91;--bad-bg:#3D211E;--maint:#9CC6EE;--maint-bg:#1C2D3F;
--bar-ok:#4CB872;--bar-degraded:#D9AE3C;--bar-partial:#E59545;--bar-major:#E5564A;--bar-none:#4A4D4B;color-scheme:dark}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:anywhere}
a{color:inherit;text-decoration-thickness:1px;text-underline-offset:3px}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px;border-radius:2px}
.skip{position:absolute;left:-9999px;top:0}
.skip:focus{left:16px;top:8px;background:var(--card);color:var(--text);padding:8px 12px;z-index:9}
.wrap{max-width:860px;margin:0 auto;padding:0 16px}
.site-head{background:var(--head-bg);color:var(--head-text);border-bottom:4px solid var(--cyan)}
.site-head .wrap{display:flex;align-items:center;gap:12px;padding-top:18px;padding-bottom:18px}
.wordmark{height:30px;width:auto;display:block;flex:none}
.site-head h1{display:flex;align-items:center;gap:12px;margin:0;font-size:1.5rem;line-height:1.2;font-weight:700;letter-spacing:.01em}
.site-head h1 .accent{color:var(--cyan)}
main.wrap{padding-top:24px;padding-bottom:8px}
section{margin:0 0 32px}
h2{font-size:1.25rem;margin:0 0 12px}
h3{font-size:1.05rem;margin:0}
h4{font-size:.95rem;margin:16px 0 8px}
.overall{border-radius:10px;padding:20px;border:1px solid var(--line);background:var(--card);border-left:8px solid var(--bar-ok)}
.overall h2{font-size:1.6rem;margin:0 0 4px}
.overall p{margin:0;color:var(--muted)}
.overall-degraded{border-left-color:var(--bar-degraded)}
.overall-major{border-left-color:var(--bar-major)}
.overall-maintenance{border-left-color:var(--maint)}
.notice{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:0 0 14px;border-top:4px solid var(--line)}
.notice-bad{border-top-color:var(--bar-major)}.notice-warn{border-top-color:var(--bar-degraded)}.notice-maint{border-top-color:var(--maint)}.notice-ok{border-top-color:var(--bar-ok)}
.n-head{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:baseline;justify-content:space-between}
.pills{margin:0;display:flex;gap:6px;flex-wrap:wrap}
.pill{display:inline-block;font-size:.85rem;font-weight:600;padding:2px 10px;border-radius:999px;border:1px solid currentColor}
.pill-ok{color:var(--ok);background:var(--ok-bg)}.pill-warn{color:var(--warn);background:var(--warn-bg)}.pill-bad{color:var(--bad);background:var(--bad-bg)}.pill-maint{color:var(--maint);background:var(--maint-bg)}
.pill-sev{color:var(--muted);background:transparent}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px 16px;margin:12px 0}
.facts div{min-width:0}
.facts dt{font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.facts dd{margin:0}
.n-body p,.timeline p{margin:6px 0}
.timeline{list-style:none;margin:0;padding:0 0 0 14px;border-left:2px solid var(--line)}
.timeline li{margin:0 0 12px;position:relative}
.timeline li::before{content:"";position:absolute;left:-21px;top:9px;width:10px;height:10px;border-radius:50%;background:var(--cyan)}
.u-head{margin:0}
.u-head time,.u-eta,.p-meta,.c-meta,.local{color:var(--muted)}
.local{font-size:.9em}
.components{list-style:none;margin:0;padding:0;background:var(--card);border:1px solid var(--line);border-radius:10px}
.component{padding:16px 18px;border-top:1px solid var(--line)}
.component:first-child{border-top:0}
.c-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.state{font-weight:600}
.state-up{color:var(--ok)}.state-degraded{color:var(--warn)}.state-down{color:var(--bad)}.state-maintenance{color:var(--maint)}.state-unknown{color:var(--muted)}
.bars{display:flex;gap:1px;height:34px;align-items:stretch}
.bar{flex:1 1 0;min-width:0;border-radius:1px;background:var(--bar-none)}
@media (min-width:600px){.bars{gap:2px}.bar{border-radius:2px}}
.bar-ok{background:var(--bar-ok)}.bar-degraded{background:var(--bar-degraded)}.bar-partial{background:var(--bar-partial)}.bar-major{background:var(--bar-major)}
.c-foot{display:flex;justify-content:space-between;font-size:.8rem;color:var(--muted);margin-top:4px}
.c-meta{display:flex;flex-wrap:wrap;gap:4px 16px;margin:6px 0 0;font-size:.9rem}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:.85rem;color:var(--muted);margin:10px 0 0;padding:0;list-style:none}
.legend li{display:flex;align-items:center;gap:6px}
.legend .bar{display:inline-block;width:10px;height:14px;flex:none}
.past{list-style:none;margin:0;padding:0}
.past li{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin:0 0 10px}
.past p{margin:4px 0}
.empty{color:var(--muted);margin:0}
.site-foot{border-top:1px solid var(--line);padding:20px 0 32px;color:var(--muted);font-size:.95rem}
.site-foot ul{list-style:none;margin:0 0 8px;padding:0;display:flex;flex-wrap:wrap;gap:8px 20px}
.site-foot a{color:var(--text)}
.site-foot p{margin:4px 0}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`.trim();

const JS = `(function(){try{var tz=Intl.DateTimeFormat().resolvedOptions().timeZone;if(tz&&tz!=="Australia/Sydney"){var f=new Intl.DateTimeFormat(undefined,{weekday:"short",day:"numeric",month:"short",hour:"numeric",minute:"2-digit",timeZoneName:"short"});var ts=document.querySelectorAll("time[data-local]");for(var i=0;i<ts.length;i++){var d=new Date(ts[i].getAttribute("datetime"));if(!isNaN(d)){var s=document.createElement("span");s.className="local";s.textContent=" (your time: "+f.format(d)+")";ts[i].parentNode.insertBefore(s,ts[i].nextSibling);}}}}catch(e){}setTimeout(function(){if(!document.hidden){location.reload();}else{document.addEventListener("visibilitychange",function(){if(!document.hidden){location.reload();}});}},60000);})();`;

// The official FMIQ Nexus wordmark (white, for the charcoal header), from the
// brand files. Inlined as a data URI so the page needs no other file and the
// strict CSP stays as it is.
const WORDMARK = `data:image/svg+xml;base64,${readFileSync(new URL('../../assets/fmiq-nexus-wordmark-white.svg', import.meta.url)).toString('base64')}`;
const MARK = `<img class="wordmark" src="${WORDMARK}" alt="FMIQ Nexus" width="160" height="30">`;
const FAVICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#279CBE"/><path d="M9 23V9h14M9 16h10" fill="none" stroke="#292A29" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>')}`;

const sha = (s) => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;

export function renderHtml(model) {
  const { config, sections, components, overall, days } = model;
  const site = config.siteUrl.replace(/\/$/, '');
  const csp = [
    "default-src 'none'",
    `style-src ${sha(CSS)}`,
    `script-src ${sha(JS)}`,
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  const active = [...sections.active];
  const maint = [...sections.maintenanceNow, ...sections.upcoming];
  const overallDetail =
    overall.state === 'ok'
      ? 'We are not aware of any problems right now.'
      : overall.state === 'maintenance'
        ? 'Planned work is under way. Details are below.'
        : 'Details and the latest updates are below.';

  const legend = `<ul class="legend" aria-label="Key to the daily bars">
<li><span class="bar bar-ok" aria-hidden="true"></span>No downtime</li>
<li><span class="bar bar-degraded" aria-hidden="true"></span>Reduced performance</li>
<li><span class="bar bar-partial" aria-hidden="true"></span>Some downtime</li>
<li><span class="bar bar-major" aria-hidden="true"></span>An hour or more of downtime</li>
<li><span class="bar bar-none" aria-hidden="true"></span>No data</li></ul>`;

  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
<meta name="referrer" content="no-referrer">
<meta name="description" content="Current service status for FMIQ Nexus, with incidents, planned maintenance and uptime over the last ${days} days.">
<meta name="color-scheme" content="light dark">
<title>${esc(overall.label)} | FMIQ Nexus Status</title>
<link rel="icon" href="${esc(FAVICON)}">
<link rel="alternate" type="application/atom+xml" title="FMIQ Nexus Status" href="feed.xml">
<link rel="canonical" href="${esc(site)}/">
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-head"><div class="wrap"><h1>${MARK}<span class="accent">Status</span></h1></div></header>
<main id="main" class="wrap">
<section class="overall overall-${esc(overall.state)}" aria-labelledby="overall-h">
<h2 id="overall-h">${esc(overall.label)}</h2>
<p>${esc(overallDetail)} Last checked ${time(model.lastCheckedAt)}.</p>
</section>
${active.length ? `<section aria-labelledby="active-h"><h2 id="active-h">Current incidents</h2>${active.map((n) => noticeArticle(n, components)).join('\n')}</section>` : ''}
${maint.length ? `<section aria-labelledby="maint-h"><h2 id="maint-h">${sections.maintenanceNow.length ? 'Maintenance' : 'Upcoming maintenance'}</h2>${maint.map((n) => noticeArticle(n, components)).join('\n')}</section>` : ''}
<section aria-labelledby="comp-h">
<h2 id="comp-h">Components</h2>
<ul class="components">${components.map((c) => componentItem(c, days)).join('\n')}</ul>
${legend}
</section>
<section aria-labelledby="past-h">
<h2 id="past-h">Past incidents and maintenance</h2>
${sections.past.length ? `<ul class="past">${sections.past.map(pastItem).join('\n')}</ul>` : `<p class="empty">No incidents or maintenance in the last ${config.pastNoticeDays ?? 30} days.</p>`}
</section>
</main>
<footer class="site-foot"><div class="wrap">
<ul>
<li><a href="feed.xml">Subscribe</a> (Atom feed for any feed reader, Slack or Teams)</li>
<li><a href="${esc(config.websiteUrl)}">fmiqnexus.au</a></li>
<li><a href="status.json">Status data (JSON)</a></li>
</ul>
<p>Last checked ${time(model.lastCheckedAt)}. Times are shown in Sydney time (AEST or AEDT).</p>
<p>This page checks FMIQ Nexus from outside our own hosting every few minutes. It runs on hosting separate from FMIQ Nexus, so it should stay available during an outage.</p>
</div></footer>
<script>${JS}</script>
</body>
</html>
`;
}

// ---------- machine readable ----------

function noticeJson(n) {
  return {
    id: n.uid,
    source: n.source,
    url: n.url || null,
    kind: n.kind,
    severity: n.severity,
    title: n.title,
    body: n.body,
    status: n.status,
    components: n.components,
    startsAt: n.startsAt,
    endsAt: n.endsAt,
    estimatedRestoreAt: n.estimatedRestoreAt,
    updatedAt: n.updatedAt,
    resolvedAt: n.resolvedAt,
    updates: n.updates.map((u) => ({ status: u.status, message: u.message, estimatedRestoreAt: u.estimatedRestoreAt, createdAt: u.createdAt })),
  };
}

export function renderJson(model) {
  return JSON.stringify(
    {
      generatedAt: model.generatedAt,
      lastCheckedAt: model.lastCheckedAt,
      page: model.config.siteUrl,
      overall: model.overall,
      components: model.components.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.display,
        responseMs: c.responseMs,
        lastCheckedAt: c.lastCheckedAt,
        lastChangeAt: c.lastChangeAt,
        uptimePercent: c.uptime == null ? null : Math.round(c.uptime * 1000) / 1000,
        uptimeDays: model.days,
      })),
      incidents: model.sections.active.map(noticeJson),
      maintenance: [...model.sections.maintenanceNow, ...model.sections.upcoming].map(noticeJson),
      past: model.sections.past.map(noticeJson),
    },
    null,
    2,
  );
}

const xml = (s) => esc(s).replace(/&#39;/g, '&apos;');

export function renderFeed(model) {
  const site = model.config.siteUrl.replace(/\/$/, '');
  const { sections } = model;
  const all = [...sections.active, ...sections.maintenanceNow, ...sections.upcoming, ...sections.past];
  const entries = [];
  for (const n of all) {
    const what = n.kind === 'maintenance' ? 'Planned maintenance' : 'Incident';
    const when = n.kind === 'maintenance'
      ? `Window: ${n.startsAt ? formatSydney(n.startsAt) : 'to be confirmed'} to ${n.endsAt ? formatSydney(n.endsAt) : 'to be confirmed'}`
      : `Estimated restore time: ${n.estimatedRestoreAt ? formatSydney(n.estimatedRestoreAt) : 'not yet known'}`;
    entries.push({
      id: `${n.uid}:open`,
      title: `${what}: ${n.title}`,
      updated: iso(n.createdAt) || iso(n.startsAt) || model.generatedAt,
      text: `${statusLabel(n.kind === 'maintenance' ? 'scheduled' : 'investigating')}. ${when}.\n\n${n.body}`.trim(),
    });
    for (const u of n.updates) {
      if (!u.message && !u.status) continue;
      entries.push({
        id: `${n.uid}:${u.id || u.createdAt}`,
        title: `${statusLabel(u.status || n.status)}: ${n.title}`,
        updated: iso(u.createdAt) || model.generatedAt,
        text: `${u.message}${u.estimatedRestoreAt && !isDone(n) ? `\n\nEstimated restore time: ${formatSydney(u.estimatedRestoreAt)}` : ''}`,
      });
    }
    if (isDone(n) && !n.updates.some((u) => u.status === 'resolved' || u.status === 'completed')) {
      entries.push({
        id: `${n.uid}:done`,
        title: `${n.kind === 'maintenance' ? 'Completed' : 'Resolved'}: ${n.title}`,
        updated: iso(n.resolvedAt) || iso(n.updatedAt) || model.generatedAt,
        text: `${n.kind === 'maintenance' ? 'Completed' : 'Resolved'} ${formatSydney(n.resolvedAt || n.updatedAt)}.`,
      });
    }
  }
  entries.sort((a, b) => b.updated.localeCompare(a.updated));
  const top = entries.slice(0, 50);
  const updated = top[0]?.updated || model.generatedAt;
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>FMIQ Nexus Status</title>
<subtitle>Incidents and planned maintenance for FMIQ Nexus</subtitle>
<id>${xml(site)}/</id>
<link rel="alternate" type="text/html" href="${xml(site)}/"/>
<link rel="self" type="application/atom+xml" href="${xml(site)}/feed.xml"/>
<updated>${xml(updated)}</updated>
<author><name>FMIQ Nexus</name></author>
${top
  .map(
    (e) => `<entry>
<id>tag:status.fmiqnexus.au,2026:${xml(e.id)}</id>
<title>${xml(e.title)}</title>
<link rel="alternate" type="text/html" href="${xml(site)}/"/>
<updated>${xml(e.updated)}</updated>
<content type="text">${xml(e.text)}</content>
</entry>`,
  )
  .join('\n')}
</feed>
`;
}
