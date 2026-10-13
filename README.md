# FMIQ Nexus Status

The public status page for FMIQ Nexus, served at https://status.fmiqnexus.au.

It runs entirely on GitHub Actions and GitHub Pages. It uses nothing from the FMIQ Nexus app except three public URLs, so it keeps working when the app, DigitalOcean and the marketing site are all down. There are no npm dependencies and no paid services.

## How it works

Every five minutes the `Monitor` workflow (`.github/workflows/monitor.yml`):

1. Loads `history.json` from the `status-data` branch (or starts fresh if the branch does not exist yet).
2. Checks each component in `status.config.json`. Each check tries up to 3 times with a short pause between tries and records the response time.
   - **FMIQ Nexus app**: `https://app.fmiqnexus.au/api/live` is up when it answers 200 within 10 seconds.
   - **Sign in and data**: `https://app.fmiqnexus.au/api/health` is up on 200 and degraded on anything else.
   - **Website**: `https://fmiqnexus.au/` is up on 200.
   - A component only changes to down (or degraded) after **2 failed runs in a row**, so one blip is not an outage. One good run brings it straight back.
3. Reads notices from the app at `https://app.fmiqnexus.au/api/status.json`. If that fails or returns something unexpected, the last good copy (kept in `history.json`) is shown instead.
4. Reads notices from GitHub issues in this repo (see below). This is the channel that works when the app is completely down.
5. Opens, comments on and closes the automatic incident when needed.
6. Sends optional emails to subscribers.
7. Writes `index.html`, `status.json` and `feed.xml`, force pushes `history.json` back to `status-data` as a single commit, and deploys the site to GitHub Pages.

Opening, editing, labelling, closing or commenting on an issue also runs the workflow straight away, so a notice appears within a minute or two. Those runs reuse the last check results rather than checking again.

`history.json` holds 90 days of daily figures per component (checks, failures, minutes down, minutes degraded), the last 20 state changes, the last good copy of the app's notices, and the keys of emails already sent.

To change a URL or add a component, edit `status.config.json`. No code changes are needed.

### Automatic incident

When the app or the website has been down for 2 runs and no open incident issue covers it, the workflow opens an issue titled `<component> unavailable`, labelled `incident` and `auto-detected`, and assigns it to the repo owner. GitHub then emails you and pushes a notification to the GitHub mobile app. The public message is:

> We are aware that FMIQ Nexus is not responding and are investigating. Updates will follow here.

When everything it covers is responding again, the workflow comments `Service restored at <time in AEST or AEDT>. Monitoring.` It closes the issue itself only if you have not commented on it. If you have, it leaves it open so you can close it with the cause. It does nothing if planned maintenance covering that component is in progress. All of this is safe to repeat: each run reads the open issues first, so it never opens a duplicate or comments twice.

An incident you open yourself with no `components:` line covers everything, so the workflow will not open a second one beside it.

### Who can post

The repo is public, so anyone can open an issue. Only issues opened by the repo owner (`Fmiqau`, checked by both login and `author_association: OWNER`) appear on the page, plus the workflow's own automatic issues. Comments count as updates only when they come from the owner or the workflow. Anything else is ignored.

## Setting it up

### 1. Publish the repo

Create the public repo `Fmiqau/fmiq-status` under the Fmiqau user account and push `main`.

### 2. Turn on Pages

In the repo: **Settings > Pages**

- **Source**: GitHub Actions
- **Custom domain**: `status.fmiqnexus.au` (the `CNAME` file sets this too)
- Tick **Enforce HTTPS** once GitHub has issued the certificate. This can take up to an hour after the DNS record is in place.

Then run the workflow once by hand: **Actions > Monitor > Run workflow**. The first run creates the `status-data` branch.

### 3. Add one DNS record in Cloudflare

In the Cloudflare dashboard for `fmiqnexus.au`, **DNS > Records > Add record**:

| Type  | Name   | Target              | Proxy status          |
|-------|--------|---------------------|-----------------------|
| CNAME | status | fmiqau.github.io    | DNS only (grey cloud) |

It must be **DNS only**. With the orange cloud on, GitHub cannot issue the HTTPS certificate.

### 4. Labels

The workflow creates the `incident`, `maintenance` and `auto-detected` labels the first time it opens an automatic incident. To post your own notice before then, create the `incident` and `maintenance` labels under **Issues > Labels**.

### 5. Notifications on your phone

Sign in to the GitHub mobile app as Fmiqau and turn on push notifications for issues assigned to you. Automatic incidents are assigned to the owner, which is what triggers the push.

## Posting from the GitHub mobile app

1. Open the `Fmiqau/fmiq-status` repo, tap **Issues**, then **+**.
2. Pick the **Incident** or **Planned maintenance** template. It adds the right label. If you start a blank issue, add the `incident` or `maintenance` label yourself.
3. Fill in the title and edit the body from the templates below. Each update is a new comment.

The first lines of an issue or comment can be simple `key: value` lines. Everything after them is the public message.

| Key          | Where           | Meaning |
|--------------|-----------------|---------|
| `status:`    | issue, comment  | `investigating`, `identified`, `monitoring`, `resolved` for incidents. `scheduled`, `in progress`, `completed`, `cancelled` for maintenance. |
| `severity:`  | issue           | `S1`, `S2` or `S3` (see RUNBOOK.md). S1 shows the page as a major outage. |
| `eta:`       | issue, comment  | Estimated restore time, or `unknown`. |
| `window:`    | issue           | Maintenance start and end, written `start to end`. |
| `components:`| issue           | Comma list, for example `FMIQ Nexus app, Sign in and data`. Leave it out to cover everything. |

Times can be written as Sydney local time, `2026-10-13 15:30`, which is easiest on a phone. Full ISO times such as `2026-10-13T15:30+11:00` also work. The page prints every time in AEST or AEDT, and also in the viewer's own time zone when it differs.

A closed incident shows as resolved at the top of the page for 24 hours, then moves to the past incidents list, which covers 30 days.

### Investigating (new issue, label `incident`)

Title: `Some customers cannot sign in`

```
status: investigating
severity: S2
eta: unknown
components: Sign in and data

We are aware that some customers cannot sign in to FMIQ Nexus and are investigating. Your data is safe. Updates will follow here.
```

### Identified, with an estimated restore time (comment)

```
status: identified
eta: 2026-10-13 15:30

We have found the cause and are applying a fix. We expect FMIQ Nexus to be fully available again by 3:30 pm AEDT. We will post again by 2:30 pm AEDT.
```

### Monitoring (comment)

```
status: monitoring

A fix is in place and FMIQ Nexus is responding normally again. We are watching it closely before we close this incident.
```

### Resolved, with cause and duration (comment, then close the issue)

```
status: resolved

This incident is resolved. FMIQ Nexus was unavailable for some customers from 1:40 pm to 2:25 pm AEDT on Tuesday 13 October, a total of 45 minutes. The cause was a database setting changed during a routine update. We have reversed the change and added a check so it cannot happen again. A full incident note will follow within 5 business days.
```

### Maintenance announcement (new issue, label `maintenance`)

Post at least 5 business days before the work. Also post it in the app through the platform console (see RUNBOOK.md).

Title: `Database upgrade`

```
window: 2026-10-18 22:00 to 2026-10-19 00:00
components: FMIQ Nexus app

We will carry out planned maintenance on FMIQ Nexus on Sunday 18 October between 10:00 pm and midnight AEDT. The app will be unavailable for up to two hours. Work saved on the mobile app will sync once the work is complete.
```

### Maintenance reminder (comment, 24 hours before)

Subscribers with email get an automatic reminder 24 hours before the window. Post this comment as well so the page and feed show it.

```
status: scheduled

Reminder: this planned maintenance starts in 24 hours, at 10:00 pm AEDT on Sunday 18 October, and should finish by midnight.
```

When the work starts, comment `status: in progress`. When it is done, comment `status: completed` with a short note and close the issue.

## Optional email to subscribers

Email is off until all six of these repository secrets are set (**Settings > Secrets and variables > Actions > New repository secret**):

| Secret        | Example |
|---------------|---------|
| `SMTP_HOST`   | `smtp.office365.com` |
| `SMTP_PORT`   | `587` (STARTTLS) or `465` (TLS from the start) |
| `SMTP_USER`   | the mailbox login |
| `SMTP_PASS`   | its password or app password |
| `NOTIFY_FROM` | `FMIQ Nexus Status <status@fmiqnexus.au>` |
| `NOTIFY_TO`   | `ops@customer-a.com.au, fm@customer-b.com.au` |

The subscriber list lives only in the `NOTIFY_TO` secret, never in the repo. Every subscriber is sent a blind copy, so nobody sees anyone else's address.

Emails go out when an incident opens, on each owner update, on resolution, when maintenance is announced and 24 hours before maintenance starts. Every email carries the estimated restore time or the maintenance window, and a link to https://status.fmiqnexus.au. Each email has a key recorded in `history.json`, so it is never sent twice. Anything more than a day old is never emailed, which stops a backlog going out the first time email is turned on. If a send fails it is tried again on the next run.

The SMTP client is about 150 lines in `scripts/lib/smtp.mjs` using only Node's built in `tls` and `net`.

## Subscribing without email

`https://status.fmiqnexus.au/feed.xml` is an Atom feed with an entry for each incident, update and maintenance notice. It works in any feed reader, in Slack (`/feed subscribe https://status.fmiqnexus.au/feed.xml`) and in the Teams RSS connector. Machine readable status is at `https://status.fmiqnexus.au/status.json`.

## Working on it

```
npm test               # unit tests, node --test, no dependencies
npm run preview        # renders fixtures/preview.html from fixtures/sample.json
npm run monitor        # a real run against the live URLs, writing to ./data and ./_site
```

Open `fixtures/preview.html` through a local web server to see it (for example `python3 -m http.server` in `fixtures`). Some browsers block the page's inline style when it is opened straight from disk.

## Limits

- **Schedule lag.** GitHub runs scheduled workflows on a best effort basis. A five minute schedule often runs every 5 to 15 minutes, and can lag further at busy times. With the 2 run rule, an outage usually shows within 10 to 20 minutes. Post an issue yourself if you know about a problem first.
- **The 60 day inactivity rule.** GitHub disables scheduled workflows in a public repo after 60 days with no repository activity. The `status-data` push every run counts as activity, which should keep it running. GitHub emails the owner before it disables a schedule. If that email ever arrives, open **Actions > Monitor** and enable it again.
- **Cloudflare DNS.** `status.fmiqnexus.au` is resolved by Cloudflare. If Cloudflare DNS itself fails, the page cannot be reached by that name. The issues at https://github.com/Fmiqau/fmiq-status/issues still show every notice in that case.
- **GitHub itself.** If GitHub Actions is down, the page stops updating and shows its last checked time. If GitHub Pages is down, the page is unavailable.
- **What it checks.** It checks from outside, from GitHub's servers, every few minutes. It does not see problems that affect only some customers or only some features unless you post them.
