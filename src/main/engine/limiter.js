'use strict';

// Token bucket. rate is bytes/sec; 0 or null = unlimited.
class RateLimiter {
  constructor(rate = 0) {
    this.setRate(rate);
  }

  setRate(rate) {
    this.rate = rate > 0 ? rate : 0;
    this.tokens = this.rate;
    this.last = Date.now();
  }

  refill() {
    const now = Date.now();
    if (this.rate) this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }

  // Returns ms to wait before `bytes` may be consumed (and consumes them).
  take(bytes) {
    if (!this.rate) return 0;
    this.refill();
    this.tokens -= bytes;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.rate) * 1000);
  }
}

// Applies several limiters (global + per-download) to a readable stream by pausing it.
function throttle(stream, limiters) {
  stream.on('data', (chunk) => {
    let wait = 0;
    for (const l of limiters()) wait = Math.max(wait, l.take(chunk.length));
    if (wait > 0 && !stream.destroyed) {
      stream.pause();
      setTimeout(() => !stream.destroyed && stream.resume(), Math.min(wait, 2000));
    }
  });
}

// Moving-average speed meter over a sliding window.
class SpeedMeter {
  constructor(windowMs = 3000) {
    this.windowMs = windowMs;
    this.samples = [];
  }

  add(bytes) {
    this.samples.push([Date.now(), bytes]);
  }

  rate() {
    const now = Date.now();
    while (this.samples.length && now - this.samples[0][0] > this.windowMs) this.samples.shift();
    if (!this.samples.length) return 0;
    const sum = this.samples.reduce((a, s) => a + s[1], 0);
    const span = Math.max(1000, now - this.samples[0][0]);
    return (sum / span) * 1000;
  }
}

module.exports = { RateLimiter, throttle, SpeedMeter };
