/**
 * The Yjs socket compresses what it sends.
 *
 * The hub board is ONE ws room per workspace, and a fresh tab receives the
 * whole board state in sync step 2 — one uncompressed binary frame, measured
 * at 1,264,566 bytes over the live hub board's persisted state on 2026-08-29,
 * deflating to 431,733 (2.9×). Browsers offer permessage-deflate on every
 * WebSocket by default; the server has to accept it AND ask for compression
 * on each send — Bun's `perMessageDeflate: true` only negotiates, and
 * `sendBinary(data)` without `compress = true` still goes out raw (measured:
 * the extension negotiated, the wire byte count unchanged).
 *
 * So the assertion is on the WIRE: a hand-rolled upgrade over a raw TCP
 * socket, then the RSV1 bit of the frames the server sends. Bun's own
 * WebSocket client never offers the extension, so a test through it would
 * pass vacuously. The negative control — no offer, no RSV1 — proves the
 * check reads a real negotiation rather than a bit the server always sets.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { workspaceRoomId } from '../src/task-projection.ts';

let dataDir: string;
let handle: ServerHandle;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cw-ws-deflate-'));
  handle = createServer({ dedicatedListener: true, port: 0, dataDir });
});

afterEach(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A masked client binary frame (RFC 6455 §5.2/§5.3), RSV1 clear. */
function clientFrame(payload: Uint8Array): Uint8Array {
  const mask = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
  const len = payload.byteLength;
  const header = len < 126 ? [0x82, 0x80 | len] : [0x82, 0x80 | 126, (len >> 8) & 0xff, len & 0xff];
  const out = new Uint8Array(header.length + 4 + len);
  out.set(header, 0);
  out.set(mask, header.length);
  for (let i = 0; i < len; i++) out[header.length + 4 + i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  return out;
}

/** Split a byte stream of server frames into their first header bytes.
 *  Returns undefined when the stream ends mid-frame (not enough bytes). */
function frameHeads(stream: Uint8Array): number[] {
  const heads: number[] = [];
  let i = 0;
  while (i + 2 <= stream.byteLength) {
    const b0 = stream[i] ?? 0;
    let len = (stream[i + 1] ?? 0) & 0x7f;
    let hdr = 2;
    if (len === 126) {
      len = ((stream[i + 2] ?? 0) << 8) | (stream[i + 3] ?? 0);
      hdr = 4;
    } else if (len === 127) {
      len = Number(new DataView(stream.buffer, stream.byteOffset + i + 2, 8).getBigUint64(0));
      hdr = 10;
    }
    if (i + hdr + len > stream.byteLength) break;
    heads.push(b0);
    i += hdr + len;
  }
  return heads;
}

/** Upgrade, send the client's sync step 1, collect server frames for a
 *  moment, and report the negotiated extension plus every frame's RSV1. */
async function handshakeAndSync(
  path: string,
  extensions?: string,
): Promise<{ status: number; extension: string; rsv1: boolean[] }> {
  const request = [
    `GET ${path} HTTP/1.1`,
    `Host: localhost:${handle.port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    ...(extensions ? [`Sec-WebSocket-Extensions: ${extensions}`] : []),
    '',
    '',
  ].join('\r\n');
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0); // MSG_SYNC
  syncProtocol.writeSyncStep1(enc, new Y.Doc());
  const step1 = clientFrame(encoding.toUint8Array(enc));

  const chunks: Uint8Array[] = [];
  let head = '';
  let headDone = false;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no upgrade response within 5s')), 5000);
    let settle: ReturnType<typeof setTimeout> | null = null;
    Bun.connect({
      hostname: 'localhost',
      port: handle.port,
      socket: {
        open(sock) {
          sock.write(request);
        },
        data(sock, chunk) {
          let bytes = new Uint8Array(chunk);
          if (!headDone) {
            head += Buffer.from(bytes).toString('latin1');
            const end = head.indexOf('\r\n\r\n');
            if (end < 0) return;
            const rest = Buffer.from(head.slice(end + 4), 'latin1');
            head = head.slice(0, end);
            headDone = true;
            clearTimeout(timer);
            bytes = new Uint8Array(rest);
            sock.write(step1);
          }
          if (bytes.byteLength > 0) chunks.push(bytes);
          // Sync step 2 lands right after step 1's reply; give the server a
          // beat to finish, then read whatever arrived.
          if (settle) clearTimeout(settle);
          settle = setTimeout(() => {
            sock.end();
            resolve();
          }, 300);
        },
        error(_sock, err) {
          clearTimeout(timer);
          reject(err);
        },
      },
    }).catch(reject);
  });
  const [statusLine, ...headerLines] = head.split('\r\n');
  const status = Number(statusLine?.split(' ')[1] ?? 0);
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const i = line.indexOf(':');
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  const stream = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) {
    stream.set(c, off);
    off += c.byteLength;
  }
  return {
    status,
    extension: headers.get('sec-websocket-extensions') ?? '',
    rsv1: frameHeads(stream).map((b0) => (b0 & 0x40) !== 0),
  };
}

describe('yjs websocket compression', () => {
  it('negotiates permessage-deflate and sends the sync frames compressed', async () => {
    const created = await fetch(`http://localhost:${handle.port}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'deflate board', goal: 'Load Home fast.' }),
    });
    expect(created.status).toBe(200);
    const { workspace } = (await created.json()) as { workspace: { id: string } };
    // Enough board state that sync step 2 is a real frame, not a header.
    for (let i = 0; i < 20; i++) {
      const r = await fetch(
        `http://localhost:${handle.port}/api/workspaces/${workspace.id}/tasks`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: `Row ${i}`,
            assignee: 'human',
            body: `Bryan can open Home so that the board paints fast. ${'Detail. '.repeat(40)}`,
          }),
        },
      );
      expect(r.status).toBe(200);
    }
    const path = `/y/${encodeURIComponent(workspaceRoomId(workspace.id))}?type=workspace`;

    const offered = await handshakeAndSync(path, 'permessage-deflate; client_max_window_bits');
    expect(offered.status).toBe(101);
    expect(offered.extension).toContain('permessage-deflate');
    expect(offered.rsv1.length).toBeGreaterThanOrEqual(2); // step 1 reply + step 2
    expect(offered.rsv1.every(Boolean)).toBe(true);

    // Negative control: no offer → no extension, and no frame carries RSV1.
    const plain = await handshakeAndSync(path);
    expect(plain.status).toBe(101);
    expect(plain.extension).not.toContain('permessage-deflate');
    expect(plain.rsv1.length).toBeGreaterThanOrEqual(2);
    expect(plain.rsv1.some(Boolean)).toBe(false);
  });
});
