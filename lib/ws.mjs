// Minimal RFC 6455 WebSocket server.
//
// Node has no built-in WebSocket server and this project takes no npm packages
// on the backend (D-002), so the handshake and framing are done here by hand.
// Only what a terminal needs: text and binary frames, ping/pong, close.

import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC 6455 §1.3

// RFC 6455 §1.3 publishes a worked example. Checking it at load time turns a
// silently-broken handshake (the client just fails to connect, with no useful
// error) into an immediate, obvious failure.
if (crypto.createHash('sha1').update('dGhlIHNhbXBsZSBub25jZQ==' + GUID).digest('base64')
    !== 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=') {
  throw new Error('WebSocket GUID is wrong — the handshake would fail for every client');
}

const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** Build a server->client frame. Server frames are never masked. */
function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

export class WebSocket {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.handlers = { message: [], close: [] };
    // Fragmented messages are reassembled here.
    this.fragOp = null;
    this.fragParts = [];

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#onClose());
    socket.on('error', () => this.#onClose());
  }

  on(event, fn) {
    if (this.handlers[event]) this.handlers[event].push(fn);
    return this;
  }

  #emit(event, ...args) {
    for (const fn of this.handlers[event]) {
      try { fn(...args); } catch (err) { console.error(`ws ${event} handler:`, err); }
    }
  }

  #onClose() {
    if (this.closed) return;
    this.closed = true;
    this.#emit('close');
  }

  #onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    // Pull as many complete frames out of the buffer as it holds.
    for (;;) {
      const parsed = this.#readFrame();
      if (!parsed) break;
      this.#handleFrame(parsed);
      if (this.closed) break;
    }
  }

  /** Read one frame off the front of the buffer, or null if incomplete. */
  #readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;

    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (b.length < offset + 2) return null;
      len = b.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (b.length < offset + 8) return null;
      const big = b.readBigUInt64BE(offset);
      // A frame this large is not something a terminal ever sends.
      if (big > 0x7fffffffn) { this.close(1009, 'frame too large'); return null; }
      len = Number(big);
      offset += 8;
    }

    let mask = null;
    if (masked) {
      if (b.length < offset + 4) return null;
      mask = b.subarray(offset, offset + 4);
      offset += 4;
    }

    if (b.length < offset + len) return null;

    const payload = Buffer.from(b.subarray(offset, offset + len));
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    this.buf = b.subarray(offset + len);
    return { fin, opcode, payload };
  }

  #handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP.PING:
        this.#send(OP.PONG, payload);
        return;
      case OP.PONG:
        return;
      case OP.CLOSE:
        this.close(1000, '');
        return;
      case OP.CONT: {
        if (this.fragOp === null) return; // continuation with nothing to continue
        this.fragParts.push(payload);
        if (!fin) return;
        const full = Buffer.concat(this.fragParts);
        const op = this.fragOp;
        this.fragOp = null;
        this.fragParts = [];
        this.#deliver(op, full);
        return;
      }
      case OP.TEXT:
      case OP.BIN: {
        if (!fin) {
          this.fragOp = opcode;
          this.fragParts = [payload];
          return;
        }
        this.#deliver(opcode, payload);
        return;
      }
      default:
        this.close(1002, 'bad opcode');
    }
  }

  #deliver(opcode, payload) {
    this.#emit('message', payload, opcode === OP.BIN);
  }

  #send(opcode, payload) {
    if (this.closed || this.socket.destroyed) return false;
    return this.socket.write(frame(opcode, payload));
  }

  /** Send text. Returns false when the socket wants backpressure. */
  sendText(str) {
    return this.#send(OP.TEXT, Buffer.from(str, 'utf8'));
  }

  /** Send raw bytes — terminal output goes out this way. */
  sendBinary(buf) {
    return this.#send(OP.BIN, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  }

  ping() {
    return this.#send(OP.PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.#send(OP.CLOSE, body);
    this.closed = true;
    this.socket.end();
    this.#emit('close');
  }
}

/**
 * Complete the HTTP upgrade handshake. Returns a WebSocket, or null if the
 * request was not a valid upgrade (the socket is destroyed in that case).
 */
export function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
    socket.destroy();
    return null;
  }

  const digest = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${digest}\r\n\r\n`
  );
  socket.setNoDelay(true); // terminals are latency-sensitive, not throughput-bound
  return new WebSocket(socket);
}
