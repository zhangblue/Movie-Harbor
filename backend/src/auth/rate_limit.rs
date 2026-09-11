use super::csrf;
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::Instant;

type Key = (IpAddr, String);

#[derive(Default)]
pub struct RateLimiter(Mutex<HashMap<Key, Arc<AsyncMutex<Window>>>>);

impl RateLimiter {
    pub fn for_login(&self, address: IpAddr, name: &str) -> Arc<AsyncMutex<Window>> {
        let ip = match address {
            IpAddr::V6(ip) => ip.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(address),
            _ => address,
        };
        let mut windows = self.0.lock().expect("rate limiter lock poisoned");
        let now = Instant::now();
        windows.retain(|_, window| {
            Arc::strong_count(window) > 1
                || window
                    .try_lock()
                    .map(|window| {
                        window.started.is_some_and(|start| {
                            now.duration_since(start) < Duration::from_secs(900)
                        })
                    })
                    .unwrap_or(true)
        });
        windows.entry((ip, csrf::digest(name))).or_default().clone()
    }
}

#[derive(Default)]
pub struct Window {
    failures: u8,
    started: Option<Instant>,
}

impl Window {
    pub fn blocked(&mut self, now: Instant) -> bool {
        if self
            .started
            .is_some_and(|start| now.duration_since(start) >= Duration::from_secs(900))
        {
            self.success();
        }
        self.failures >= 6
    }
    pub fn failure(&mut self, now: Instant) -> bool {
        self.blocked(now);
        self.started.get_or_insert(now);
        self.failures = self.failures.saturating_add(1);
        self.failures >= 6
    }
    pub fn success(&mut self) {
        self.failures = 0;
        self.started = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Catches bypassing a limit by changing port/address notation or bleeding across accounts and clients.
    #[tokio::test]
    async fn mapped_ipv4_shares_the_same_limit_but_other_clients_and_names_do_not() {
        let limits = RateLimiter::default();
        let first = limits.for_login("127.0.0.1".parse().unwrap(), "Admin");
        for _ in 0..6 {
            first.lock().await.failure(Instant::now());
        }
        assert!(
            limits
                .for_login("::ffff:127.0.0.1".parse().unwrap(), "Admin")
                .lock()
                .await
                .blocked(Instant::now())
        );
        assert!(
            !limits
                .for_login("127.0.0.2".parse().unwrap(), "Admin")
                .lock()
                .await
                .blocked(Instant::now())
        );
        assert!(
            !limits
                .for_login("127.0.0.1".parse().unwrap(), "Other")
                .lock()
                .await
                .blocked(Instant::now())
        );
    }

    // Catches early/late throttling and a blocked window never recovering.
    #[test]
    fn sixth_failure_blocks_until_exactly_fifteen_minutes() {
        let start = Instant::now();
        let mut window = Window::default();
        for _ in 0..5 {
            assert!(!window.failure(start));
        }
        assert!(window.failure(start));
        assert!(window.blocked(start + Duration::from_secs(899)));
        assert!(!window.blocked(start + Duration::from_secs(900)));
        assert!(!window.failure(start + Duration::from_secs(900)));
    }

    // Catches successful login leaving earlier failures in the consecutive-failure counter.
    #[test]
    fn success_clears_consecutive_failures() {
        let now = Instant::now();
        let mut window = Window::default();
        for _ in 0..5 {
            window.failure(now);
        }
        window.success();
        for _ in 0..5 {
            assert!(!window.failure(now));
        }
        assert!(window.failure(now));
    }
}
