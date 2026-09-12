// Run by tmux as the `pipe-pane` target. tmux hands the pane's raw output on
// stdin; this forwards it to the server over a unix socket.
//
// A unix socket is used rather than a fifo because a fifo's reader sees EOF
// every time the writer closes, which makes reconnects fiddly. Node is already
// required to run the server, so this costs no extra dependency.

import net from 'node:net';

const sockPath = process.argv[2];
if (!sockPath) process.exit(1);

const sock = net.connect(sockPath);
sock.on('error', () => process.exit(0)); // server gone — nothing to forward to
process.stdin.pipe(sock);
process.stdin.on('end', () => sock.end());
