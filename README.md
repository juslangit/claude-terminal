# claude-terminal

A real terminal on your phone, attached to your own computer.

Not a chat app that describes what your terminal is doing — the terminal itself. Colours, cursor,
full-screen apps, scrollback, Ctrl-C, Esc, Tab, arrows. Claude Code runs in it exactly as it does at
your desk, and so does `vim`, `git`, `top`, or anything else you'd type.

> **Status: early.** Phase 1 works — a terminal in a desktop browser, driven by the same API the
> phone will use. The phone UI (key bar, rotation, touch scrollback) is phase 2.

## How it works

```
Phone (xterm.js, PWA)  ──WebSocket over Tailscale──►  Node server (127.0.0.1)
                                                            │
                                            send-keys ──────┼────── pipe-pane
                                                            ▼
                                                    tmux  →  your shell
```

tmux owns the pty, which means two useful things fall out for free: sessions survive your phone
closing, and the same session can be attached at your desk with `tmux -L claude-terminal attach`.

The server uses **no npm packages** — Node's built-in modules only, including a hand-rolled
WebSocket implementation. xterm.js is vendored into `public/vendor/`. There is nothing to install
and nothing to build.

## Requirements

- Node 22 or newer
- tmux
- Tailscale (to reach it from a phone)

## Running it

```bash
brew install tmux          # macOS; apt install tmux on Linux/WSL
node server.mjs
```

Then open <http://127.0.0.1:4478>. Set `CT_PORT` to use a different port.

To reach it from a phone, put it on your own Tailscale network — see [Security](#security).

## Security

**This runs arbitrary commands on your computer.** Treat it accordingly.

- The server binds to `127.0.0.1` only. It is never directly exposed, by design.
- **Requests must come from the app's own page.** Any site you visit can reach `127.0.0.1` from your
  browser, so the server rejects requests carrying another site's `Origin` — on the API and on the
  WebSocket, which CORS does not protect at all.
- **Every request needs a token**, kept in `data/token` (mode 600) and handed to the page when the
  server serves it. This covers callers that are not browsers, including the case where someone
  exposes the port beyond loopback by mistake.
- Reaching it from a phone is Tailscale's job: `tailscale serve` puts it on your private tailnet,
  where only your own signed-in devices can see it.
- **Never** put this behind a public URL, a port forward, or an ngrok tunnel. There is no
  authentication, because the network is the authentication.
- There is no hosted version and there never will be. Everyone runs their own.

To call the API yourself, pass the token: `curl -H "x-ct-token: $(cat data/token)" http://127.0.0.1:4478/api/sessions`

## Testing

```bash
node dev/e2e.mjs
```

Drives the server exactly as the browser does — handshake, typing, UTF-8, Ctrl-C, resize, reconnect,
alternate-screen TUIs, arrow keys, Claude Code itself, and the access-control rules. 32 checks.

## Layout

| Path | What it is |
|---|---|
| `server.mjs` | HTTP + WebSocket server, session API |
| `lib/ws.mjs` | Minimal RFC 6455 WebSocket server |
| `lib/tmux.mjs` | tmux session management — the pty layer |
| `lib/auth.mjs` | Origin and token checks |
| `bin/pipe-client.mjs` | Tiny helper tmux runs to forward pane output |
| `public/` | The web app; `public/vendor/` holds xterm.js |
| `dev/e2e.mjs` | End-to-end checks |

## Licence

Not yet chosen.
