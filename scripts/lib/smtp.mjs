// Minimal SMTP client: implicit TLS on 465, STARTTLS elsewhere (587).
// AUTH PLAIN or LOGIN. Plain text UTF-8 body, base64 encoded. No dependencies.

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const TIMEOUT_MS = 30000;

class Conn {
  constructor(socket) { this.attach(socket); }

  attach(socket) {
    this.socket = socket;
    this.buffer = '';
    this.lines = [];
    this.waiter = null;
    this.error = null;
    socket.setEncoding('utf8');
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('SMTP timeout')));
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        this.lines.push(this.buffer.slice(0, i).replace(/\r$/, ''));
        this.buffer = this.buffer.slice(i + 1);
      }
      this.flush();
    });
    socket.on('error', (err) => { this.error = err; this.flush(); });
    socket.on('close', () => { this.error = this.error || new Error('SMTP connection closed'); this.flush(); });
  }

  flush() {
    if (!this.waiter) return;
    // A reply is complete when a line has a space (not a dash) after the code.
    const end = this.lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
    if (end >= 0) {
      const reply = this.lines.splice(0, end + 1);
      const w = this.waiter; this.waiter = null;
      w.resolve({ code: Number(reply[end].slice(0, 3)), lines: reply.map((l) => l.slice(4)) });
    } else if (this.error) {
      const w = this.waiter; this.waiter = null;
      w.reject(this.error);
    }
  }

  read() {
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; this.flush(); });
  }

  async cmd(line, expect, redact = false) {
    if (line != null) this.socket.write(`${line}\r\n`);
    const r = await this.read();
    const ok = Array.isArray(expect) ? expect.includes(r.code) : r.code === expect;
    if (!ok) throw new Error(`SMTP ${redact ? '[auth]' : String(line).split(' ')[0]} failed: ${r.code} ${r.lines.join(' ').slice(0, 200)}`);
    return r;
  }
}

function connect(opts) {
  return new Promise((resolve, reject) => {
    const s = opts.port === 465
      ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host, minVersion: 'TLSv1.2' }, () => resolve(s))
      : net.connect({ host: opts.host, port: opts.port }, () => resolve(s));
    s.once('error', reject);
    s.setTimeout(TIMEOUT_MS, () => s.destroy(new Error('SMTP connect timeout')));
  });
}

function upgrade(socket, host) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket, servername: host, minVersion: 'TLSv1.2' }, () => resolve(s));
    s.once('error', reject);
  });
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const bareAddress = (s) => (/<([^>]+)>/.exec(s)?.[1] || s).trim();

export function buildMessage({ from, subject, text, date = new Date() }) {
  const domain = bareAddress(from).split('@')[1] || 'localhost';
  const body = b64(text.replace(/\r?\n/g, '\r\n')).replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${from}`,
    `To: ${from}`, // subscribers are blind copied so they never see each other
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    '',
    body,
  ].join('\r\n');
}

/** Send one message to every recipient as blind copies. Throws on failure. */
export async function sendMail(settings, { subject, text }) {
  const { host, port, user, pass, from, to } = settings;
  let conn = new Conn(await connect({ host, port }));
  try {
    await conn.cmd(null, 220);
    let ehlo = await conn.cmd('EHLO status.fmiqnexus.au', 250);
    if (port !== 465) {
      if (!ehlo.lines.some((l) => /^STARTTLS/i.test(l))) throw new Error('SMTP server does not offer STARTTLS');
      await conn.cmd('STARTTLS', 220);
      for (const ev of ['data', 'error', 'close']) conn.socket.removeAllListeners(ev);
      conn.socket.setTimeout(0);
      conn =new Conn(await upgrade(conn.socket, host));
      ehlo = await conn.cmd('EHLO status.fmiqnexus.au', 250);
    }
    const auth = ehlo.lines.find((l) => /^AUTH\b/i.test(l)) || '';
    if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth)) {
      await conn.cmd(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, 235, true);
    } else {
      await conn.cmd('AUTH LOGIN', 334);
      await conn.cmd(b64(user), 334, true);
      await conn.cmd(b64(pass), 235, true);
    }
    await conn.cmd(`MAIL FROM:<${bareAddress(from)}>`, 250);
    for (const rcpt of to) await conn.cmd(`RCPT TO:<${bareAddress(rcpt)}>`, [250, 251]);
    await conn.cmd('DATA', 354);
    const data = buildMessage({ from, subject, text }).replace(/^\./gm, '..');
    await conn.cmd(`${data}\r\n.`, 250);
    await conn.cmd('QUIT', [221, 250]).catch(() => {});
  } finally {
    conn.socket.destroy();
  }
}
