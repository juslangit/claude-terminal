// claude-terminal — a real terminal on your phone, attached to your own computer.
//
// The server does three things: serve the page, keep a list of tmux sessions,
// and bridge a WebSocket to a session's pty. Node built-ins only (D-002).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { accept } from './lib/ws.mjs';
import { SessionManager, isAvailable } from './lib/tmux.mjs';
import { ensureToken, originAllowed, tokenMatches, tokenFrom } from './lib/auth.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');

const PORT = Number(process.env.CT_PORT || 4478);
// Bind to loopback only. Reach from a phone is Tailscale's job, never ours —
// this server must not be directly exposed (D-003, and the top risk in planning).
const HOST = '127.0.0.1';

const manager = new SessionManager({
  rootDir: ROOT,
  runDir: path.join(DATA, 'run'),
  stateFile: path.join(DATA, 'sessions.json'),
});

fs.mkdirSync(DATA, { recursive: true });
// Per-install secret. Written to data/token (mode 600) on first run.
const TOKEN = ensureToken(DATA);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  // Never serve outside public/ — a crafted path must not escape it.
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) {
    res.writeHead(403).end('forbidden');
    return;
  }

  // The page is handed the token inline. A site on another origin cannot read
  // this response, so the token stays out of reach of anything but our own page.
  if (path.basename(file) === 'index.html') {
    fs.readFile(file, 'utf8', (err, html) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      const injected = html.replace('</head>',
        `<script>window.__CT_TOKEN__=${JSON.stringify(TOKEN)}</script>\n</head>`);
      const body = Buffer.from(injected, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      res.end(body);
    });
    return;
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

async function handleAPI(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','sessions', id?]

  if (parts[1] === 'sessions' && parts.length === 2) {
    if (req.method === 'GET') {
      await manager.reap();
      return sendJSON(res, 200, { sessions: manager.list() });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const session = await manager.create({
        name: typeof body.name === 'string' ? body.name.slice(0, 60) : undefined,
        cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
        command: typeof body.command === 'string' ? body.command : undefined,
        cols: Number(body.cols) || 80,
        rows: Number(body.rows) || 24,
      });
      return sendJSON(res, 201, session.toJSON());
    }
  }

  if (parts[1] === 'sessions' && parts.length === 3 && req.method === 'DELETE') {
    const ok = await manager.remove(parts[2]);
    return sendJSON(res, ok ? 200 : 404, { ok });
  }

  if (parts[1] === 'sessions' && parts.length === 3 && req.method === 'PATCH') {
    const body = await readBody(req);
    const ok = typeof body.name === 'string' && manager.rename(parts[2], body.name);
    return sendJSON(res, ok ? 200 : 404, { ok });
  }

  return sendJSON(res, 404, { error: 'no such endpoint' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    // A page on another site must never be able to reach this, and neither
    // should anything without the token. See lib/auth.mjs.
    if (!originAllowed(req)) return sendJSON(res, 403, { error: 'bad origin' });
    if (!tokenMatches(TOKEN, tokenFrom(req, url))) return sendJSON(res, 401, { error: 'bad token' });
    handleAPI(req, res, url).catch((err) => {
      console.error('api error:', err);
      sendJSON(res, 500, { error: String(err.message || err) });
    });
    return;
  }
  if (req.method !== 'GET') { res.writeHead(405).end('method not allowed'); return; }
  serveStatic(req, res, url.pathname);
});

// --- WebSocket: one connection = one view onto one session -------------------

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') { socket.destroy(); return; }

  // WebSockets are not covered by CORS at all, so without these two checks any
  // page could attach to a running session and type into it.
  if (!originAllowed(req) || !tokenMatches(TOKEN, tokenFrom(req, url))) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const session = manager.get(url.searchParams.get('session') || '');
  const ws = accept(req, socket);
  if (!ws) return;

  if (!session) {
    ws.sendText(JSON.stringify({ type: 'error', message: 'session not found' }));
    ws.close(1008, 'no session');
    return;
  }

  attach(ws, session, {
    cols: Number(url.searchParams.get('cols')) || session.cols,
    rows: Number(url.searchParams.get('rows')) || session.rows,
  }).catch((err) => {
    console.error('attach failed:', err);
    try { ws.close(1011, 'attach failed'); } catch {}
  });
});

async function attach(ws, session, size) {
  // Subscribe before anything else so no output produced during setup is lost.
  const unsubscribe = session.subscribe((chunk) => ws.sendBinary(chunk));

  const keepalive = setInterval(() => ws.ping(), 30_000);

  ws.on('close', () => {
    clearInterval(keepalive);
    unsubscribe();
  });

  ws.on('message', (payload, isBinary) => {
    if (isBinary) {
      session.write(payload).catch((err) => console.error('write failed:', err));
      return;
    }
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }
    if (msg.type === 'resize') {
      session.resize(msg.cols, msg.rows).catch((err) => console.error('resize failed:', err));
    } else if (msg.type === 'redraw') {
      session.forceRedraw().catch(() => {});
    }
  });

  // The pipe can be missing if tmux was restarted under us.
  await session.ensurePipe();

  // Size the pty to this client before painting, so what is drawn fits.
  await session.resize(size.cols, size.rows);

  ws.sendText(JSON.stringify({ type: 'ready', session: session.toJSON() }));

  // Fill the screen. capture-pane cannot reproduce an alternate screen
  // faithfully, so when a full-screen program owns the pane, make it repaint
  // instead of pasting a snapshot of it.
  if (await session.isAltScreen()) {
    await session.forceRedraw();
  } else {
    const snapshot = await session.snapshot();
    if (snapshot) ws.sendBinary(Buffer.from(snapshot, 'utf8'));
  }
}

// --- startup -----------------------------------------------------------------

const version = await isAvailable();
if (!version) {
  console.error('tmux is not installed, and this needs it. Try: brew install tmux');
  process.exit(1);
}

// Pick up anything left running by a previous run before accepting requests.
const adopted = await manager.adoptExisting();

server.listen(PORT, HOST, () => {
  console.log(`claude-terminal on http://${HOST}:${PORT}  (${version})`);
  if (adopted) console.log(`re-attached to ${adopted} session${adopted === 1 ? '' : 's'} already running`);
});

async function shutdown(signal) {
  console.log(`\n${signal} — leaving sessions running, closing the server`);
  manager.detach(); // never take running work down with the server
  server.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
