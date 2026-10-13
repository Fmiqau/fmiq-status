#!/usr/bin/env node
// Renders the page from fixture data into fixtures/preview.html so the design
// can be reviewed without running the monitor. Deterministic: fixed clock.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseHistory } from './lib/history.mjs';
import { issueToNotice, sanitiseAppStatus } from './lib/notices.mjs';
import { addDaysToKey, sydneyDateKey } from './lib/time.mjs';
import { buildModel, renderHtml, renderJson, renderFeed } from './lib/render.mjs';
import { loadConfig } from './run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'fixtures');

export async function fixtureModel() {
  const sample = JSON.parse(await fs.readFile(path.join(FIX, 'sample.json'), 'utf8'));
  const config = await loadConfig();
  const now = new Date(sample.now);
  const history = normaliseHistory({ lastRunAt: sample.now, components: {} });

  // Synthesise 90 days of history from the compact per component day patterns.
  const today = sydneyDateKey(now);
  for (const [id, spec] of Object.entries(sample.components)) {
    const days = {};
    for (let i = 0; i < 90; i++) {
      const key = addDaysToKey(today, -i);
      if (i >= spec.daysOfData) continue;
      const down = spec.downDays?.[i] ?? 0;
      const degraded = spec.degradedDays?.[i] ?? 0;
      days[key] = { checks: 288, failures: Math.ceil(down / 5), minutesObserved: 1440, minutesDown: down, minutesDegraded: degraded };
    }
    history.components[id] = { ...spec.state, lastCheckedAt: sample.now, days, changes: [] };
  }

  const notices = [
    ...sample.issues.map((i) => issueToNotice(i.issue, i.comments, sample.owner)).filter(Boolean),
    ...sanitiseAppStatus(sample.appStatus).notices,
  ];
  return buildModel({ config, history, notices, now });
}

async function main() {
  const model = await fixtureModel();
  await fs.writeFile(path.join(FIX, 'preview.html'), renderHtml(model));
  await fs.writeFile(path.join(FIX, 'preview-status.json'), renderJson(model));
  await fs.writeFile(path.join(FIX, 'preview-feed.xml'), renderFeed(model));
  console.log(`Rendered ${path.join(FIX, 'preview.html')} (${model.overall.label})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
