use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use movie_harbor_api::{app, auth::password, config::Config, entities::viewer_user};
use sea_orm::{ActiveModelTrait, ConnectionTrait, Set};
use serde_json::{Value, json};
use tower::ServiceExt;

mod support;

/// 创建带两个普通用户和已发布电影、剧集、单集的隔离应用，供进度路由测试复用。
async fn setup() -> (support::TestDatabase, Router) {
    let db = support::TestDatabase::migrated("viewer_progress").await;
    for (id, username) in [
        ("30000000-0000-0000-0000-000000000001", "Summer"),
        ("30000000-0000-0000-0000-000000000002", "Winter"),
    ] {
        viewer_user::ActiveModel {
            id: Set(id.parse().unwrap()),
            username: Set(username.into()),
            normalized_username: Set(username.to_lowercase()),
            password_hash: Set(password::hash("viewer-password".into()).await.ok().unwrap()),
            ..Default::default()
        }
        .insert(&*db)
        .await
        .unwrap();
    }
    db.execute_unprepared(
        r#"
INSERT INTO media_asset (id, storage_key, original_name, mime_type, byte_size, purpose) VALUES
 ('90000000-0000-0000-0000-000000000001', 'video/90/movie.mp4', 'movie.mp4', 'video/mp4', 10, 'video'),
 ('90000000-0000-0000-0000-000000000002', 'video/90/episode.mp4', 'episode.mp4', 'video/mp4', 10, 'video'),
 ('90000000-0000-0000-0000-000000000003', 'video/90/episode-2.mp4', 'episode-2.mp4', 'video/mp4', 10, 'video');
INSERT INTO movie (id, name, status, video_asset_id, published_at) VALUES
 ('10000000-0000-0000-0000-000000000001', 'Movie', 'published', '90000000-0000-0000-0000-000000000001', CURRENT_TIMESTAMP);
INSERT INTO series (id, name, status, published_at) VALUES
 ('20000000-0000-0000-0000-000000000001', 'Series', 'published', CURRENT_TIMESTAMP);
INSERT INTO season (id, series_id, number) VALUES
 ('21000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 1);
INSERT INTO episode (id, season_id, number, name, status, video_asset_id, published_at) VALUES
 ('22000000-0000-0000-0000-000000000001', '21000000-0000-0000-0000-000000000001', 1, 'Episode', 'published', '90000000-0000-0000-0000-000000000002', CURRENT_TIMESTAMP),
 ('22000000-0000-0000-0000-000000000002', '21000000-0000-0000-0000-000000000001', 2, 'Episode 2', 'published', '90000000-0000-0000-0000-000000000003', CURRENT_TIMESTAMP);
"#,
    )
    .await
    .unwrap();
    let cfg = Config {
        listen_addr: "127.0.0.1:3000".parse().unwrap(),
        database_url: String::new(),
        media_dir: std::env::temp_dir().join(format!(
            "movie-harbor-viewer-progress-{}",
            uuid::Uuid::new_v4().simple()
        )),
        cookie_secure: true,
        public_origin: "https://harbor.test".into(),
        allow_insecure_lan_http: false,
        trust_proxy_headers: false,
        trusted_proxy_secret: None,
        mcp_api_key_digest: None,
        max_upload_bytes: 1024,
        allowed_video_mime_types: vec!["video/mp4".into()],
        admin_name: Some("Admin".into()),
        admin_initial_password: Some("admin-password".into()),
    };
    let app = app::build(db.connection(), &cfg).await.unwrap();
    (db, app)
}

/// 向测试应用发送带可选普通用户认证信息的 JSON 请求。
async fn request(
    app: &Router,
    method: &str,
    path: &str,
    payload: Value,
    cookie: Option<&str>,
    csrf: Option<&str>,
) -> Response {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "harbor.test")
        .header("origin", "https://harbor.test")
        .header("content-type", "application/json");
    if let Some(cookie) = cookie {
        builder = builder.header("cookie", cookie);
    }
    if let Some(csrf) = csrf {
        builder = builder.header("x-csrf-token", csrf);
    }
    let mut request = builder.body(Body::from(payload.to_string())).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    app.clone().oneshot(request).await.unwrap()
}

/// 读取测试响应 JSON，供进度快照和错误断言使用。
async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

/// 登录指定普通用户并读取 Cookie 与 CSRF，供受保护写请求使用。
async fn credentials(app: &Router, username: &str) -> (String, String) {
    let response = request(
        app,
        "POST",
        "/api/viewer/login",
        json!({"username":username,"password":"viewer-password"}),
        None,
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let session = request(
        app,
        "GET",
        "/api/viewer/session",
        json!(null),
        Some(&cookie),
        None,
    )
    .await;
    let session = body(session).await;
    (cookie, session["csrf_token"].as_str().unwrap().to_owned())
}

/// 验证进度读取需要普通用户会话，写入还必须通过现有同源 CSRF 边界。
#[tokio::test]
async fn viewer_progress_requires_viewer_session_and_csrf() {
    let (_db, app) = setup().await;
    let anonymous = request(&app, "GET", "/api/viewer/progress", json!(null), None, None).await;
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(anonymous.headers()["cache-control"], "no-store");
    let admin_cookie =
        "mh_session=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    let admin = request(
        &app,
        "GET",
        "/api/viewer/progress",
        json!(null),
        Some(admin_cookie),
        None,
    )
    .await;
    assert_eq!(admin.status(), StatusCode::UNAUTHORIZED);

    let (cookie, csrf) = credentials(&app, "Summer").await;
    let input = json!({"position_seconds":15.0,"duration_seconds":120.0,"completed":false,"updated_at":"2026-11-23T01:00:00Z"});
    let missing = request(
        &app,
        "PUT",
        "/api/viewer/progress/movie/10000000-0000-0000-0000-000000000001",
        input.clone(),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(missing.status(), StatusCode::FORBIDDEN);
    let valid = request(
        &app,
        "PUT",
        "/api/viewer/progress/movie/10000000-0000-0000-0000-000000000001",
        input,
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(valid.status(), StatusCode::OK);
    assert_eq!(valid.headers()["cache-control"], "no-store");
}

/// 验证电影、单集和剧集游标可往返，并按当前普通用户严格隔离。
#[tokio::test]
async fn viewer_progress_round_trips_movies_episodes_and_cursors() {
    let (_db, app) = setup().await;
    let (summer_cookie, summer_csrf) = credentials(&app, "Summer").await;
    let movie = json!({"position_seconds":15.0,"duration_seconds":120.0,"completed":false,"updated_at":"2026-11-23T01:00:00Z"});
    let response = request(
        &app,
        "PUT",
        "/api/viewer/progress/movie/10000000-0000-0000-0000-000000000001",
        movie,
        Some(&summer_cookie),
        Some(&summer_csrf),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let merge = json!({
        "progress":[{"kind":"episode","id":"22000000-0000-0000-0000-000000000001","position_seconds":30.0,"duration_seconds":300.0,"completed":false,"updated_at":"2026-11-23T02:00:00Z"}],
        "cursors":[{"series_id":"20000000-0000-0000-0000-000000000001","episode_id":"22000000-0000-0000-0000-000000000001","updated_at":"2026-11-23T02:00:00Z"}],
        "removals":[]
    });
    let response = request(
        &app,
        "POST",
        "/api/viewer/progress/merge",
        merge,
        Some(&summer_cookie),
        Some(&summer_csrf),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let snapshot = body(response).await;
    assert_eq!(snapshot["progress"].as_array().unwrap().len(), 2);
    assert_eq!(snapshot["progress"][0]["kind"], "episode");
    assert_eq!(
        snapshot["progress"][0]["series_id"],
        "20000000-0000-0000-0000-000000000001"
    );
    assert_eq!(
        snapshot["cursors"][0]["episode_id"],
        "22000000-0000-0000-0000-000000000001"
    );
    assert!(
        snapshot["results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["status"] == "accepted")
    );

    let (winter_cookie, _) = credentials(&app, "Winter").await;
    let other = request(
        &app,
        "GET",
        "/api/viewer/progress",
        json!(null),
        Some(&winter_cookie),
        None,
    )
    .await;
    assert_eq!(body(other).await["progress"].as_array().unwrap().len(), 0);
}

/// 验证原始客户端时间决定进度与删除冲突，且三种删除范围互不混淆。
#[tokio::test]
async fn viewer_progress_merges_by_original_time_and_tombstones() {
    let (_db, app) = setup().await;
    let (cookie, csrf) = credentials(&app, "Summer").await;
    let movie_path = "/api/viewer/progress/movie/10000000-0000-0000-0000-000000000001";
    for (position, updated_at) in [
        (30.0, "2026-11-23T03:00:00Z"),
        (10.0, "2026-11-23T02:00:00Z"),
    ] {
        let response = request(&app, "PUT", movie_path, json!({"position_seconds":position,"duration_seconds":120.0,"completed":false,"updated_at":updated_at}), Some(&cookie), Some(&csrf)).await;
        assert_eq!(response.status(), StatusCode::OK);
    }
    let snapshot = body(
        request(
            &app,
            "GET",
            "/api/viewer/progress",
            json!(null),
            Some(&cookie),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(snapshot["progress"][0]["position_seconds"], 30.0);

    let removed = request(
        &app,
        "DELETE",
        movie_path,
        json!({"removed_at":"2026-11-23T04:00:00Z"}),
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(removed.status(), StatusCode::OK);
    let stale = request(&app, "PUT", movie_path, json!({"position_seconds":40.0,"duration_seconds":120.0,"completed":false,"updated_at":"2026-11-23T03:30:00Z"}), Some(&cookie), Some(&csrf)).await;
    assert_eq!(body(stale).await["progress"].as_array().unwrap().len(), 0);
    let fresh = request(&app, "PUT", movie_path, json!({"position_seconds":50.0,"duration_seconds":120.0,"completed":false,"updated_at":"2026-11-23T05:00:00Z"}), Some(&cookie), Some(&csrf)).await;
    assert_eq!(body(fresh).await["progress"][0]["position_seconds"], 50.0);

    let merge = json!({
        "progress":[
          {"kind":"episode","id":"22000000-0000-0000-0000-000000000001","position_seconds":20.0,"duration_seconds":100.0,"completed":false,"updated_at":"2026-11-23T03:00:00Z"},
          {"kind":"episode","id":"22000000-0000-0000-0000-000000000002","position_seconds":30.0,"duration_seconds":100.0,"completed":false,"updated_at":"2026-11-23T03:00:00Z"}
        ],
        "cursors":[{"series_id":"20000000-0000-0000-0000-000000000001","episode_id":"22000000-0000-0000-0000-000000000002","updated_at":"2026-11-23T03:00:00Z"}],
        "removals":[]
    });
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/viewer/progress/merge",
            merge,
            Some(&cookie),
            Some(&csrf)
        )
        .await
        .status(),
        StatusCode::OK
    );
    let one_removed = request(
        &app,
        "DELETE",
        "/api/viewer/progress/episode/22000000-0000-0000-0000-000000000001",
        json!({"removed_at":"2026-11-23T04:00:00Z"}),
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    let one_removed = body(one_removed).await;
    assert!(
        one_removed["progress"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == "22000000-0000-0000-0000-000000000002")
    );
    assert!(
        !one_removed["progress"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == "22000000-0000-0000-0000-000000000001")
    );

    let series_removed = request(
        &app,
        "DELETE",
        "/api/viewer/progress/series/20000000-0000-0000-0000-000000000001",
        json!({"removed_at":"2026-11-23T06:00:00Z"}),
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    let series_removed = body(series_removed).await;
    assert!(
        !series_removed["progress"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "episode")
    );
    assert_eq!(series_removed["cursors"].as_array().unwrap().len(), 0);
}

/// 验证批量旧缓存逐项拒绝，并限制重复目标、数值、未来时间和总操作数。
#[tokio::test]
async fn viewer_progress_partially_rejects_stale_targets_and_validates_bounds() {
    let (db, app) = setup().await;
    let (cookie, csrf) = credentials(&app, "Summer").await;
    db.execute_unprepared(
        "UPDATE movie SET status='archived' WHERE id='10000000-0000-0000-0000-000000000001'",
    )
    .await
    .unwrap();
    let merge = json!({
      "progress":[
        {"kind":"movie","id":"10000000-0000-0000-0000-000000000001","position_seconds":10.0,"duration_seconds":100.0,"completed":false,"updated_at":"2026-11-23T01:00:00Z"},
        {"kind":"episode","id":"22000000-0000-0000-0000-000000000001","position_seconds":20.0,"duration_seconds":100.0,"completed":false,"updated_at":"2026-11-23T02:00:00Z"}
      ], "cursors":[], "removals":[]
    });
    let response = request(
        &app,
        "POST",
        "/api/viewer/progress/merge",
        merge,
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let response = body(response).await;
    assert!(
        response["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["status"] == "rejected" && item["reason"] == "not_found")
    );
    let hidden_removal = request(
        &app,
        "POST",
        "/api/viewer/progress/merge",
        json!({"progress":[],"cursors":[],"removals":[{"kind":"movie","id":"10000000-0000-0000-0000-000000000001","removed_at":"2026-11-23T03:00:00Z"}]}),
        Some(&cookie),
        Some(&csrf),
    )
    .await;
    let hidden_removal = body(hidden_removal).await;
    assert_eq!(hidden_removal["results"][0]["status"], "rejected");
    assert_eq!(hidden_removal["results"][0]["reason"], "not_found");
    assert!(
        response["progress"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "episode")
    );

    let duplicate = json!({"progress":[
      {"kind":"episode","id":"22000000-0000-0000-0000-000000000001","position_seconds":1.0,"duration_seconds":10.0,"completed":false,"updated_at":"2026-11-23T01:00:00Z"},
      {"kind":"episode","id":"22000000-0000-0000-0000-000000000001","position_seconds":2.0,"duration_seconds":10.0,"completed":false,"updated_at":"2026-11-23T02:00:00Z"}
    ],"cursors":[],"removals":[]});
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/viewer/progress/merge",
            duplicate,
            Some(&cookie),
            Some(&csrf)
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    let invalid = json!({"position_seconds":11.0,"duration_seconds":10.0,"completed":false,"updated_at":"2026-11-23T01:00:00Z"});
    assert_eq!(
        request(
            &app,
            "PUT",
            "/api/viewer/progress/episode/22000000-0000-0000-0000-000000000001",
            invalid,
            Some(&cookie),
            Some(&csrf)
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    let future = json!({"position_seconds":1.0,"duration_seconds":10.0,"completed":false,"updated_at":"2999-01-01T00:00:00Z"});
    assert_eq!(
        request(
            &app,
            "PUT",
            "/api/viewer/progress/episode/22000000-0000-0000-0000-000000000001",
            future,
            Some(&cookie),
            Some(&csrf)
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );

    let operations: Vec<Value> = (0..501).map(|index| json!({"kind":"episode","id":format!("22000000-0000-0000-0000-{index:012}"),"position_seconds":1.0,"duration_seconds":10.0,"completed":false,"updated_at":"2026-11-23T01:00:00Z"})).collect();
    let oversized = json!({"progress":operations,"cursors":[],"removals":[]});
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/viewer/progress/merge",
            oversized,
            Some(&cookie),
            Some(&csrf)
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
}

/// 验证多设备并发首次写入同一目标时全部成功，最终只保留客户端时间最新记录。
#[tokio::test]
async fn concurrent_viewer_progress_upserts_keep_the_newest_record() {
    let (_db, app) = setup().await;
    let (cookie, csrf) = credentials(&app, "Summer").await;
    let mut writes = Vec::new();
    for hour in 1..=12 {
        let app = app.clone();
        let cookie = cookie.clone();
        let csrf = csrf.clone();
        writes.push(tokio::spawn(async move {
            request(
                &app,
                "PUT",
                "/api/viewer/progress/movie/10000000-0000-0000-0000-000000000001",
                json!({"position_seconds":hour as f64,"duration_seconds":120.0,"completed":false,"updated_at":format!("2026-11-23T{hour:02}:00:00Z")}),
                Some(&cookie),
                Some(&csrf),
            )
            .await
            .status()
        }));
    }
    for write in writes {
        assert_eq!(write.await.unwrap(), StatusCode::OK);
    }
    let snapshot = body(
        request(
            &app,
            "GET",
            "/api/viewer/progress",
            json!(null),
            Some(&cookie),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(snapshot["progress"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["progress"][0]["position_seconds"], 12.0);
}

/// 验证多设备并发首次写入游标和墓碑时不冲突，并各自保留最新客户端时间。
#[tokio::test]
async fn concurrent_viewer_cursors_and_removals_keep_the_newest_record() {
    let (_db, app) = setup().await;
    let (cookie, csrf) = credentials(&app, "Summer").await;
    let mut operations = Vec::new();
    for hour in 1..=8 {
        let app = app.clone();
        let cookie = cookie.clone();
        let csrf = csrf.clone();
        operations.push(tokio::spawn(async move {
            let cursor = request(
                &app,
                "POST",
                "/api/viewer/progress/merge",
                json!({"progress":[],"cursors":[{"series_id":"20000000-0000-0000-0000-000000000001","episode_id":if hour == 8 { "22000000-0000-0000-0000-000000000002" } else { "22000000-0000-0000-0000-000000000001" },"updated_at":format!("2026-11-23T{hour:02}:00:00Z")}],"removals":[]}),
                Some(&cookie),
                Some(&csrf),
            )
            .await
            .status();
            let removal = request(
                &app,
                "DELETE",
                "/api/viewer/progress/movie/10000000-0000-0000-0000-000000000001",
                json!({"removed_at":format!("2026-11-23T{hour:02}:30:00Z")}),
                Some(&cookie),
                Some(&csrf),
            )
            .await
            .status();
            (cursor, removal)
        }));
    }
    for operation in operations {
        let (cursor, removal) = operation.await.unwrap();
        assert_eq!(cursor, StatusCode::OK);
        assert_eq!(removal, StatusCode::OK);
    }
    let snapshot = body(
        request(
            &app,
            "GET",
            "/api/viewer/progress",
            json!(null),
            Some(&cookie),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(
        snapshot["cursors"][0]["episode_id"],
        "22000000-0000-0000-0000-000000000002"
    );
}
