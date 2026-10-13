# FMIQ Nexus availability incident runbook

This runbook covers loss or degradation of the FMIQ Nexus service, and planned maintenance. It sits alongside the service level agreement, which promises 5 business days' notice of planned maintenance and a support desk open 8 am to 5 pm, Monday to Friday, Sydney time. Nothing in this runbook changes those commitments.

The public record of every incident and maintenance window is https://status.fmiqnexus.au, driven by issues in https://github.com/Fmiqau/fmiq-status. The templates below match the ones in README.md.

## Who declares an incident

Arbab Shah, as Director, declares incidents, sets the severity, approves every public update and closes the incident. If Arbie cannot be reached within 15 minutes of an S1, whoever is handling it may post the Investigating template so customers are not left without word, then keeps trying to reach Arbie.

The status monitor may open an incident by itself when the app or the website stops responding. That counts as declared. Arbie confirms the severity and takes it from there.

## Severities

| Severity | Meaning | Examples | Public updates |
|----------|---------|----------|----------------|
| **S1** | FMIQ Nexus is unavailable or unusable for most customers, or customer data may be at risk. | The app does not load. Nobody can sign in. The database is down. A security event that may expose data. | Every 30 minutes until resolved |
| **S2** | A major function is degraded or failing, or one customer is fully affected, but there is a workaround or most work continues. | Sign in is slow or fails for some. Work orders save but notifications do not send. Reports or the mobile app sync fail. | Every 60 minutes until resolved |
| **S3** | A minor problem with little effect on daily work. | One report shows old figures. A single integration is delayed. A cosmetic fault on one screen. | When identified and when resolved |

Raise the severity as soon as the effect turns out to be wider than first thought. Do not lower it until the effect has clearly reduced.

## First 15 minutes

Work down this list. Note the time of each step in the incident issue or a scratch note, because these become the timeline.

1. **Check the status page.** Open https://status.fmiqnexus.au. Which components are down or degraded, and since when? Is there already an automatic incident issue?
2. **Confirm it yourself.** Open https://app.fmiqnexus.au in a private window and on mobile data. Try `https://app.fmiqnexus.au/api/live` and `https://app.fmiqnexus.au/api/health`.
3. **Check DigitalOcean.** Look at the App Platform app: deployment status, recent deploys, runtime logs, and CPU and memory. Check https://status.digitalocean.com for a provider incident in the Sydney region. If a deploy in the last hour lines up with the start, consider rolling back.
4. **Check Cloudflare.** Look at DNS records and recent changes for `fmiqnexus.au`, the security events log for blocked traffic, and https://www.cloudflarestatus.com.
5. **Check the database.** Look at the managed database cluster: status, connections, CPU, storage and recent maintenance. The health endpoint's `checks` section shows whether the app can reach it.
6. **Declare and post.** Set the severity. If there is no incident issue yet, open one with the Investigating template. If the monitor opened one, comment with the current status and add a `severity:` line by editing the issue body.
7. **Set the next update time** from the cadence above and post on time even when there is no news. Saying "no change, still working on it" is better than silence.

Outside support desk hours, an S1 or S2 still gets the first post within 15 minutes of being noticed. S3 can wait until the desk opens.

## Update cadence

- **S1**: every 30 minutes until resolved, then a resolution post.
- **S2**: every 60 minutes until resolved, then a resolution post.
- **S3**: when identified and when resolved.

Give an estimated restore time (`eta:`) once there is a sound basis for one. Until then use `eta: unknown`. If an estimate is going to be missed, update it before it passes.

## Templates

Post the first one as a new issue with the `incident` label. Post the rest as comments. Times can be written as `2026-10-13 15:30` in Sydney time.

### Investigating

```
status: investigating
severity: S2
eta: unknown
components: Sign in and data

We are aware that some customers cannot sign in to FMIQ Nexus and are investigating. Your data is safe. Updates will follow here.
```

### Identified, with an estimated restore time

```
status: identified
eta: 2026-10-13 15:30

We have found the cause and are applying a fix. We expect FMIQ Nexus to be fully available again by 3:30 pm AEDT. We will post again by 2:30 pm AEDT.
```

### Monitoring

```
status: monitoring

A fix is in place and FMIQ Nexus is responding normally again. We are watching it closely before we close this incident.
```

### Resolved, with cause and duration

Post the comment, then close the issue.

```
status: resolved

This incident is resolved. FMIQ Nexus was unavailable for some customers from 1:40 pm to 2:25 pm AEDT on Tuesday 13 October, a total of 45 minutes. The cause was a database setting changed during a routine update. We have reversed the change and added a check so it cannot happen again. A full incident note will follow within 5 business days.
```

Only say "your data is safe" when that has been checked. Do not guess at causes in public. Say "we are still confirming the cause" until it is known.

## Planned maintenance

The agreement promises **5 business days' notice**. Business days are Monday to Friday, excluding NSW public holidays. Count from the day after the notice goes out. For maintenance on a Saturday night, notice must go out by the end of the Saturday one week earlier at the latest, and earlier is better.

1. **Plan the window.** Choose a time outside the support desk hours of 8 am to 5 pm Monday to Friday where possible. Agree the start, the end and what customers will notice.
2. **Post in the app** through the platform console, as a maintenance notice with the same window and wording. This feeds the app's own `status.json` and shows inside FMIQ Nexus.
3. **Post on the status page** as a GitHub issue with the `maintenance` label, using the template below. Do this on the same day as the app notice. This copy stays visible even if the app is down during the work.
4. **Reminder 24 hours before.** Email subscribers receive an automatic reminder. Also comment the reminder template on the issue so the page and feed show it, and refresh the in app notice if needed.
5. **At the start**, comment `status: in progress`.
6. **At the end**, comment `status: completed` with a short note and close the issue. Mark the in app notice completed.
7. **If it overruns**, comment with a new `eta:` before the window ends. If the service is down beyond the window, treat it as an incident.
8. **If it is cancelled**, comment `status: cancelled` and close the issue, and withdraw the in app notice.

Urgent security or provider work may not allow 5 business days. In that case give as much notice as possible, say why in the notice, and record the reason in the evidence folder.

### Maintenance announcement (new issue, label `maintenance`)

```
window: 2026-10-18 22:00 to 2026-10-19 00:00
components: FMIQ Nexus app

We will carry out planned maintenance on FMIQ Nexus on Sunday 18 October between 10:00 pm and midnight AEDT. The app will be unavailable for up to two hours. Work saved on the mobile app will sync once the work is complete.
```

### Maintenance reminder (comment, 24 hours before)

```
status: scheduled

Reminder: this planned maintenance starts in 24 hours, at 10:00 pm AEDT on Sunday 18 October, and should finish by midnight.
```

## After the incident

Within **5 business days** of resolving an S1 or S2, Arbie writes an incident note. S3 needs a note only if a customer asks or the same fault happens again.

The note covers:

1. What customers saw, and when it started and ended (from the status page and issue timeline).
2. Who was affected and how many.
3. How it was detected: by the monitor, a customer, or the team.
4. The cause, in plain words.
5. What was done to restore service.
6. What will stop it happening again, with an owner and a date for each action.
7. Whether any service level target was missed, and by how much.

Share a customer version with affected customers and link it in a final comment on the incident issue. Keep it factual and calm. Do not blame a supplier by name in the public version unless they have published their own incident.

## Where evidence is kept

| Evidence | Where |
|----------|-------|
| Public timeline and every update | The incident or maintenance issue in https://github.com/Fmiqau/fmiq-status (kept indefinitely) |
| Checks, response times and state changes | `history.json` on the `status-data` branch (90 days of daily figures, last 20 changes) and the Monitor workflow run logs (kept by GitHub for 90 days) |
| Provider evidence | Screenshots or exports from DigitalOcean, Cloudflare and the database console, taken during the incident |
| Incident note, actions and any customer correspondence | The incident register in the FMIQ Nexus ISMS evidence folder (`docs/compliance` in the main repo), one folder per incident named by date and issue number |

Because `history.json` keeps only a rolling window, export the relevant workflow logs and a copy of `history.json` into the incident folder when writing the note.
