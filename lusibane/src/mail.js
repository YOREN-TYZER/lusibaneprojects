'use strict';
// Minimal SMTP sender using only Node built-ins (no packages).
// Supports implicit TLS (port 465) and STARTTLS (port 587), AUTH PLAIN / LOGIN.
// Credentials are never sent over an unencrypted link (except to localhost, for testing).
const net = require('node:net');
const tls = require('node:tls');
const cfg = require('./config');

const configured = () => !!(cfg.smtp.host && cfg.mailTo);

const clean = (s) => String(s == null ? '' : s).replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim();
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const addrOnly = (a) => { const m = /<([^>]+)>/.exec(a); return (m ? m[1] : a).trim(); };

function buildMessage({ from, to, replyTo, subject, text }) {
  const h = [
    `From: ${clean(from)}`,
    `To: ${clean(to)}`,
    ...(replyTo ? [`Reply-To: ${clean(replyTo)}`] : []),
    `Subject: ${encWord(clean(subject))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${(addrOnly(from).split('@')[1] || 'localhost')}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  return h.join('\r\n') + '\r\n\r\n' + wrap76(b64(text.replace(/\r?\n/g, '\r\n'))) + '\r\n';
}

/** Tiny line-oriented SMTP conversation. Resolves when the server accepts the message. */
function send(msg, opts = cfg.smtp) {
  return new Promise((resolve, reject) => {
    const to = addrOnly(msg.to), from = addrOnly(msg.from);
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(to) || !/^[^\s<>@]+@[^\s<>@]+$/.test(from)) return reject(new Error('Invalid mail address'));
    const local = /^(127\.0\.0\.1|localhost|::1)$/.test(opts.host);
    let sock, buf = '', done = false, secure = false;
    let waiter = null;
    const fail = (e) => { if (done) return; done = true; try { sock && sock.destroy(); } catch { /* ignore */ } reject(e instanceof Error ? e : new Error(String(e))); };
    const timer = setTimeout(() => fail(new Error('SMTP timeout')), 20000);
    const ok = () => { if (done) return; done = true; clearTimeout(timer); try { sock.end(); } catch { /* ignore */ } resolve(); };

    const attach = (s) => {
      sock = s; buf = '';
      s.setEncoding('utf8');
      s.on('data', (d) => { buf += d; pump(); });
      s.on('error', fail);
      s.on('close', () => fail(new Error('SMTP connection closed')));
    };
    // Collect a full (possibly multi-line) reply: lines "250-..." continue, "250 ..." ends.
    function pump() {
      if (!waiter) return;
      const lines = buf.split('\r\n');
      if (lines.length < 2) return;
      const last = lines[lines.length - 2];
      if (/^\d{3} /.test(last) || /^\d{3}$/.test(last)) {
        const text = lines.slice(0, -1).join('\n'); buf = '';
        const w = waiter; waiter = null; w(text);
      }
    }
    const reply = () => new Promise((res) => { waiter = res; pump(); });
    const cmd = async (line, expect) => {
      sock.write(line + '\r\n');
      const r = await reply();
      if (!expect.includes(Number(r.slice(0, 3)))) throw new Error('SMTP: ' + clean(r).slice(0, 200));
      return r;
    };

    (async () => {
      const implicit = opts.secure || opts.port === 465;
      await new Promise((res, rej) => {
        const onErr = (e) => rej(e);
        const s = implicit
          ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host }, res)
          : net.connect({ host: opts.host, port: opts.port }, res);
        s.once('error', onErr); attach(s);
        s.once('connect', () => s.off('error', onErr));
        s.once('secureConnect', () => s.off('error', onErr));
      });
      secure = implicit;
      let r = await reply();
      if (!r.startsWith('220')) throw new Error('SMTP: ' + clean(r).slice(0, 200));
      r = await cmd(`EHLO ${opts.ehlo || 'lusibane.local'}`, [250]);
      if (!secure && /STARTTLS/i.test(r)) {
        await cmd('STARTTLS', [220]);
        const raw = sock; raw.removeAllListeners('data'); raw.removeAllListeners('close'); raw.removeAllListeners('error');
        await new Promise((res, rej) => {
          const t = tls.connect({ socket: raw, servername: opts.host }, res);
          t.once('error', rej); attach(t);
        });
        secure = true;
        r = await cmd(`EHLO ${opts.ehlo || 'lusibane.local'}`, [250]);
      }
      if (opts.user) {
        if (!secure && !local) throw new Error('Refusing to send the password without TLS');
        if (/AUTH[^\n]*PLAIN/i.test(r)) await cmd('AUTH PLAIN ' + b64(`\u0000${opts.user}\u0000${opts.pass}`), [235]);
        else {
          await cmd('AUTH LOGIN', [334]);
          await cmd(b64(opts.user), [334]);
          await cmd(b64(opts.pass), [235]);
        }
      } else if (!secure && !local) {
        throw new Error('Refusing to send mail without TLS');
      }
      await cmd(`MAIL FROM:<${from}>`, [250]);
      await cmd(`RCPT TO:<${to}>`, [250, 251]);
      await cmd('DATA', [354]);
      sock.write(buildMessage(msg).replace(/^\./gm, '..') + '.\r\n');
      const fin = await reply();
      if (Number(fin.slice(0, 3)) !== 250) throw new Error('SMTP: ' + clean(fin).slice(0, 200));
      try { sock.write('QUIT\r\n'); } catch { /* ignore */ }
      ok();
    })().catch(fail);
  });
}

module.exports = { send, configured, buildMessage, clean };
