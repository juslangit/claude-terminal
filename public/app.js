// Front end: an xterm.js terminal bound to one session over a WebSocket.
// Binary frames carry terminal bytes in both directions; text frames carry
// control messages (resize, ready).

const $ = (sel) => document.querySelector(sel);

// Handed to the page by the server when it served this HTML (see lib/auth.mjs).
const TOKEN = window.__CT_TOKEN__ || '';

const els = {
  keybar: $('#keybar'),
  term: $('#term'),
  status: $('#status'),
  title: $('#title'),
  panel: $('#panel'),
  list: $('#session-list'),
  cwd: $('#new-cwd'),
};

const state = {
  sessionId: null,
  ws: null,
  term: null,
  fit: null,
  reconnectDelay: 500,
  reconnectTimer: null,
  // Sticky modifiers: tap arms one keystroke, tap again to lock.
  mods: { ctrl: 'off', alt: 'off' },
  fontSize: 13,
};

// --- terminal ----------------------------------------------------------------

function makeTerminal() {
  const term = new Terminal({
    cursorBlink: true,
    allowProposedApi: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: state.fontSize,
    scrollback: 5000,
    // macOS option-as-meta, so Alt-b / Alt-f work in a shell.
    macOptionIsMeta: true,
    theme: {
      background: '#14110e',
      foreground: '#e8dfd2',
      cursor: '#d98c3f',
      selectionBackground: '#3d3527',
      black: '#14110e',   brightBlack: '#5c5142',
      red: '#d9553f',     brightRed: '#e8735c',
      green: '#7fb069',   brightGreen: '#9ac785',
      yellow: '#d9a23f',  brightYellow: '#e8bd63',
      blue: '#6b8cba',    brightBlue: '#8aa8d1',
      magenta: '#b07cc6', brightMagenta: '#c99add',
      cyan: '#6bb0a8',    brightCyan: '#8acdc4',
      white: '#e8dfd2',   brightWhite: '#fdf6ea',
    },
  });

  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(els.term);

  // WebGL makes scrolling smooth; it is not available everywhere, so failure
  // to load it must not take the terminal down with it.
  try {
    term.loadAddon(new WebglAddon.WebglAddon());
  } catch {
    /* canvas/DOM renderer is fine */
  }

  fit.fit();

  // Keystrokes go out as raw bytes.
  const encoder = new TextEncoder();
  term.onData((data) => send(encoder.encode(applyMods(data))));
  // Anything xterm decides to answer on the host's behalf (device status
  // reports and the like) is input too.
  term.onBinary((data) => {
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
    send(bytes);
  });

  state.term = term;
  state.fit = fit;
  return term;
}

// --- key bar ---------------------------------------------------------------
//
// iOS offers no Esc, Ctrl, Tab or arrows, which makes a plain touch keyboard
// useless for a terminal. These buttons supply them.

const KEY_BYTES = {
  esc:   '\x1b',
  tab:   '\t',
  up:    '\x1b[A',
  down:  '\x1b[B',
  right: '\x1b[C',
  left:  '\x1b[D',
  home:  '\x1b[H',
  end:   '\x1b[F',
  pgup:  '\x1b[5~',
  pgdn:  '\x1b[6~',
};

/**
 * Apply any armed modifier to typed text.
 * Ctrl-<letter> is the letter's low five bits; Alt-<key> is Esc then the key.
 */
function applyMods(data) {
  const { ctrl, alt } = state.mods;
  if (ctrl === 'off' && alt === 'off') return data;

  let out = data;
  if (ctrl !== 'off' && data.length === 1) {
    const code = data.toUpperCase().charCodeAt(0);
    if (code >= 63 && code <= 95) out = String.fromCharCode(code & 0x1f);
    else if (code >= 97 && code <= 122) out = String.fromCharCode(code & 0x1f);
  }
  if (alt !== 'off') out = '\x1b' + out;

  // An armed modifier applies once; a locked one stays until tapped off.
  if (ctrl === 'armed') setMod('ctrl', 'off');
  if (alt === 'armed') setMod('alt', 'off');
  return out;
}

function setMod(name, value) {
  state.mods[name] = value;
  const btn = els.keybar.querySelector(`[data-mod="${name}"]`);
  if (!btn) return;
  btn.classList.toggle('armed', value === 'armed');
  btn.classList.toggle('locked', value === 'locked');
}

function setupKeybar() {
  els.keybar.addEventListener('pointerdown', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    // Never let a tap move focus: on iOS that dismisses the keyboard, and the
    // terminal stops receiving input until the user taps it again.
    ev.preventDefault();

    if (btn.dataset.mod) {
      const current = state.mods[btn.dataset.mod];
      setMod(btn.dataset.mod, current === 'off' ? 'armed' : current === 'armed' ? 'locked' : 'off');
      return;
    }

    const raw = btn.dataset.key ? KEY_BYTES[btn.dataset.key]
      : btn.dataset.send ? btn.dataset.send
      : btn.dataset.text ?? '';
    if (!raw) return;

    // Text keys respect the modifiers; named keys are already escape sequences.
    const payload = btn.dataset.text ? applyMods(raw) : raw;
    send(new TextEncoder().encode(payload));
    state.term?.focus();
  });
}

// --- font size -------------------------------------------------------------

function setFontSize(px) {
  state.fontSize = Math.max(8, Math.min(24, px));
  if (state.term) {
    state.term.options.fontSize = state.fontSize;
    doFit();
  }
  const label = $('#font-size');
  if (label) label.textContent = String(state.fontSize);
  try { localStorage.setItem('ct.fontSize', String(state.fontSize)); } catch { /* private mode */ }
}

function send(bytes) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(bytes);
}

function sendControl(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

function doFit() {
  if (!state.fit) return;
  try { state.fit.fit(); } catch { return; }
  sendControl({ type: 'resize', cols: state.term.cols, rows: state.term.rows });
}

// --- connection --------------------------------------------------------------

function setStatus(text, stateName) {
  els.status.textContent = text;
  els.status.dataset.state = stateName;
}

function connect(sessionId) {
  // Detach the old socket completely before closing it. A shared "we meant to
  // close this" flag does not work: close() resolves asynchronously, so by the
  // time the old socket's onclose fires the flag has already been cleared and
  // the reconnect logic drags the view back to the previous session.
  if (state.ws) {
    const old = state.ws;
    old.onopen = old.onmessage = old.onerror = old.onclose = null;
    try { old.close(); } catch { /* already gone */ }
    state.ws = null;
  }
  clearTimeout(state.reconnectTimer);

  state.sessionId = sessionId;
  setStatus('connecting', 'connecting');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const { cols, rows } = state.term;
  const ws = new WebSocket(`${proto}://${location.host}/ws?session=${encodeURIComponent(sessionId)}` +
    `&cols=${cols}&rows=${rows}&token=${encodeURIComponent(TOKEN)}`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => {
    if (state.ws !== ws) return;
    state.reconnectDelay = 500;
    setStatus('connected', 'open');
    doFit();
    state.term.focus();
  };

  ws.onmessage = (ev) => {
    if (state.ws !== ws) return;
    if (typeof ev.data === 'string') {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'ready') {
        els.title.textContent = msg.session.name || 'terminal';
      } else if (msg.type === 'error') {
        state.term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
      }
      return;
    }
    state.term.write(new Uint8Array(ev.data));
  };

  ws.onclose = () => {
    // Only the socket we still consider current may drive a reconnect.
    if (state.ws !== ws) return;
    setStatus('reconnecting', 'closed');
    // The session keeps running on the computer, so reconnecting picks it up
    // exactly where it was.
    state.reconnectTimer = setTimeout(() => connect(sessionId), state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 8000);
  };

  ws.onerror = () => { if (state.ws === ws) setStatus('error', 'closed'); };
}

// --- sessions ----------------------------------------------------------------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'x-ct-token': TOKEN,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`);
  return res.json();
}

async function refreshSessions() {
  const { sessions } = await api('GET', '/api/sessions');
  els.list.innerHTML = '';
  if (!sessions.length) {
    els.list.innerHTML = '<li><span class="meta"><span class="sub">No sessions yet.</span></span></li>';
  }
  for (const s of sessions) {
    const li = document.createElement('li');
    if (s.id === state.sessionId) li.classList.add('active');
    li.innerHTML = `
      <span class="meta">
        <span class="name"></span>
        <span class="sub"></span>
      </span>
      <button class="rename" title="Rename">✎</button>
      <button class="kill" title="Close session">✕</button>`;
    li.querySelector('.name').textContent = s.name;
    li.querySelector('.sub').textContent = `${s.cwd} · ${s.cols}×${s.rows}`;
    li.querySelector('.meta').addEventListener('click', () => {
      state.term.reset();
      connect(s.id);
      hidePanel();
    });
    li.querySelector('.rename').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const name = prompt('Name this session', s.name);
      if (!name) return;
      await api('PATCH', `/api/sessions/${s.id}`, { name });
      if (s.id === state.sessionId) els.title.textContent = name;
      refreshSessions();
    });
    li.querySelector('.kill').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await api('DELETE', `/api/sessions/${s.id}`);
      if (s.id === state.sessionId) { state.sessionId = null; state.term.reset(); }
      refreshSessions();
    });
    els.list.appendChild(li);
  }
  return sessions;
}

async function newSession(command, name) {
  const { cols, rows } = state.term;
  const cwd = els.cwd.value.trim() || undefined;
  const session = await api('POST', '/api/sessions', { command, name, cwd, cols, rows });
  state.term.reset();
  connect(session.id);
  hidePanel();
  refreshSessions();
}

function showPanel() { els.panel.hidden = false; refreshSessions(); }
function hidePanel() { els.panel.hidden = true; state.term?.focus(); }

// --- wiring ------------------------------------------------------------------

$('#sessions-btn').addEventListener('click', showPanel);
$('#close-panel').addEventListener('click', hidePanel);
$('#new-shell').addEventListener('click', () => newSession(undefined, 'shell'));
$('#new-claude').addEventListener('click', () => newSession('claude', 'claude'));

$('#font-smaller').addEventListener('click', () => setFontSize(state.fontSize - 1));
$('#font-bigger').addEventListener('click', () => setFontSize(state.fontSize + 1));

window.addEventListener('resize', doFit);
// iOS changes the visual viewport when the keyboard appears; the terminal has
// to shrink to match or the cursor hides behind the keyboard.
window.visualViewport?.addEventListener('resize', doFit);
// Rotation settles a frame or two after the event, so measure again afterwards.
window.addEventListener('orientationchange', () => {
  doFit();
  setTimeout(doFit, 150);
  setTimeout(doFit, 500);
});

document.addEventListener('DOMContentLoaded', start);
if (document.readyState !== 'loading') start();

let started = false;
async function start() {
  if (started) return;
  started = true;

  try {
    const saved = Number(localStorage.getItem('ct.fontSize'));
    if (saved >= 8 && saved <= 24) state.fontSize = saved;
  } catch { /* private mode — the default is fine */ }

  makeTerminal();
  setupKeybar();
  setFontSize(state.fontSize);

  // Attach to whatever is already running; only make a session if there is none.
  try {
    const sessions = await refreshSessions();
    if (sessions.length) connect(sessions[0].id);
    else await newSession(undefined, 'shell');
  } catch (err) {
    state.term.write(`\r\n\x1b[31mCould not reach the server: ${err.message}\x1b[0m\r\n`);
    setStatus('offline', 'closed');
  }
}
