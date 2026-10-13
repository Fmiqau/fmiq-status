// HTTP probes and the per component state machine.

const UA = 'FMIQ-Nexus-Status/1.0 (+https://status.fmiqnexus.au)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One request. Resolves to { ok, httpStatus, ms, error }. Never throws. */
export async function probeOnce(url, timeoutMs, fetchImpl = fetch) {
  const started = performance.now();
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      headers: { 'user-agent': UA, accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain the body so the timing covers the full response.
    try { await res.arrayBuffer(); } catch { /* ignore */ }
    const ms = Math.round(performance.now() - started);
    return { ok: res.status === 200 && ms <= timeoutMs, httpStatus: res.status, ms, error: null };
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    const error = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : (err?.cause?.code || err?.message || 'error');
    return { ok: false, httpStatus: null, ms, error: String(error).slice(0, 120) };
  }
}

/** Up to `attempts` tries with backoff. Returns the first success or the last failure. */
export async function probeWithRetry(url, opts = {}, fetchImpl = fetch, wait = sleep) {
  const attempts = opts.attempts ?? 3;
  const backoff = opts.backoffMs ?? [2000, 5000];
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await probeOnce(url, opts.timeoutMs ?? 10000, fetchImpl);
    last.attempts = i + 1;
    if (last.ok) return last;
    if (i < attempts - 1) await wait(backoff[Math.min(i, backoff.length - 1)] ?? 2000);
  }
  return last;
}

/**
 * Apply one run's probe result to a component's state.
 * A component changes to its fail status only after `threshold` consecutive
 * failed runs. A single good run brings it straight back to "up".
 * Returns { state, change } where change is null or { at, from, to }.
 */
export function applyProbe(prev, result, { failStatus = 'down', threshold = 2, now = new Date() } = {}) {
  const at = now.toISOString();
  const before = prev?.status || 'unknown';
  const consecutiveFailures = result.ok ? 0 : (prev?.consecutiveFailures || 0) + 1;
  let status;
  if (result.ok) status = 'up';
  else if (consecutiveFailures >= threshold) status = failStatus;
  else status = before === 'unknown' ? 'up' : before; // hold the last known state through a single blip
  const state = {
    status,
    consecutiveFailures,
    lastCheckedAt: at,
    lastResponseMs: result.ms ?? null,
    lastHttpStatus: result.httpStatus ?? null,
    lastError: result.ok ? null : (result.error || (result.httpStatus ? `HTTP ${result.httpStatus}` : 'failed')),
    lastChangeAt: prev?.lastChangeAt || at,
  };
  let change = null;
  if (status !== before) {
    state.lastChangeAt = at;
    if (before !== 'unknown') change = { at, from: before, to: status };
  }
  return { state, change };
}
