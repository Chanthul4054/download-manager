//! Token-bucket rate limiter and moving-average speed meter (port of engine/limiter.js).

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::LazyLock;
use std::time::Instant;

use crate::js::now_ms;

/// Token bucket. rate is bytes/sec; 0 = unlimited.
pub struct RateLimiter {
    rate: f64,
    tokens: f64,
    last: f64,
}

pub type LimiterRef = Rc<RefCell<RateLimiter>>;

impl RateLimiter {
    pub fn new(rate: f64) -> Self {
        let mut l = RateLimiter { rate: 0.0, tokens: 0.0, last: 0.0 };
        l.set_rate(rate);
        l
    }

    pub fn shared(rate: f64) -> LimiterRef {
        Rc::new(RefCell::new(RateLimiter::new(rate)))
    }

    pub fn set_rate(&mut self, rate: f64) {
        self.rate = if rate > 0.0 { rate } else { 0.0 };
        self.tokens = self.rate;
        self.last = now_ms();
    }

    fn refill(&mut self) {
        let now = now_ms();
        if self.rate > 0.0 {
            self.tokens = self.rate.min(self.tokens + ((now - self.last) / 1000.0) * self.rate);
        }
        self.last = now;
    }

    /// Returns ms to wait before `bytes` may be consumed (and consumes them).
    pub fn take(&mut self, bytes: usize) -> u64 {
        if self.rate == 0.0 {
            return 0;
        }
        self.refill();
        self.tokens -= bytes as f64;
        if self.tokens >= 0.0 {
            0
        } else {
            ((-self.tokens / self.rate) * 1000.0).ceil() as u64
        }
    }
}

/// The longest wait any of the limiters asks for.
pub fn take_all(limiters: &[LimiterRef], bytes: usize) -> u64 {
    limiters.iter().map(|l| l.borrow_mut().take(bytes)).max().unwrap_or(0)
}

static EPOCH: LazyLock<Instant> = LazyLock::new(Instant::now);

/// Milliseconds on a monotonic clock (JS `performance.now()`).
pub fn perf_now() -> f64 {
    EPOCH.elapsed().as_secs_f64() * 1000.0
}

const BUCKET_MS: f64 = 100.0;

/// Moving-average speed meter over a sliding window. Bytes are summed into 100 ms buckets on a
/// monotonic clock, so the cost does not grow with the number of network chunks.
pub struct SpeedMeter {
    window_ms: f64,
    samples: VecDeque<(f64, u64)>,
    pub total: u64,
}

impl Default for SpeedMeter {
    fn default() -> Self {
        SpeedMeter { window_ms: 3000.0, samples: VecDeque::new(), total: 0 }
    }
}

impl SpeedMeter {
    pub fn add(&mut self, bytes: u64) {
        let t = (perf_now() / BUCKET_MS).floor() * BUCKET_MS;
        match self.samples.back_mut() {
            Some(last) if last.0 == t => last.1 += bytes,
            _ => self.samples.push_back((t, bytes)),
        }
        self.total += bytes;
    }

    pub fn rate(&mut self) -> f64 {
        let now = perf_now();
        while self.samples.front().is_some_and(|s| now - s.0 > self.window_ms) {
            self.samples.pop_front();
        }
        let Some(first) = self.samples.front() else { return 0.0 };
        let sum: u64 = self.samples.iter().map(|s| s.1).sum();
        let span = (now - first.0).max(1000.0);
        (sum as f64 / span) * 1000.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_waits_when_over_rate() {
        let mut l = RateLimiter::new(1000.0);
        assert_eq!(l.take(500), 0);
        assert_eq!(l.take(500), 0);
        let w = l.take(500);
        assert!(w >= 400 && w <= 500, "{w}");
        let mut free = RateLimiter::new(0.0);
        assert_eq!(free.take(1 << 30), 0);
    }

    #[test]
    fn meter_reports_rate() {
        let mut m = SpeedMeter::default();
        m.add(3000);
        let r = m.rate();
        assert!(r > 2000.0 && r <= 3000.0, "{r}");
    }
}
