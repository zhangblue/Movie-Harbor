use super::csrf;
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::atomic::{AtomicU8, Ordering},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::Instant;

#[derive(Default)]
pub struct RateLimiter {
    by_ip: Mutex<HashMap<IpAddr, Arc<LimitWindow>>>,
    by_account: Mutex<HashMap<String, Arc<LimitWindow>>>,
}

pub struct LoginLimit {
    ip: Arc<LimitWindow>,
    account: Arc<LimitWindow>,
}

pub struct LoginAdmission {
    ip: Arc<LimitWindow>,
    account: Arc<LimitWindow>,
    finished: bool,
}

struct LimitWindow {
    state: AsyncMutex<Window>,
    in_flight: AtomicU8,
}
impl Default for LimitWindow {
    fn default() -> Self {
        Self {
            state: AsyncMutex::new(Window::default()),
            in_flight: AtomicU8::new(0),
        }
    }
}

impl RateLimiter {
    pub fn for_login(&self, address: IpAddr, name: &str) -> LoginLimit {
        let ip = match address {
            IpAddr::V6(ip) => ip.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(address),
            _ => address,
        };
        LoginLimit {
            ip: window(&self.by_ip, ip),
            account: window(&self.by_account, csrf::digest(name)),
        }
    }
}

fn window<K: Eq + std::hash::Hash>(
    map: &Mutex<HashMap<K, Arc<LimitWindow>>>,
    key: K,
) -> Arc<LimitWindow> {
    let mut windows = map.lock().expect("rate limiter lock poisoned");
    let now = Instant::now();
    windows.retain(|_, window| {
        Arc::strong_count(window) > 1
            || window
                .state
                .try_lock()
                .map(|window| {
                    window
                        .started
                        .is_some_and(|start| now.duration_since(start) < Duration::from_secs(900))
                })
                .unwrap_or(true)
    });
    windows.entry(key).or_default().clone()
}

impl LoginLimit {
    pub async fn admit(&self, now: Instant) -> Option<LoginAdmission> {
        let mut ip = self.ip.state.lock().await;
        let mut account = self.account.state.lock().await;
        if ip.blocked(now)
            || account.blocked(now)
            || self.ip.in_flight.load(Ordering::Acquire) >= 1
            || self.account.in_flight.load(Ordering::Acquire) >= 1
        {
            return None;
        }
        // Reserve one attempt before any database/Argon2 await. Cancellation keeps this charge,
        // while a completed successful login clears both windows.
        ip.failure(now);
        account.failure(now);
        self.ip.in_flight.fetch_add(1, Ordering::AcqRel);
        self.account.in_flight.fetch_add(1, Ordering::AcqRel);
        Some(LoginAdmission {
            ip: self.ip.clone(),
            account: self.account.clone(),
            finished: false,
        })
    }

    pub async fn blocked(&self, now: Instant) -> bool {
        let mut ip = self.ip.state.lock().await;
        let mut account = self.account.state.lock().await;
        ip.blocked(now) || account.blocked(now)
    }

    pub async fn failure(&self, now: Instant) -> bool {
        let mut ip = self.ip.state.lock().await;
        let mut account = self.account.state.lock().await;
        let ip_blocked = ip.failure(now);
        let account_blocked = account.failure(now);
        ip_blocked || account_blocked
    }

    pub async fn success(&self) {
        let mut ip = self.ip.state.lock().await;
        let mut account = self.account.state.lock().await;
        ip.success();
        account.success();
    }
}

impl LoginAdmission {
    pub async fn failure(mut self, now: Instant) -> bool {
        let mut ip = self.ip.state.lock().await;
        let mut account = self.account.state.lock().await;
        // Admission already charged this attempt; completion must not count it twice.
        let ip_blocked = ip.blocked(now);
        let account_blocked = account.blocked(now);
        let blocked = ip_blocked || account_blocked;
        drop(account);
        drop(ip);
        self.release();
        blocked
    }
    pub async fn success(mut self) {
        let mut ip = self.ip.state.lock().await;
        let mut account = self.account.state.lock().await;
        ip.success();
        account.success();
        drop(account);
        drop(ip);
        self.release();
    }
    fn release(&mut self) {
        if !self.finished {
            self.ip.in_flight.fetch_sub(1, Ordering::AcqRel);
            self.account.in_flight.fetch_sub(1, Ordering::AcqRel);
            self.finished = true;
        }
    }
}
impl Drop for LoginAdmission {
    fn drop(&mut self) {
        self.release();
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

    // Catches bypassing the IP budget with random names while preserving client isolation.
    #[tokio::test]
    async fn mapped_ipv4_and_random_names_share_the_ip_limit_but_other_clients_do_not() {
        let limits = RateLimiter::default();
        let first = limits.for_login("127.0.0.1".parse().unwrap(), "Admin");
        for _ in 0..6 {
            first.failure(Instant::now()).await;
        }
        assert!(
            limits
                .for_login("::ffff:127.0.0.1".parse().unwrap(), "Admin")
                .blocked(Instant::now())
                .await
        );
        assert!(
            !limits
                .for_login("127.0.0.2".parse().unwrap(), "Other")
                .blocked(Instant::now())
                .await
        );
        assert!(
            limits
                .for_login("127.0.0.1".parse().unwrap(), "Other")
                .blocked(Instant::now())
                .await
        );
    }

    // Catches a distributed attack bypassing the account budget by rotating source IPs.
    #[tokio::test]
    async fn one_account_shares_a_failure_budget_across_ips() {
        let limits = RateLimiter::default();
        for suffix in 1..=6 {
            limits
                .for_login(format!("127.0.0.{suffix}").parse().unwrap(), "Admin")
                .failure(Instant::now())
                .await;
        }
        assert!(
            limits
                .for_login("127.0.1.1".parse().unwrap(), "Admin")
                .blocked(Instant::now())
                .await
        );
        assert!(
            !limits
                .for_login("127.0.1.1".parse().unwrap(), "Other")
                .blocked(Instant::now())
                .await
        );
    }

    #[tokio::test]
    async fn admission_bounds_a_same_ip_burst_and_cancellation_releases_it() {
        let limits = RateLimiter::default();
        let first = limits.for_login("127.0.0.1".parse().unwrap(), "random-1");
        let held = first.admit(Instant::now()).await.expect("first admitted");
        for suffix in 2..=20 {
            assert!(
                limits
                    .for_login("127.0.0.1".parse().unwrap(), &format!("random-{suffix}"))
                    .admit(Instant::now())
                    .await
                    .is_none()
            );
        }
        assert!(
            limits
                .for_login("127.0.0.2".parse().unwrap(), "Admin")
                .admit(Instant::now())
                .await
                .is_some()
        );
        drop(held);
        assert!(first.admit(Instant::now()).await.is_some());
    }

    #[tokio::test]
    async fn cancelled_admissions_still_consume_the_ip_attempt_budget() {
        let limits = RateLimiter::default();
        for suffix in 1..=6 {
            let admission = limits
                .for_login("127.0.0.9".parse().unwrap(), &format!("random-{suffix}"))
                .admit(Instant::now())
                .await
                .expect("first six attempts are admitted");
            drop(admission);
        }
        assert!(
            limits
                .for_login("127.0.0.9".parse().unwrap(), "another-random-name")
                .admit(Instant::now())
                .await
                .is_none()
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
