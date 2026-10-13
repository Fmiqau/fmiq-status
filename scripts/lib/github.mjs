// Small GitHub REST client using the workflow's GITHUB_TOKEN.

export function github({ token, repo, fetchImpl = fetch }) {
  const base = `https://api.github.com/repos/${repo}`;
  async function call(method, path, body) {
    const res = await fetchImpl(path.startsWith('http') ? path : `${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'fmiq-status',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  }
  async function paged(path, max = 300) {
    const out = [];
    for (let page = 1; out.length < max; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const batch = await call('GET', `${path}${sep}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }
  return {
    /** Issues (not PRs) updated since `since`, plus every open issue. */
    async listIssues(since) {
      const open = await paged('/issues?state=open&sort=updated&direction=desc');
      const recent = await paged(`/issues?state=closed&sort=updated&direction=desc&since=${encodeURIComponent(since)}`);
      const seen = new Map();
      for (const i of [...open, ...recent]) if (!i.pull_request) seen.set(i.number, i);
      return [...seen.values()];
    },
    listComments: (number) => paged(`/issues/${number}/comments`),
    createIssue: (data) => call('POST', '/issues', data),
    comment: (number, body) => call('POST', `/issues/${number}/comments`, { body }),
    close: (number) => call('PATCH', `/issues/${number}`, { state: 'closed', state_reason: 'completed' }),
    ensureLabel: async (name, color, description) => {
      try { await call('GET', `/labels/${encodeURIComponent(name)}`); }
      catch { await call('POST', '/labels', { name, color, description }).catch(() => {}); }
    },
  };
}
