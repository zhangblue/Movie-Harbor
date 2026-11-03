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
// 保存登录限流状态，供认证路由共享使用。
pub struct RateLimiter {
    by_ip: Mutex<HashMap<IpAddr, Arc<LimitWindow>>>,
    by_account: Mutex<HashMap<String, Arc<LimitWindow>>>,
}

// 组合地址和账号的登录限制，供登录准入与结果记录使用。
pub struct LoginLimit {
    ip: Arc<LimitWindow>,
    account: Arc<LimitWindow>,
}

// 持有一次登录准入许可，供密码校验期间限制并发使用。
pub struct LoginAdmission {
    ip: Arc<LimitWindow>,
    account: Arc<LimitWindow>,
    finished: bool,
}

// 保存窗口与进行中请求数，供登录限流器内部管理。
struct LimitWindow {
    state: AsyncMutex<Window>,
    in_flight: AtomicU8,
}
impl Default for LimitWindow {
    // 创建空的限流窗口及并发计数，供首次为地址或账号分配窗口时调用。
    fn default() -> Self {
        Self {
            state: AsyncMutex::new(Window::default()),
            in_flight: AtomicU8::new(0),
        }
    }
}

impl RateLimiter {
    // 获取地址与账号对应的限制，供登录请求开始时调用。
    pub fn for_login(&self, address: IpAddr, name: &str) -> LoginLimit {
        // 将 IPv4 映射 IPv6 归一为 IPv4，防止同一客户端用两种文本地址拆分 IP 预算。
        let ip = match address {
            IpAddr::V6(ip) => ip.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(address),
            _ => address,
        };
        LoginLimit {
            ip: window(&self.by_ip, ip),
            // 账号键只保留摘要，限流表无需长期保存管理员输入的原始名称。
            account: window(&self.by_account, csrf::digest(name)),
        }
    }
}

// 获取或创建限制窗口，供登录限制按键分配状态时调用。
fn window<K: Eq + std::hash::Hash>(
    map: &Mutex<HashMap<K, Arc<LimitWindow>>>,
    key: K,
) -> Arc<LimitWindow> {
    // 短暂持有同步互斥锁仅用于取得窗口；具体失败计数在异步锁内更新，不能跨 await 持有此锁。
    let mut windows = map.lock().expect("rate limiter lock poisoned");
    let now = Instant::now();
    windows.retain(|_, window| {
        // 被登录请求引用或仍在 15 分钟窗口内的条目不能清理，以保持其预算和并发槽位有效。
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
    // 检查预算并取得登录许可，供密码校验前调用。
    pub async fn admit(&self, now: Instant) -> Option<LoginAdmission> {
        // 始终按 IP、账号的固定顺序获取两把锁，避免两个请求反向等待而死锁。
        let mut ip = self.ip.state.lock().await;
        let mut account = self.account.state.lock().await;
        if ip.blocked(now)
            || account.blocked(now)
            || self.ip.in_flight.load(Ordering::Acquire) >= 1
            || self.account.in_flight.load(Ordering::Acquire) >= 1
        {
            return None;
        }
        // 在任何数据库或 Argon2 await 前预扣一次尝试；即使请求被取消，也不能借此绕过 IP 预算。
        // 成功登录会清空两个窗口，而失败和取消均保留这次预扣，直到窗口自然过期。
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

    // 判断当前窗口是否阻止登录，供认证限流检查调用。
    pub async fn blocked(&self, now: Instant) -> bool {
        // 检查时会顺便让过期窗口复位，因此不需要后台定时任务维护限流状态。
        let mut ip = self.ip.state.lock().await;
        let mut account = self.account.state.lock().await;
        ip.blocked(now) || account.blocked(now)
    }

    // 记录失败并判断是否触发限制，供登录失败时调用。
    pub async fn failure(&self, now: Instant) -> bool {
        // 此入口用于没有登录入场凭据的失败；已入场请求必须改用 LoginAdmission::failure。
        let mut ip = self.ip.state.lock().await;
        let mut account = self.account.state.lock().await;
        let ip_blocked = ip.failure(now);
        let account_blocked = account.failure(now);
        ip_blocked || account_blocked
    }

    // 清除成功后的连续失败计数，供登录成功时调用。
    pub async fn success(&self) {
        // 成功验证后将 IP 与账号的连续失败计数一起归零。
        let mut ip = self.ip.state.lock().await;
        let mut account = self.account.state.lock().await;
        ip.success();
        account.success();
    }
}

impl LoginAdmission {
    // 检查预扣尝试后的封禁状态并释放许可，供登录失败时调用。
    pub async fn failure(mut self, now: Instant) -> bool {
        let mut ip = self.ip.state.lock().await;
        let mut account = self.account.state.lock().await;
        // 入场时已预扣本次尝试；完成时只能读取是否被封禁，不能再次累计失败次数。
        let ip_blocked = ip.blocked(now);
        let account_blocked = account.blocked(now);
        let blocked = ip_blocked || account_blocked;
        drop(account);
        drop(ip);
        self.release();
        blocked
    }
    // 清除成功后的连续失败计数，供登录成功时调用。
    pub async fn success(mut self) {
        let mut ip = self.ip.state.lock().await;
        let mut account = self.account.state.lock().await;
        ip.success();
        account.success();
        drop(account);
        drop(ip);
        self.release();
    }
    // 释放进行中的登录许可，供许可完成或销毁时调用。
    fn release(&mut self) {
        if !self.finished {
            // 无论成功、失败还是 future 被取消，都只释放一次两个维度的并发槽位。
            self.ip.in_flight.fetch_sub(1, Ordering::AcqRel);
            self.account.in_flight.fetch_sub(1, Ordering::AcqRel);
            self.finished = true;
        }
    }
}
impl Drop for LoginAdmission {
    // 在许可销毁时释放并发槽位，供取消或结束登录时自动调用。
    fn drop(&mut self) {
        // 提前返回或任务取消仍会执行 Drop，确保不会永久占满同 IP 或账号的请求槽位。
        self.release();
    }
}

#[derive(Default)]
// 保存时间窗口内的失败次数，供登录限制状态使用。
pub struct Window {
    failures: u8,
    started: Option<Instant>,
}

impl Window {
    // 判断当前窗口是否阻止登录，供认证限流检查调用。
    pub fn blocked(&mut self, now: Instant) -> bool {
        // 15 分钟窗口到期后先清除连续失败，下一次登录可从干净预算重新开始。
        if self
            .started
            .is_some_and(|start| now.duration_since(start) >= Duration::from_secs(900))
        {
            self.success();
        }
        self.failures >= 6
    }
    // 记录失败并判断是否触发限制，供登录失败时调用。
    pub fn failure(&mut self, now: Instant) -> bool {
        // 饱和加法避免异常重复调用造成 u8 回绕后意外解除封禁。
        self.blocked(now);
        self.started.get_or_insert(now);
        self.failures = self.failures.saturating_add(1);
        self.failures >= 6
    }
    // 清除成功后的连续失败计数，供登录成功时调用。
    pub fn success(&mut self) {
        self.failures = 0;
        self.started = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 防止随机账号名绕过 IP 预算，同时确保其他客户端不受牵连。
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

    // 防止分布式攻击通过轮换源 IP 绕过同一账号的失败预算。
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
    // 验证同一地址并发受限且取消释放许可，供限流测试运行。
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
    // 验证取消的登录仍消耗地址尝试预算，供限流测试运行。
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

    // 覆盖过早或过晚限流，以及被封禁窗口永不恢复的问题。
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

    // 覆盖成功登录后未清除既有连续失败计数的问题。
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
