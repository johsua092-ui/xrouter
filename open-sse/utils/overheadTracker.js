/**
 * Microsecond Latency Profiler for XRouter Gateway
 * Inspired by OhMyRouter OmopV2 (src/runtime/overhead.ts)
 * 
 * Tracks latency overhead across request phases (ingress, auth, bypass, plan, upstream, stream)
 * and calculates P50, P90, P99, and P99.9 quantiles using in-memory ring buffers.
 */

const MAX_SAMPLES_PER_PHASE = 4096;

class QuantileBuffer {
  constructor(capacity = MAX_SAMPLES_PER_PHASE) {
    this.capacity = capacity;
    this.samples = new Float32Array(capacity);
    this.size = 0;
    this.index = 0;
  }

  push(valueMs) {
    this.samples[this.index] = valueMs;
    this.index = (this.index + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size++;
    }
  }

  getQuantiles() {
    if (this.size === 0) {
      return { p50: 0, p90: 0, p99: 0, p999: 0, count: 0, avg: 0 };
    }

    const current = new Float32Array(this.size);
    for (let i = 0; i < this.size; i++) {
      current[i] = this.samples[i];
    }
    current.sort();

    const getP = (p) => {
      const idx = Math.min(Math.floor(p * this.size), this.size - 1);
      return Number(current[idx].toFixed(2));
    };

    let sum = 0;
    for (let i = 0; i < this.size; i++) sum += current[i];

    return {
      p50: getP(0.50),
      p90: getP(0.90),
      p99: getP(0.99),
      p999: getP(0.999),
      avg: Number((sum / this.size).toFixed(2)),
      count: this.size,
    };
  }
}

const phaseBuffers = new Map();

export class OverheadTracker {
  constructor(requestId = "") {
    this.requestId = requestId;
    this.marks = new Map();
    this.durations = {};
  }

  start(phase) {
    this.marks.set(phase, performance.now());
  }

  end(phase) {
    const startTime = this.marks.get(phase);
    if (startTime === undefined) return;
    const duration = Number((performance.now() - startTime).toFixed(3));
    this.durations[phase] = duration;

    let buf = phaseBuffers.get(phase);
    if (!buf) {
      buf = new QuantileBuffer();
      phaseBuffers.set(phase, buf);
    }
    buf.push(duration);
  }

  getMetrics() {
    return { ...this.durations };
  }
}

export function getOverheadReport() {
  const report = {};
  for (const [phase, buf] of phaseBuffers.entries()) {
    report[phase] = buf.getQuantiles();
  }
  return report;
}

export function resetOverheadMetrics() {
  phaseBuffers.clear();
}
