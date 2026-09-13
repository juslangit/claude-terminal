// tmux session management.
//
// tmux owns the pty (D-002). Output comes back through `pipe-pane`, input goes
// in with `send-keys -H`, and size is set with `resize-window`. That gives a
// real pty with no native modules.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const execFileAsync = promisify(execFile);

export const SOCKET_NAME = 'claude-terminal';

/** Run a tmux command against our own tmux server. */
async function tmux(...args) {
  const { stdout } = await execFileAsync('tmux', ['-L', SOCKET_NAME, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024, // capture-pane with scrollback can be large
  });
  return stdout;
}

/** Same, but never throws — for commands where failure is not interesting. */
async function tmuxQuiet(...args) {
  try { return await tmux(...args); } catch { return null; }
}

export async function isAvailable() {
  try {
    const { stdout } = await execFileAsync('tmux', ['-V'], { encoding: 'utf8' });
    return stdout.trim();
  } catch {
    return null;
  }
}


// A unix socket path must fit in sockaddr_un.sun_path — 104 bytes on macOS,
// 108 on Linux. A deep project directory blows past that, so fall back to the
// system temp dir, which is short, when the natural path would be too long.
const SUN_PATH_MAX = 100;

function socketPathFor(runDir, id) {
  const preferred = path.join(runDir, `${id}.sock`);
  if (Buffer.byteLength(preferred) <= SUN_PATH_MAX) return preferred;

  const fallbackDir = path.join(os.tmpdir(), `claude-terminal-${process.getuid?.() ?? 0}`);
  fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
  const fallback = path.join(fallbackDir, `${id}.sock`);
  if (Buffer.byteLength(fallback) > SUN_PATH_MAX) {
    throw new Error(`no socket path short enough for a unix socket (tried ${preferred} and ${fallback})`);
  }
  return fallback;
}

/**
 * One terminal session: a tmux session, plus the unix socket its pane output
 * arrives on, plus the set of connected websocket clients.
 */
class Session {
  constructor(manager, { id, name, cwd, command, cols, rows }) {
    this.manager = manager;
    this.id = id;
    this.name = name;
    this.cwd = cwd;
    this.command = command;
    this.cols = cols;
    this.rows = rows;
    this.createdAt = Date.now();

    this.subscribers = new Set();
    // Keystrokes arrive as separate messages and `send-keys` is a separate
    // process each time, so writes must be serialised or they land out of
    // order. See write().
    this.writeQueue = [];
    this.writing = false;
    this.sockPath = socketPathFor(manager.runDir, id);
    this.sockServer = null;
    this.alive = true;
  }

  /** Start listening for pane output before tmux is told to send any. */
  async #listen() {
    try { fs.unlinkSync(this.sockPath); } catch { /* not there, fine */ }

    await new Promise((resolve, reject) => {
      this.sockServer = net.createServer((conn) => {
        conn.on('data', (chunk) => this.#broadcast(chunk));
        conn.on('error', () => {});
      });
      this.sockServer.on('error', reject);
      this.sockServer.listen(this.sockPath, resolve);
    });
    fs.chmodSync(this.sockPath, 0o600);
  }

  #broadcast(chunk) {
    for (const fn of this.subscribers) {
      try { fn(chunk); } catch { /* a bad subscriber must not stop the others */ }
    }
  }

  /**
   * Take over a tmux session that is already running — one this server created
   * before it was restarted. The tmux session kept running the whole time; all
   * that was lost was this process's knowledge of it.
   */
  async adopt() {
    await this.#listen();
    await this.#startPipe();
    return this;
  }

  async create() {
    await this.#listen();

    const args = [
      'new-session', '-d',
      '-s', this.id,
      '-x', String(this.cols),
      '-y', String(this.rows),
      '-c', this.cwd,
    ];
    if (this.command) args.push(this.command);
    await tmux(...args);

    // The pane must keep the size we set, not follow whichever client is
    // attached — the phone decides the size here, not a Terminal window.
    await tmuxQuiet('set-option', '-t', this.id, 'window-size', 'manual');
    // No status bar: the pane should fill the whole terminal.
    await tmuxQuiet('set-option', '-t', this.id, 'status', 'off');
    // The program's output goes straight to xterm.js, so it should emit the
    // sequences xterm.js understands.
    await tmuxQuiet('set-option', '-t', this.id, 'default-terminal', 'xterm-256color');
    // Keep the session alive when the last client detaches.
    await tmuxQuiet('set-option', '-t', this.id, 'destroy-unattached', 'off');

    await this.#startPipe();
    return this;
  }

  /** Point the pane's output at our unix socket. */
  async #startPipe() {
    const helper = path.join(this.manager.rootDir, 'bin', 'pipe-client.mjs');
    const cmd = `exec ${shellQuote(process.execPath)} ${shellQuote(helper)} ${shellQuote(this.sockPath)}`;
    // -O streams the pane's output; -o would toggle it off if already on.
    await tmux('pipe-pane', '-t', this.id, '-O', cmd);
  }

  /** Re-attach output streaming after a tmux restart or a dropped helper. */
  async ensurePipe() {
    const out = await tmuxQuiet('display-message', '-p', '-t', this.id, '#{pane_pipe}');
    if (out === null) return false;
    if (out.trim() !== '1') await this.#startPipe();
    return true;
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /**
   * The visible screen as bytes, used to fill a terminal the moment a client
   * connects. `pipe-pane` only streams from when it was switched on, so without
   * this a fresh connection stares at a blank screen until something redraws.
   */
  async snapshot({ scrollback = 0 } = {}) {
    const args = ['capture-pane', '-p', '-e', '-J', '-t', this.id];
    if (scrollback > 0) args.push('-S', `-${scrollback}`);
    const out = await tmuxQuiet(...args);
    if (out === null) return null;
    // capture-pane gives newline-separated lines; a terminal needs CRLF.
    // Trailing blank lines are dropped so the cursor does not end up far below
    // the content.
    const lines = out.replace(/\n+$/, '').split('\n');
    return '\x1b[H\x1b[2J' + lines.join('\r\n');
  }

  /**
   * Write raw bytes to the pane. `send-keys -H` takes hex, which is the only
   * form that carries control characters and UTF-8 through unambiguously.
   *
   * Writes are queued rather than sent straight away. Every keystroke arrives
   * as its own WebSocket message, so without a queue several `send-keys`
   * processes run at once and the bytes reach the shell out of order — typing
   * "from" and getting "rfo m" back. Queuing also lets a fast burst of
   * keystrokes coalesce into one `send-keys` call, which cuts the number of
   * processes spawned while typing.
   */
  async write(buf) {
    if (!buf.length) return;
    this.writeQueue.push(buf);
    if (this.writing) return;

    this.writing = true;
    try {
      while (this.writeQueue.length) {
        // Take everything queued so far as one batch — order is preserved
        // because the queue is FIFO and only this loop drains it.
        const batch = Buffer.concat(this.writeQueue.splice(0, this.writeQueue.length));
        await this.#flush(batch);
      }
    } finally {
      this.writing = false;
    }
  }

  async #flush(buf) {
    // Command lines have a length limit and a paste can be large, so send in
    // chunks. Each byte costs 3 characters of argv ("ff ").
    const CHUNK = 512;
    for (let i = 0; i < buf.length; i += CHUNK) {
      const slice = buf.subarray(i, i + CHUNK);
      const hex = [];
      for (const byte of slice) hex.push(byte.toString(16).padStart(2, '0'));
      await tmux('send-keys', '-t', this.id, '-H', ...hex);
    }
  }

  /**
   * Resize the pane. Programs get SIGWINCH and redraw, which is also how a
   * reconnecting client gets a full-screen app to repaint itself.
   */
  async resize(cols, rows) {
    cols = Math.max(2, Math.min(1000, Math.floor(cols)));
    rows = Math.max(2, Math.min(1000, Math.floor(rows)));
    if (cols === this.cols && rows === this.rows) return false;
    this.cols = cols;
    this.rows = rows;
    await tmuxQuiet('resize-window', '-t', this.id, '-x', String(cols), '-y', String(rows));
    return true;
  }

  /**
   * Make a full-screen program repaint. Resizing by a column and back triggers
   * two SIGWINCHes, which is the only reliable way to get a TUI to redraw
   * without typing anything into it.
   */
  async forceRedraw() {
    const { cols, rows } = this;
    await tmuxQuiet('resize-window', '-t', this.id, '-x', String(cols + 1), '-y', String(rows));
    await new Promise((r) => setTimeout(r, 40));
    await tmuxQuiet('resize-window', '-t', this.id, '-x', String(cols), '-y', String(rows));
  }

  /**
   * Whether a full-screen program (claude, vim, htop) currently owns the pane.
   * capture-pane cannot faithfully reproduce an alternate screen, so a client
   * connecting to one is better served by making the program repaint itself.
   */
  async isAltScreen() {
    const out = await tmuxQuiet('display-message', '-p', '-t', this.id, '#{alternate_on}');
    return out !== null && out.trim() === '1';
  }

  async exists() {
    const out = await tmuxQuiet('has-session', '-t', this.id);
    return out !== null;
  }

  async kill() {
    this.alive = false;
    await tmuxQuiet('kill-session', '-t', this.id);
    this.#cleanup();
  }

  /** Close our end without touching the tmux session. */
  detachSocket() {
    this.#cleanup();
  }

  #cleanup() {
    if (this.sockServer) {
      try { this.sockServer.close(); } catch {}
      this.sockServer = null;
    }
    try { fs.unlinkSync(this.sockPath); } catch {}
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      clients: this.subscribers.size,
    };
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export class SessionManager {
  constructor({ rootDir, runDir, stateFile }) {
    this.rootDir = rootDir;
    this.runDir = runDir;
    // Names and working directories are the only things tmux does not remember
    // for us, so they are the only things worth writing down.
    this.stateFile = stateFile || path.join(runDir, '..', 'sessions.json');
    this.sessions = new Map();
    fs.mkdirSync(runDir, { recursive: true });
  }

  #saveState() {
    const state = {};
    for (const [id, s] of this.sessions) {
      state[id] = { name: s.name, cwd: s.cwd, createdAt: s.createdAt };
    }
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('could not save session names:', err.message);
    }
  }

  #loadState() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return {}; }
  }

  /**
   * Re-attach to sessions left running by a previous run of this server.
   *
   * Without this a restart — a reboot, a crash, a code change — strands every
   * running session: tmux keeps them alive but nothing can reach them again
   * except `tmux attach` from a terminal. Since the server is meant to start at
   * login, that would happen routinely, in the middle of long Claude Code runs.
   */
  async adoptExisting() {
    const out = await tmuxQuiet('list-sessions', '-F', '#{session_name} #{window_width} #{window_height}');
    if (!out) return 0;

    const saved = this.#loadState();
    let adopted = 0;

    for (const line of out.trim().split('\n')) {
      const [id, width, height] = line.trim().split(/\s+/);
      // Only sessions this server created — someone else's tmux sessions on the
      // same socket are none of our business.
      if (!/^ct-[0-9a-f]{8}$/.test(id) || this.sessions.has(id)) continue;

      const meta = saved[id] || {};
      const session = new Session(this, {
        id,
        name: meta.name || id,
        cwd: meta.cwd || process.env.HOME,
        command: null,
        cols: Number(width) || 80,
        rows: Number(height) || 24,
      });
      if (meta.createdAt) session.createdAt = meta.createdAt;

      try {
        await session.adopt();
        this.sessions.set(id, session);
        adopted++;
      } catch (err) {
        console.error(`could not adopt ${id}:`, err.message);
      }
    }

    if (adopted) this.#saveState();
    return adopted;
  }

  async create({ name, cwd, command, cols = 80, rows = 24 } = {}) {
    const id = `ct-${crypto.randomBytes(4).toString('hex')}`;
    const resolvedCwd = cwd && fs.existsSync(cwd) ? cwd : process.env.HOME;
    const session = new Session(this, {
      id,
      name: name || 'terminal',
      cwd: resolvedCwd,
      command,
      cols,
      rows,
    });
    await session.create();
    this.sessions.set(id, session);
    this.#saveState();
    return session;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  list() {
    return [...this.sessions.values()].map((s) => s.toJSON());
  }

  async remove(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    await session.kill();
    this.sessions.delete(id);
    this.#saveState();
    return true;
  }

  /** Drop sessions whose tmux session has gone away (killed at the desk, say). */
  async reap() {
    let changed = false;
    for (const [id, session] of this.sessions) {
      if (!(await session.exists())) {
        session.alive = false;
        this.sessions.delete(id);
        changed = true;
      }
    }
    if (changed) this.#saveState();
  }

  /** Rename a session. tmux does not track this, so it lives in our state file. */
  rename(id, name) {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.name = String(name).slice(0, 60) || session.name;
    this.#saveState();
    return true;
  }

  /**
   * Stop tracking sessions without killing them. The server going away must
   * never take running work with it — adoptExisting() picks them up next time.
   */
  detach() {
    for (const session of this.sessions.values()) session.detachSocket();
    this.sessions.clear();
  }

  /** Kill everything. Only for tests and an explicit teardown. */
  async shutdown() {
    for (const id of [...this.sessions.keys()]) await this.remove(id);
    await tmuxQuiet('kill-server');
  }
}
