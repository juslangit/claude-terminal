// End-to-end checks for M1: drive the server exactly as the browser does.
// Run with the server already listening, or let it start one: `node dev/e2e.mjs`

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.CT_PORT || 4479);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** A browser-like client: collects output bytes, sends input and control. */
class Client {
  constructor(sessionId, cols = 80, rows = 24) {
    this.bytes = [];
    this.ready = null;
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=${sessionId}&cols=${cols}&rows=${rows}`);
    this.ws.binaryType = 'arraybuffer';
    // Fail fast: a broken handshake should not hang the suite.
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket never opened (handshake rejected?)')), 5000);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = () => { clearTimeout(timer); reject(new Error('websocket error during handshake')); };
    });
    this.ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'ready') this.ready = msg.session;
        return;
      }
      this.bytes.push(Buffer.from(new Uint8Array(ev.data)));
    };
  }
  get text() { return Buffer.concat(this.bytes).toString('utf8'); }
  get plain() { return this.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][B0]/g, ''); }
  clear() { this.bytes = []; }
  type(str) { this.ws.send(new TextEncoder().encode(str)); }
  /** Type one character per message, as a real keyboard does. */
  typeKeys(str) { for (const ch of str) this.ws.send(new TextEncoder().encode(ch)); }
  raw(...codes) { this.ws.send(new Uint8Array(codes)); }
  control(msg) { this.ws.send(JSON.stringify(msg)); }
  close() { this.ws.close(); }
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// --- boot the server ---------------------------------------------------------

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: { ...process.env, CT_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

for (let i = 0; i < 50; i++) {
  try { await fetch(BASE + '/api/sessions'); break; } catch { await sleep(100); }
}

try {
  // 1 — static page is served
  {
    const res = await fetch(BASE + '/');
    const html = await res.text();
    check('serves the page', res.ok && html.includes('claude-terminal'));
  }

  // 2 — xterm.js is vendored and served
  {
    const res = await fetch(BASE + '/vendor/xterm.js');
    check('serves vendored xterm.js', res.ok && Number(res.headers.get('content-length')) > 100000);
  }

  // 3 — path traversal is refused
  {
    const res = await fetch(BASE + '/../server.mjs');
    const body = await res.text();
    check('refuses path traversal', !body.includes('SessionManager'), `status ${res.status}`);
  }

  // 4 — create a session
  const { status, body: session } = await api('POST', '/api/sessions', {
    command: 'bash --norc -i', name: 'e2e', cols: 80, rows: 24,
  });
  check('creates a session', status === 201 && !!session.id, session?.id);

  const c = new Client(session.id);
  await c.opened;
  await sleep(700);

  // 5 — handshake delivers a ready message
  check('websocket handshake + ready', !!c.ready, c.ready?.name);

  // 6 — typing reaches the shell, output comes back
  c.clear();
  c.type('printf "COLS=%s ROWS=%s\\n" $(tput cols) $(tput lines)\r');
  await sleep(900);
  const dims = /COLS=(\d+) ROWS=(\d+)/.exec(c.plain);
  check('typing in, output back', !!dims, dims ? `${dims[1]}x${dims[2]}` : c.plain.slice(-80));
  check('client size applied to pty', dims && dims[1] === '80' && dims[2] === '24');

  // 7 — UTF-8 survives the round trip
  c.clear();
  c.type('printf "UTF=café→✓\\n"\r');
  await sleep(900);
  check('utf-8 round trip', c.plain.includes('café→✓'));

  // 7b — keystrokes sent one message at a time keep their order. Real typing
  // produces one message per character; sending a whole string at once (as the
  // checks above do) hides any ordering bug.
  c.clear();
  c.typeKeys('echo hello_from_browser\r');
  await sleep(1400);
  check('per-character typing keeps order', c.plain.includes('hello_from_browser'),
        JSON.stringify(/hello_\S*/.exec(c.plain)?.[0] ?? c.plain.slice(-60)));

  // 7c — a long fast burst, the stress case for the write queue
  c.clear();
  const burst = 'echo ' + 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(3);
  c.typeKeys(burst + '\r');
  await sleep(2200);
  check('fast burst keeps order', c.plain.includes('abcdefghijklmnopqrstuvwxyz0123456789'.repeat(3)),
        JSON.stringify(c.plain.split('\n').find((l) => l.includes('abcdef'))?.slice(0, 70) ?? 'not found'));

  // 8 — Ctrl-C interrupts
  c.clear();
  c.type('sleep 30\r');
  await sleep(400);
  c.raw(0x03);
  await sleep(700);
  check('ctrl-c interrupts', c.text.includes('^C'));

  // 9 — resize reaches the program
  c.clear();
  c.control({ type: 'resize', cols: 120, rows: 40 });
  await sleep(500);
  c.type('printf "AFTER=%s %s\\n" $(tput cols) $(tput lines)\r');
  await sleep(900);
  const after = /AFTER=(\d+) (\d+)/.exec(c.plain);
  check('resize reaches the program', after && after[1] === '120' && after[2] === '40',
        after ? `${after[1]}x${after[2]}` : 'no output');

  // 10 — raw ANSI colour passes through untouched
  c.clear();
  c.type('printf "\\033[31mRED\\033[0m\\n"\r');
  await sleep(800);
  check('raw ANSI colour passes through', c.text.includes('\x1b[31m'));

  // 11 — reconnect: session survives and repaints
  c.close();
  await sleep(400);
  const c2 = new Client(session.id, 120, 40);
  await c2.opened;
  await sleep(900);
  check('session survives a disconnect', !!c2.ready);
  check('reconnect repaints the screen', c2.text.includes('RED') || c2.text.length > 40,
        `${c2.text.length} bytes`);

  // 12 — shell state is intact after reconnect (same process, same variables)
  c2.clear();
  c2.type('MARKER=kept; echo "STATE=$MARKER"\r');
  await sleep(900);
  check('shell state intact after reconnect', c2.plain.includes('STATE=kept'));

  // 13 — a full-screen TUI renders (alternate screen)
  c2.clear();
  c2.type('vim -u NONE -c "set nocompatible" \r');
  await sleep(1600);
  const sawAlt = c2.text.includes('\x1b[?1049h') || c2.text.includes('\x1b[?47h');
  check('full-screen TUI enters alternate screen', sawAlt);

  // 14 — reconnecting onto a TUI forces it to repaint
  c2.close();
  await sleep(300);
  const c3 = new Client(session.id, 120, 40);
  await c3.opened;
  await sleep(1400);
  check('reconnect onto a TUI repaints it', c3.text.length > 100, `${c3.text.length} bytes`);

  // 15 — Esc and :q! leave vim cleanly
  c3.clear();
  c3.raw(0x1b);
  await sleep(300);
  c3.type(':q!\r');
  await sleep(1200);
  check('esc + :q! exits the TUI', c3.text.includes('\x1b[?1049l') || c3.text.includes('\x1b[?47l'));

  // 16 — `top`, a second full-screen TUI. Interactive mode, not `-l 0`, which is
  // non-interactive logging mode and ignores `q`.
  c3.clear();
  c3.type('top\r');
  await sleep(2500);
  const topDrew = c3.text.length > 200;
  c3.raw(0x71); // q quits top
  await sleep(1500);
  check('second TUI (top) renders', topDrew, `${c3.text.length} bytes`);

  // Make sure we are back at a shell prompt before testing keys against it.
  c3.clear();
  c3.type('echo BACK_AT_SHELL\r');
  await sleep(900);
  check('shell usable again after a TUI quits', c3.plain.includes('BACK_AT_SHELL'));

  // 17 — arrow keys arrive as escape sequences. Up recalls the previous command
  // into the input line without running it.
  c3.clear();
  c3.type('echo needle_one\r');
  await sleep(800);
  c3.clear();
  c3.raw(0x1b, 0x5b, 0x41); // Up
  await sleep(800);
  check('up arrow recalls history', c3.plain.includes('needle_one'), JSON.stringify(c3.plain.slice(-60)));

  // 18 — Home/End and Ctrl-A style editing keys reach readline
  c3.raw(0x03); // Ctrl-C to clear the recalled line
  await sleep(400);
  c3.clear();
  c3.type('echo tail');
  await sleep(400);
  c3.raw(0x01);          // Ctrl-A → start of line
  c3.type('#');          // comment it out from the front
  await sleep(400);
  c3.type('\r');
  await sleep(800);
  check('ctrl-a reaches line editing', !c3.plain.includes('\ntail'), 'line was commented out');

  // 19 — claude itself starts and draws
  const { body: claudeSession } = await api('POST', '/api/sessions', {
    command: 'claude', name: 'claude-check', cols: 100, rows: 30,
  });
  const cc = new Client(claudeSession.id, 100, 30);
  await cc.opened;
  await sleep(6000);
  const claudeDrew = cc.text.length > 300;
  check('claude code starts and draws', claudeDrew, `${cc.text.length} bytes`);
  check('claude uses the terminal fully (ANSI present)', cc.text.includes('\x1b['));

  // 20 — listing shows both sessions
  {
    const { body } = await api('GET', '/api/sessions');
    check('lists sessions', body.sessions.length >= 2, `${body.sessions.length} sessions`);
  }

  // 21 — delete removes them
  cc.close();
  c3.close();
  await sleep(300);
  await api('DELETE', `/api/sessions/${claudeSession.id}`);
  await api('DELETE', `/api/sessions/${session.id}`);
  const { body: afterDelete } = await api('GET', '/api/sessions');
  check('deletes sessions', afterDelete.sessions.length === 0, `${afterDelete.sessions.length} left`);

} catch (err) {
  console.error('\nharness error:', err);
  results.push({ name: 'harness', ok: false });
} finally {
  server.kill('SIGTERM');
  await sleep(300);
  spawn('tmux', ['-L', 'claude-terminal', 'kill-server'], { stdio: 'ignore' });

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (passed !== results.length) {
    console.log('\n--- server log ---\n' + serverLog.slice(-2000));
  }
  process.exit(passed === results.length ? 0 : 1);
}
