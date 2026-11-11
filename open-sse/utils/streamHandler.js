// Stream handler with disconnect detection - shared for all providers
import { STREAM_STALL_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { EMPTY_STREAM_ERROR } from "../config/errorConfig.js";
import { SSE_DONE } from "./sseConstants.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

// Get HH:MM:SS timestamp
function getTimeString() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Create stream controller with abort and disconnect detection
 * @param {object} options
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {object} options.log - Logger instance
 * @param {string} options.provider - Provider name
 * @param {string} options.model - Model name
 */
export function createStreamController({ onDisconnect, onError, log, provider, model, reqTag = "" } = {}) {
  const abortController = new AbortController();
  const startTime = Date.now();
  let disconnected = false;

  // Only abnormal terminations are logged; normal completion is covered by "[done]".
  // isError uses errorLine (always shown, ignores LOG_LEVEL) so failures survive quiet levels.
  const logStream = (symbol, status, isError = false) => {
    const duration = Date.now() - startTime;
    const emit = isError ? log?.errorLine : log?.line;
    if (emit) emit(reqTag, symbol, `${status} · ${provider}/${model} · ${duration}ms`);
    else console.log(`[${getTimeString()}] ${symbol} ${provider}/${model} · ${status} · ${duration}ms`);
  };

  return {
    signal: abortController.signal,
    startTime,

    isConnected: () => !disconnected,

    // Call when client disconnects
    handleDisconnect: (reason = "client_closed") => {
      if (disconnected) return;
      disconnected = true;

      // Debug-only: Responses API has no [DONE] sentinel, so codex/droid close the
      // socket on every completed request. "[done]" is the authoritative outcome line.
      dbg("CTRL", `${provider}/${model} | disconnect=${reason} | dur=${Date.now() - startTime}ms`);

      // Stop upstream work before running disconnect observers (#4914).
      abortController.abort();

      onDisconnect?.({ reason, duration: Date.now() - startTime });
    },

    // Call on stream complete
    handleComplete: () => {
      if (disconnected) return;
      disconnected = true;
    },

    // Call on error
    handleError: (error) => {
      if (disconnected) return;
      disconnected = true;

      if (error.name === "AbortError") {
        logStream("⚡", "ABORTED");
        return;
      }

      logStream("✗", `ERROR: ${error.message}${error.stack ? `\n    ${error.stack}` : ""}`, true);
      onError?.(error);
    },

    abort: () => abortController.abort()
  };
}

/**
 * Create transform stream with disconnect detection
 * Wraps existing transform stream and adds abort capability.
 *
 * Stall detection lives in pipeWithDisconnect (tied to upstream byte
 * activity), not here — output of the transform stream may be silent
 * for long periods while raw bytes still flow (e.g. Kiro EventStream
 * binary frames buffering, Claude reasoning streams).
 *
 * @param {function} [onAbortTerminal] - Receives a human-readable abort
 * message and returns terminal SSE bytes to emit downstream.
 */
export function createDisconnectAwareStream(transformStream, streamController, onAbortTerminal = null) {
  const reader = transformStream.readable.getReader();
  const writer = transformStream.writable.getWriter();
  let terminalEmitted = false;

  // Emit a synthesized terminal payload (e.g. Responses response.failed + [DONE]) once
  const emitTerminal = (controller) => {
    if (terminalEmitted || !onAbortTerminal) return;
    terminalEmitted = true;
    try {
      const bytes = onAbortTerminal();
      if (bytes) controller.enqueue(bytes);
    } catch { /* best-effort terminal */ }
  };

  return new ReadableStream({
    async pull(controller) {
      if (!streamController.isConnected()) {
        emitTerminal(controller);
        controller.close();
        return;
      }

      try {
        const { done, value } = await reader.read();

        if (done) {
          streamController.handleComplete();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        const wasConnected = streamController.isConnected();
        // Controller already closed = downstream ended; not an upstream error, skip noisy log.
        const msg0 = error?.message || "";
        const isControllerClosed = msg0.includes("already closed") || msg0.includes("Invalid state");
        if (!isControllerClosed) streamController.handleError(error);
        reader.cancel().catch(() => {});
        writer.abort().catch(() => {});

        // Treat network resets / socket hang up / abort as graceful close only if client
        // itself disconnected (!wasConnected) or an in-band terminal frame is handled.
        // If client is still connected, mid-stream upstream failure must error the controller
        // so client sees the failure and triggers auto-retry (OmniRoute #17292).
        try {
          if (!wasConnected) {
            controller.close();
          } else if (onAbortTerminal) {
            emitTerminal(controller);
            controller.close();
          } else {
            controller.error(error);
          }
        } catch (e) { /* already closed or cancelled */ }
      }
    },

    cancel(reason) {
      streamController.handleDisconnect(reason || "cancelled");
      reader.cancel();
      writer.abort();
    }
  });
}

/**
 * Pipe provider response through transform with disconnect detection.
 *
 * Stall watchdog tracks raw upstream byte activity, not transform output.
 * Reasoning models (Claude thinking via Kiro, etc.) can produce zero SSE
 * output for long stretches while partial EventStream frames keep arriving.
 * Measuring stall on the transform output caused false stalls and the
 * "failed to pipe response" error in Next.
 *
 * Any upstream chunk resets the timer. If no bytes arrive for
 * STREAM_STALL_TIMEOUT_MS, abort the underlying fetch via the controller.
 *
 * @param {Response} providerResponse - Response from provider
 * @param {TransformStream} transformStream - Transform stream for SSE
 * @param {object} streamController - Stream controller from createStreamController
 */
export function pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal = null, stallTimeoutMs = STREAM_STALL_TIMEOUT_MS, emptyStreamTerminal = null) {
  let stallTimer = null;
  let chunkCount = 0;
  let totalBytes = 0;
  let lastChunkAt = Date.now();
  let abortMessage = "upstream connection lost";
  const t0 = Date.now();
  const tag = "STREAM";
  const clearStall = () => {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
  };
  const armStall = () => {
    clearStall();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      // One budget, two phases: no upstream byte yet = prefill (first-chunk), else mid-stream stall.
      abortMessage = totalBytes === 0 ? "stream first-chunk timeout" : "stream stall timeout";
      dbg(tag, `${abortMessage.toUpperCase()} ${stallTimeoutMs}ms | chunks=${chunkCount} | bytes=${totalBytes} | sinceLast=${Date.now() - lastChunkAt}ms`);
      streamController.handleError?.(new Error(abortMessage));
      streamController.abort?.();
    }, stallTimeoutMs);
  };

  // Wrap controller so every termination path clears the stall timer.
  // Without this, abort/cancel/downstream-error paths leave the timer armed
  // and a stale abort could fire after the request has already ended.
  const wrappedController = {
    signal: streamController.signal,
    startTime: streamController.startTime,
    isConnected: () => streamController.isConnected(),
    handleComplete: () => { dbg(tag, `complete | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleComplete(); },
    handleError: (e) => { dbg(tag, `error: ${e?.message} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleError(e); },
    handleDisconnect: (r) => { dbg(tag, `disconnect: ${r} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleDisconnect(r); },
    abort: (r) => { dbg(tag, `abort: ${r} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.abort(r); },
    isAborted: () => streamController.isAborted(),
  };

  armStall();

  const upstreamTap = new TransformStream({
    transform(chunk, controller) {
      chunkCount++;
      const sz = chunk?.byteLength || chunk?.length || 0;
      totalBytes += sz;
      const now = Date.now();
      const gap = now - lastChunkAt;
      lastChunkAt = now;
      if (isDebugEnabled && (chunkCount <= 5 || chunkCount % 20 === 0 || gap > 5000)) {
        dbg(tag, `chunk #${chunkCount} | size=${sz}B | gap=${gap}ms | total=${totalBytes}B`);
      }
      armStall();
      controller.enqueue(chunk);
    },
    flush() {
      dbg(tag, `upstream EOF | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`);
      clearStall();
    }
  });

  // Tap transform output as well so downstream backpressure doesn't trigger false stalls
  const downstreamTap = new TransformStream({
    transform(chunk, controller) {
      armStall();
      controller.enqueue(chunk);
    },
    flush() {
      clearStall();
    }
  });

  const transformedBody = providerResponse.body
    .pipeThrough(upstreamTap)
    .pipeThrough(transformStream)
    .pipeThrough(downstreamTap)
    .pipeThrough(createEmptyStreamGuard({ tag, emptyStreamTerminal, stats: () => `upstream chunks=${chunkCount} bytes=${totalBytes}` }));

  return createDisconnectAwareStream(
    { readable: transformedBody, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
    wrappedController,
    onAbortTerminal ? () => onAbortTerminal(abortMessage) : null
  );
}

export function buildDefaultEmptyStreamTerminal(message = EMPTY_STREAM_ERROR.message) {
  const payload = JSON.stringify({
    error: { message, type: EMPTY_STREAM_ERROR.type, code: EMPTY_STREAM_ERROR.code },
  });
  return new TextEncoder().encode(`data: ${payload}\n\n${SSE_DONE}`);
}

function isPayloadLine(line) {
  const s = line.trim();
  if (s.startsWith("data:")) {
    const payload = s.slice(5).trim();
    return payload !== "" && payload !== "[DONE]";
  }
  return s.startsWith("{");
}

export function createEmptyStreamGuard({ tag = "STREAM", emptyStreamTerminal = null, stats = () => "" } = {}) {
  const decoder = new TextDecoder();
  let sawPayload = false;
  let partial = "";
  let held = [];
  return new TransformStream({
    transform(chunk, controller) {
      if (sawPayload) { controller.enqueue(chunk); return; }
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const lines = (partial + text).split("\n");
      partial = lines.pop() ?? "";
      if (lines.some(isPayloadLine)) {
        sawPayload = true;
        for (const h of held) controller.enqueue(h);
        held = [];
        controller.enqueue(chunk);
        return;
      }
      if (text.includes("[DONE]")) held.push(chunk);
      else controller.enqueue(chunk);
    },
    flush(controller) {
      if (!sawPayload && isPayloadLine(partial)) sawPayload = true;
      if (sawPayload) {
        for (const h of held) controller.enqueue(h);
        return;
      }
      dbg(tag, `EMPTY STREAM — ${stats()}; emitting error frame`);
      const terminal = emptyStreamTerminal ? emptyStreamTerminal(EMPTY_STREAM_ERROR.message) : buildDefaultEmptyStreamTerminal();
      if (terminal) controller.enqueue(terminal);
    },
  });
}

