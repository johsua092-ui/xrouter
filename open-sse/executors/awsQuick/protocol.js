// Amazon Quick bidirectional chat WebSocket client (social/AIDP transport).
//
// Ported from magpie-aws-quick lib/quickws.mjs (MIT) — wire protocol reverse-
// engineered from the desktop renderer, v1.2.4660:
//   URL: wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream
//        ?surfaceType=<surface>&token=<id_token>&outpostId=<id>
//        &workingSessionId=<uuid>&channel=<beta|prod>
//   out: binary frame = UTF8 JSON {"eventType":"rawInputEvent",
//        "payload":{"payload":base64(utf8({"type":…,"payload":{…}}))}}
//   in:  AWS event-stream frames; :event-type=rawOutputEvent,
//        body = JSON {"payload":base64(utf8({"type":…,"thread_id":…,"payload":{…}}))}
//
// Events observed: session_established, connected, status, message_start,
// text_delta, thinking_delta, turn_usage, text_complete, message_complete,
// task_list_update, runs_updated, title_generated, keepalive.
//
// Gateway adaptations vs the reference: one socket is cached per connection on
// globalThis (Next hot-reload recreates module state — a module-level Map would
// silently double sockets), and turns are serialized behind a per-socket mutex
// because Quick allows only ~2 concurrent turns per account.

const te = new TextEncoder();
const td = new TextDecoder();

// ── AWS event-stream framing (port of the app's esDrain) ────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const HV = { BOOL_TRUE: 0, BOOL_FALSE: 1, BYTE: 2, SHORT: 3, INT: 4, LONG: 5, BYTES: 6, STRING: 7, TIMESTAMP: 8, UUID: 9 };
const ES_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

function esDrain(buffer) {
  const messages = [];
  const n = buffer.length;
  let pos = 0;
  while (pos + 16 <= n) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + pos);
    const totalLen = view.getUint32(0, false);
    if (totalLen < 16 || totalLen > ES_MAX_MESSAGE_BYTES) {
      pos += 1;
      continue;
    }
    if (pos + totalLen > n) break;
    const headersLen = view.getUint32(4, false);
    const hstart = pos + 12;
    const hend = hstart + headersLen;
    const headers = {};
    let j = hstart;
    try {
      while (j < hend) {
        const nl = buffer[j++];
        const name = td.decode(buffer.slice(j, j + nl));
        j += nl;
        const vt = buffer[j++];
        if (vt === HV.BOOL_TRUE) headers[name] = true;
        else if (vt === HV.BOOL_FALSE) headers[name] = false;
        else if (vt === HV.BYTE) {
          headers[name] = buffer[j];
          j += 1;
        } else if (vt === HV.SHORT) {
          headers[name] = (buffer[j] << 8) | buffer[j + 1];
          j += 2;
        } else if (vt === HV.INT) {
          headers[name] = new DataView(buffer.buffer, buffer.byteOffset + j).getUint32(0, false);
          j += 4;
        } else if (vt === HV.LONG || vt === HV.TIMESTAMP) {
          let v = 0;
          for (let k = 0; k < 8; k++) v = v * 256 + buffer[j + k];
          headers[name] = v;
          j += 8;
        } else if (vt === HV.BYTES || vt === HV.STRING) {
          const l = (buffer[j] << 8) | buffer[j + 1];
          j += 2;
          const raw = buffer.slice(j, j + l);
          j += l;
          headers[name] = vt === HV.STRING ? td.decode(raw) : raw;
        } else if (vt === HV.UUID) {
          headers[name] = buffer.slice(j, j + 16);
          j += 16;
        } else break;
      }
      const payload = buffer.slice(hend, pos + totalLen - 4);
      messages.push({ headers, payload });
    } catch {
      /* malformed — skip */
    }
    pos += totalLen;
  }
  return { messages, consumed: pos };
}

const b64e = (s) => Buffer.from(s, "utf8").toString("base64");
const b64d = (s) => Buffer.from(s, "base64").toString("utf8");

function wrapEvent(innerJson) {
  return te.encode(JSON.stringify({ eventType: "rawInputEvent", payload: { payload: b64e(innerJson) } }));
}

export class QuickWsError extends Error {
  constructor(message, { code, kind } = {}) {
    super(message);
    this.name = "QuickWsError";
    this.code = code;
    this.kind = kind || "ws";
  }
}

const PING_MS = 25_000;
const CONNECT_TIMEOUT_MS = 30_000;
const SESSION_ACK_TIMEOUT_MS = 8_000;

async function resolveWebSocketImpl() {
  if (globalThis.WebSocket) return globalThis.WebSocket;
  const wsModule = await import("ws");
  return wsModule.WebSocket || wsModule.default;
}

/**
 * One bidi socket, multiplexed across threads by thread_id.
 * Events are dispatched to per-thread waiters registered via turn().
 */
export class QuickSocket {
  /**
   * @param {object} opts
   * @param {Function} opts.getSession async () => {id_token, ws_host, actor_arn} (fresh token)
   * @param {string} [opts.outpostId] device/outpost id (omitted for OAuth sessions)
   * @param {object} [opts.extra] surfaceType/appVersion/channel overrides
   * @param {Function} [opts.log]
   */
  constructor({ getSession, outpostId, extra = {}, log = () => {} }) {
    this.getSession = getSession;
    this.outpostId = outpostId;
    this.extra = extra;
    this.log = log;
    this.ws = null;
    this.buf = new Uint8Array(0);
    this.waiters = new Map(); // threadId -> waiter {push, fail}
    this.connecting = null;
    this.closed = false;
    this._turnChain = null; // per-socket turn mutex (see acquireTurn)
  }

  async connect() {
    if (this.ws && this.ws.readyState === 1) return;
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async _connect() {
    if (this.closed) throw new QuickWsError("socket closed", { kind: "ws" });
    const sess = await this.getSession();
    if (!sess?.ws_host || !sess?.id_token) throw new QuickWsError("Quick session is missing ws_host/id_token — reconnect the provider", { kind: "auth" });
    // ws_host is normally a bare hostname (→ wss); tests/local gateways may hand
    // us a full ws:// or wss:// base already.
    const base = /^wss?:\/\//.test(sess.ws_host) ? sess.ws_host.replace(/\/+$/, "") : `wss://${sess.ws_host}`;
    const surface = this.extra.surfaceType || "QUICK_WORK_DESKTOP_WINDOWS";
    // The desktop client always stamps its channel; prod is the safe default.
    const channel = this.extra.channel ?? "prod";
    const url =
      `${base}/streaming/quickwork-chat-bidirectional-stream` +
      `?surfaceType=${encodeURIComponent(surface)}` +
      `&token=${encodeURIComponent(sess.id_token)}` +
      // outpostId is omitted for OAuth-provisioned sessions (no local outpost)
      (this.outpostId ? `&outpostId=${encodeURIComponent(this.outpostId)}` : "") +
      `&workingSessionId=${encodeURIComponent(crypto.randomUUID())}` +
      (channel ? `&channel=${encodeURIComponent(channel)}` : "") +
      (this.extra.agentRuntimeArnOverride ? `&agentRuntimeArnOverride=${encodeURIComponent(this.extra.agentRuntimeArnOverride)}` : "");
    this.log(`[aws-quick][ws] connecting wss://${sess.ws_host}/…`);
    const WS = await resolveWebSocketImpl();
    const ws = new WS(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.buf = new Uint8Array(0);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new QuickWsError("WebSocket connect timeout", { kind: "timeout" })), CONNECT_TIMEOUT_MS);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new QuickWsError("WebSocket connect failed", { kind: "ws" }));
      };
      ws.onclose = (e) => {
        clearTimeout(timer);
        if (this.ws === ws) {
          this.ws = null;
          this._failAll(new QuickWsError(`socket closed ${e.code}`, { code: e.code }));
        }
        reject(new QuickWsError(`socket closed before open (${e.code})`, { code: e.code }));
      };
      ws.onmessage = (ev) => this._onFrame(ev);
    });
    this._sendRaw({
      type: "session_connect",
      payload: {
        actor_id: sess.actor_arn || "",
        surfaceType: surface,
        outpostId: this.outpostId,
        appVersion: this.extra.appVersion || "1.2.4660",
      },
    });
    // The server answers session_connect with session_established/connected;
    // user_message sent before that can be dropped. Wait for the ack (bounded —
    // a nonconforming server must not hang the connect forever). An error frame
    // during the handshake (e.g. LimitExceededException) rejects instead —
    // otherwise it lands with no waiters registered, gets dropped, and the
    // first turn hangs on a session that was never established.
    try {
      await new Promise((resolve, reject) => {
        const done = (fn, v) => {
          clearTimeout(t);
          this._sessionAck = null;
          this._connectFail = null;
          fn(v);
        };
        const t = setTimeout(() => done(resolve), SESSION_ACK_TIMEOUT_MS);
        t.unref?.();
        this._sessionAck = () => done(resolve);
        this._connectFail = (err) => done(reject, err);
      });
    } catch (e) {
      try {
        ws.close(4000, "connect failed");
      } catch {}
      if (this.ws === ws) this.ws = null;
      throw e;
    }
    this._startPing();
    this.log("[aws-quick][ws] open");
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      try {
        this._sendRaw({ type: "ping", payload: { timestamp: Date.now() } });
      } catch {}
    }, PING_MS);
    this._pingTimer.unref?.();
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _sendRaw(obj) {
    if (!this.ws || this.ws.readyState !== 1) throw new QuickWsError("socket not open", { kind: "ws" });
    this.ws.send(wrapEvent(JSON.stringify(obj)));
  }

  send(obj) {
    this._sendRaw(obj);
  }

  _onFrame(ev) {
    try {
      const data =
        typeof ev.data === "string"
          ? te.encode(ev.data)
          : ev.data instanceof ArrayBuffer
            ? new Uint8Array(ev.data)
            : ArrayBuffer.isView(ev.data)
              ? new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength)
              : new Uint8Array(ev.data?.buffer ?? ev.data);
      const merged = new Uint8Array(this.buf.length + data.length);
      merged.set(this.buf);
      merged.set(data, this.buf.length);
      const { messages, consumed } = esDrain(merged);
      this.buf = merged.slice(consumed);
      for (const m of messages) this._onEsMessage(m);
    } catch (e) {
      this.log?.(`[aws-quick][ws] frame decode error: ${e.message}`);
    }
  }

  _onEsMessage(m) {
    const mt = m.headers[":message-type"];
    if (mt === "error" || mt === "exception") {
      const code = m.headers[":error-code"] || m.headers[":exception-type"] || "error";
      const msg = m.headers[":error-message"] || td.decode(m.payload).slice(0, 300);
      this.log?.(`[aws-quick][ws] error frame ${code}: ${msg}`);
      this._dispatch({ type: "error", code: String(code), message: String(msg).slice(0, 500) });
      return;
    }
    if (m.headers[":event-type"] !== "rawOutputEvent" || m.payload.length === 0) return;
    let outer;
    try {
      outer = JSON.parse(td.decode(m.payload));
    } catch {
      return;
    }
    const inner = outer?.payload ? b64d(outer.payload) : null;
    if (!inner) return;
    let evt;
    try {
      evt = JSON.parse(inner);
    } catch {
      return;
    }
    this._dispatch(evt);
  }

  _dispatch(evt) {
    if ((evt.type === "session_established" || evt.type === "connected") && this._sessionAck) {
      this._sessionAck();
    }
    // Handshake-phase errors have no thread waiters yet — fail connect() instead
    // of broadcasting into the void.
    if (evt.type === "error" && this._connectFail) {
      this._connectFail(new QuickWsError(evt.message || `connect ${evt.code || "error"}`, { kind: "stream", code: evt.code }));
      return;
    }
    // Route by top-level thread_id; events without one go to all waiters (session-level).
    const tid = evt.thread_id || "";
    if (tid) {
      const w = this.waiters.get(tid);
      if (w) w.push(evt);
      return;
    }
    for (const w of this.waiters.values()) w.push(evt);
  }

  _failAll(err) {
    for (const w of this.waiters.values()) w.fail(err);
    this.waiters.clear();
  }

  /**
   * Run one chat turn on threadId; sends {type:'user_message'} then yields every
   * decoded event routed to that thread until a terminal event
   * (message_complete / stream_ended / turn_aborted) or failure.
   * @param {string} threadId
   * @param {object} payload user_message payload fields (text, agent_mode, …)
   * @param {object} [opts] {signal, onEvent}
   */
  async *turn(threadId, payload, { signal, onEvent } = {}) {
    await this.connect();
    if (this.waiters.has(threadId)) throw new QuickWsError(`thread ${threadId} already has an active turn`, { kind: "busy" });
    const q = [];
    let failed = null;
    let notify = null;
    const waiter = {
      push: (evt) => {
        q.push(evt);
        const n = notify;
        notify = null;
        n?.();
      },
      fail: (err) => {
        failed = err;
        const n = notify;
        notify = null;
        n?.();
      },
    };
    this.waiters.set(threadId, waiter);
    try {
      this.send({ type: "user_message", payload: { thread_id: threadId, ...payload } });
      for (;;) {
        while (q.length) {
          const evt = q.shift();
          onEvent?.(evt);
          yield evt;
          const t = evt.type;
          const p = evt.payload || {};
          // Turn terminators on this transport (verified against live traffic):
          //  - message_complete WITHOUT payload.continuation_expected===true is
          //    the last assistant message of the turn (the desktop renderer
          //    finalizes on exactly this condition); agentic turns emit one
          //    message_start…message_complete cycle per step and set the flag
          //    on all but the last.
          //  - stream_ended / turn_aborted end the stream/turn outright.
          //  - error / guardrail_blocked / stream_truncated are failures.
          if (t === "message_complete" && p.continuation_expected !== true) return;
          if (t === "stream_ended" || t === "turn_aborted") return;
          if (t === "error" || t === "guardrail_blocked" || t === "stream_truncated") {
            throw new QuickWsError(p.message || p.error || p.reason || `stream ${t}`, { kind: "stream" });
          }
        }
        if (signal?.aborted) throw new QuickWsError("aborted", { kind: "abort" });
        if (failed) throw failed;
        await new Promise((r) => {
          notify = r;
        });
      }
    } finally {
      if (this.waiters.get(threadId) === waiter) this.waiters.delete(threadId);
    }
  }

  /** Force a reconnect (e.g. after token refresh). */
  async reconnect() {
    this._stopPing();
    try {
      this.ws?.close(4001, "reconnect");
    } catch {}
    this.ws = null;
    await this.connect();
  }

  async close() {
    this.closed = true;
    this._stopPing();
    this._failAll(new QuickWsError("closed", { kind: "ws" }));
    try {
      this.ws?.close(1000, "bye");
    } catch {}
    this.ws = null;
  }
}

/**
 * Quick allows only ~2 concurrent turns per account; serialize turns per
 * socket. Returns a release function — acquire BEFORE building/sending the
 * turn, release in finally when the generator is fully consumed.
 */
export async function acquireTurn(socket) {
  const prev = socket._turnChain || Promise.resolve();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  socket._turnChain = prev.catch(() => {}).then(() => gate);
  await prev.catch(() => {});
  return release;
}

// Socket registry on globalThis so Next.js hot reload can't duplicate live
// sockets (module state is recreated, globalThis survives).
const socketRegistry = (globalThis.__awsQuickSockets ||= new Map());

/**
 * Shared, cached socket per key (connection id + ws host). A socket whose
 * session host changed or that was closed outright is replaced.
 */
export function getSharedSocket(key, factory) {
  const existing = socketRegistry.get(key);
  if (existing && !existing.closed) return existing;
  if (existing) {
    existing.close().catch(() => {});
  }
  const socket = factory();
  socketRegistry.set(key, socket);
  return socket;
}

/** Test/diagnostic hook: drop every cached socket. */
export function closeAllSharedSockets() {
  for (const s of socketRegistry.values()) s.close().catch(() => {});
  socketRegistry.clear();
}
