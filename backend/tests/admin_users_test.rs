use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use movie_harbor_api::{
    app,
    auth::password,
    config::Config,
    entities::{viewer_session, viewer_user},
};
use sea_orm::{ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, Set};
use serde_json::{Value, json};
use tower::ServiceExt;
mod support;

type Credentials = (String, String);

// Catches DTO timestamps depending on Chrono's dev-only unified serde feature.
#[test]
fn viewer_summary_timestamps_are_explicit_rfc3339_strings() {
    let created_at =
        chrono::DateTime::parse_from_rfc3339("2026-10-10T14:03:02.123456+08:00").unwrap();
    let last_login_at = chrono::DateTime::parse_from_rfc3339("2026-10-10T15:04:03+08:00").unwrap();
    let user = viewer_user::Model {
        id: uuid::Uuid::from_u128(1),
        username: "Summer".into(),
        normalized_username: "summer".into(),
        password_hash: "internal-only".into(),
        version: 1,
        created_at,
        updated_at: created_at,
        last_login_at: Some(last_login_at),
    };
    let summary: movie_harbor_api::admin_users::dto::ViewerUserSummary = user.clone().into();
    let created: &str = &summary.created_at;
    let login: Option<&str> = summary.last_login_at.as_deref();
    assert_eq!(created, "2026-10-10T14:03:02.123456+08:00");
    assert_eq!(login, Some("2026-10-10T15:04:03+08:00"));
    let json = serde_json::to_value(summary).unwrap();
    assert_eq!(json["created_at"], created_at.to_rfc3339());
    assert_eq!(json["last_login_at"], "2026-10-10T15:04:03+08:00");
    assert_safe(&json);
    let summary: movie_harbor_api::admin_users::dto::ViewerUserSummary = viewer_user::Model {
        last_login_at: None,
        ..user
    }
    .into();
    assert!(serde_json::to_value(summary).unwrap()["last_login_at"].is_null());
}

async fn setup() -> (support::TestDatabase, Router, Credentials) {
    let db = support::TestDatabase::migrated("admin_users").await;
    let cfg = Config {
        listen_addr: "127.0.0.1:3000".parse().unwrap(),
        database_url: String::new(),
        media_dir: "/tmp/media".into(),
        cookie_secure: true,
        public_origin: "https://harbor.test".into(),
        allow_insecure_lan_http: false,
        trust_proxy_headers: false,
        trusted_proxy_secret: None,
        max_upload_bytes: 1024,
        allowed_video_mime_types: vec!["video/mp4".into()],
        admin_name: Some("Summer".into()),
        admin_initial_password: Some("admin-password".into()),
    };
    let app = app::build(db.connection(), &cfg).await.unwrap();
    let admin = login(
        &app,
        "/api/admin/login",
        json!({"name":"Summer","password":"admin-password"}),
    )
    .await;
    assert_eq!(admin.status(), StatusCode::OK);
    let cookie = cookie(&admin);
    let session = request(
        &app,
        "GET",
        "/api/admin/session",
        Value::Null,
        Some((&cookie, "")),
    )
    .await;
    let csrf = body(session).await["csrf_token"]
        .as_str()
        .unwrap()
        .to_owned();
    (db, app, (cookie, csrf))
}

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    payload: Value,
    auth: Option<(&str, &str)>,
) -> Response {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "harbor.test")
        .header("content-type", "application/json")
        .header("origin", "https://harbor.test");
    if let Some((cookie, csrf)) = auth {
        builder = builder
            .header("cookie", cookie)
            .header("x-csrf-token", csrf);
    }
    let mut request = builder.body(Body::from(payload.to_string())).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    app.clone().oneshot(request).await.unwrap()
}
async fn admin_json(
    app: &Router,
    method: &str,
    path: &str,
    payload: Value,
    admin: &Credentials,
) -> Response {
    request(app, method, path, payload, Some((&admin.0, &admin.1))).await
}
async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
fn cookie(response: &Response) -> String {
    response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}
async fn login(app: &Router, path: &str, payload: Value) -> Response {
    request(app, "POST", path, payload, None).await
}
async fn create(app: &Router, admin: &Credentials, username: &str) -> Value {
    let response = admin_json(
        app,
        "POST",
        "/api/admin/users",
        json!({"username":username,"password":"viewer-password"}),
        admin,
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    body(response).await
}
fn assert_safe(user: &Value) {
    let keys: Vec<_> = user
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "created_at",
            "has_active_session",
            "id",
            "last_login_at",
            "username",
            "version"
        ]
    );
}

// Catches short ordinary-user passwords bypassing the frontend or being counted by UTF-8 bytes.
#[tokio::test]
async fn viewer_creation_requires_at_least_eight_password_characters() {
    let (db, app, admin) = setup().await;
    for password in ["1234567", "😀😀😀😀😀😀😀"] {
        let response = admin_json(
            &app,
            "POST",
            "/api/admin/users",
            json!({"username":"short-user","password":password}),
            &admin,
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body(response).await,
            json!({"error":"密码至少需要 8 个字符。"})
        );
        assert!(
            viewer_user::Entity::find()
                .all(&*db)
                .await
                .unwrap()
                .is_empty()
        );
    }
    for (username, password) in [
        ("eight-ascii", "12345678"),
        ("eight-unicode", "😀😀😀😀😀😀😀😀"),
    ] {
        let response = admin_json(
            &app,
            "POST",
            "/api/admin/users",
            json!({"username":username,"password":password}),
            &admin,
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(
            login(
                &app,
                "/api/viewer/login",
                json!({"username":username,"password":password})
            )
            .await
            .status(),
            StatusCode::OK
        );
    }
}

// Catches rejected password changes mutating a version or revoking sessions before validation.
#[tokio::test]
async fn admin_viewer_password_change_requires_at_least_eight_characters() {
    let (db, app, admin) = setup().await;
    let user = create(&app, &admin, "Summer").await;
    let path = format!("/api/admin/users/{}/password", user["id"].as_str().unwrap());
    let before = viewer_user::Entity::find()
        .one(&*db)
        .await
        .unwrap()
        .unwrap();
    let logged_in = login(
        &app,
        "/api/viewer/login",
        json!({"username":"Summer","password":"viewer-password"}),
    )
    .await;
    assert_eq!(logged_in.status(), StatusCode::OK);
    for password in ["1234567", "😀😀😀😀😀😀😀"] {
        let response = admin_json(
            &app,
            "PUT",
            &path,
            json!({"version":1,"new_password":password}),
            &admin,
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body(response).await,
            json!({"error":"密码至少需要 8 个字符。"})
        );
        let unchanged = viewer_user::Entity::find_by_id(before.id)
            .one(&*db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.password_hash, before.password_hash);
        assert_eq!(unchanged.version, before.version);
        assert_eq!(
            viewer_session::Entity::find()
                .all(&*db)
                .await
                .unwrap()
                .len(),
            1
        );
    }
    for (version, password) in [(1, "12345678"), (2, "😀😀😀😀😀😀😀😀")] {
        let response = admin_json(
            &app,
            "PUT",
            &path,
            json!({"version":version,"new_password":password}),
            &admin,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body(response).await["version"], version + 1);
        assert!(
            viewer_session::Entity::find()
                .all(&*db)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            login(
                &app,
                "/api/viewer/login",
                json!({"username":"Summer","password":password})
            )
            .await
            .status(),
            StatusCode::OK
        );
    }
}

// Catches missing normalization, mixing administrator names with viewer uniqueness, and exposing hashes.
#[tokio::test]
async fn creation_normalizes_viewer_names_without_affecting_admin_and_rejects_renaming() {
    let (db, app, admin) = setup().await;
    let user = create(&app, &admin, " Summer ").await;
    assert_eq!(user["username"], "Summer");
    assert_eq!(user["version"], 1);
    assert_eq!(user["has_active_session"], false);
    assert!(user["last_login_at"].is_null());
    assert_safe(&user);
    let duplicate = admin_json(
        &app,
        "POST",
        "/api/admin/users",
        json!({"username":" summer ","password":"another-password"}),
        &admin,
    )
    .await;
    assert_eq!(duplicate.status(), StatusCode::CONFLICT);
    assert!(body(duplicate).await["error"].is_string());
    let rename = admin_json(
        &app,
        "PATCH",
        &format!("/api/admin/users/{}", user["id"].as_str().unwrap()),
        json!({"username":"Winter"}),
        &admin,
    )
    .await;
    assert_eq!(rename.status(), StatusCode::METHOD_NOT_ALLOWED);
    let stored = viewer_user::Entity::find()
        .one(&*db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.username, "Summer");
    assert_eq!(stored.normalized_username, "summer");
    assert_ne!(stored.password_hash, "viewer-password");
}

// Catches unstable tied-time ordering, duplicate session counts, expired sessions, and filtered overview.
#[tokio::test]
async fn list_has_fixed_stable_pages_and_global_overview() {
    let (db, app, admin) = setup().await;
    let hash = password::hash("viewer-password".into()).await.ok().unwrap();
    for index in 1..=23u128 {
        viewer_user::ActiveModel {
            id: Set(uuid::Uuid::from_u128(index)),
            username: Set(format!("User{index:02}")),
            normalized_username: Set(format!("user{index:02}")),
            password_hash: Set(hash.clone()),
            created_at: Set(chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z").unwrap()),
            ..Default::default()
        }
        .insert(&*db)
        .await
        .unwrap();
    }
    let viewer = viewer_user::Entity::find_by_id(uuid::Uuid::from_u128(2))
        .one(&*db)
        .await
        .unwrap()
        .unwrap();
    movie_harbor_api::viewer_auth::session::create(&*db, &viewer)
        .await
        .ok()
        .unwrap();
    movie_harbor_api::viewer_auth::session::create(&*db, &viewer)
        .await
        .ok()
        .unwrap();
    let expired = viewer_user::Entity::find_by_id(uuid::Uuid::from_u128(3))
        .one(&*db)
        .await
        .unwrap()
        .unwrap();
    movie_harbor_api::viewer_auth::session::create(&*db, &expired)
        .await
        .ok()
        .unwrap();
    db.execute_unprepared("UPDATE viewer_session SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE viewer_user_id = '00000000-0000-0000-0000-000000000003'").await.unwrap();
    let first = admin_json(&app, "GET", "/api/admin/users?size=20", Value::Null, &admin).await;
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(first.headers()["cache-control"], "no-store");
    let first = body(first).await;
    assert_eq!(first["page"], 1);
    assert_eq!(first["size"], 20);
    assert_eq!(first["total"], 23);
    assert_eq!(first["items"].as_array().unwrap().len(), 20);
    assert_eq!(first["items"][0]["username"], "User01");
    assert_eq!(first["items"][19]["username"], "User20");
    assert_eq!(first["items"][1]["has_active_session"], true);
    assert_eq!(first["items"][2]["has_active_session"], false);
    assert_eq!(first["summary"]["total_users"], 23);
    assert_eq!(first["summary"]["active_users"], 1);
    assert_eq!(first["summary"]["latest_user"]["username"], "User01");
    assert_safe(&first["summary"]["latest_user"]);
    for item in first["items"].as_array().unwrap() {
        assert_safe(item);
    }
    let second =
        body(admin_json(&app, "GET", "/api/admin/users?page=2", Value::Null, &admin).await).await;
    assert_eq!(second["items"].as_array().unwrap().len(), 3);
    assert_eq!(second["items"][0]["username"], "User21");
    let filtered = body(
        admin_json(
            &app,
            "GET",
            "/api/admin/users?q=user23",
            Value::Null,
            &admin,
        )
        .await,
    )
    .await;
    assert_eq!(filtered["total"], 1);
    assert_eq!(filtered["summary"]["total_users"], 23);
    assert_eq!(filtered["summary"]["active_users"], 1);
    let beyond =
        body(admin_json(&app, "GET", "/api/admin/users?page=3", Value::Null, &admin).await).await;
    assert_eq!(beyond["page"], 3);
    assert_eq!(beyond["total"], 23);
    assert_eq!(beyond["items"], json!([]));
    db.execute_unprepared("UPDATE viewer_user SET created_at = '2026-02-01T00:00:00Z' WHERE id = '00000000-0000-0000-0000-000000000017'").await.unwrap();
    let newest = body(admin_json(&app, "GET", "/api/admin/users", Value::Null, &admin).await).await;
    assert_eq!(newest["items"][0]["username"], "User23");
    assert_eq!(newest["items"][1]["username"], "User01");
    assert_eq!(newest["summary"]["latest_user"]["username"], "User23");
}

// Catches SQL interpolation or treating literal search characters as wildcards.
#[tokio::test]
async fn search_is_literal_case_insensitive_and_empty_overview_is_defined() {
    let (_db, app, admin) = setup().await;
    let empty = admin_json(&app, "GET", "/api/admin/users", Value::Null, &admin).await;
    assert_eq!(empty.status(), StatusCode::OK);
    let empty = body(empty).await;
    assert_eq!(
        empty["summary"],
        json!({"total_users":0,"active_users":0,"latest_user":null})
    );
    create(&app, &admin, "A%_!\\' OR 1=1 --").await;
    create(&app, &admin, "Other").await;
    for query in ["%25", "%5F", "%21", "%5C", "%27%20OR%201%3D1%20--"] {
        let response = admin_json(
            &app,
            "GET",
            &format!("/api/admin/users?q={query}"),
            Value::Null,
            &admin,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let page = body(response).await;
        assert_eq!(page["total"], 1);
        assert_eq!(page["items"][0]["username"], "A%_!\\' OR 1=1 --");
    }
}

// Catches unguarded routes, invalid pagination, blank credentials, malformed IDs and missing versions.
#[tokio::test]
async fn management_requires_admin_csrf_and_valid_requests() {
    let (_db, app, admin) = setup().await;
    assert_eq!(
        request(&app, "GET", "/api/admin/users", Value::Null, None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let user = create(&app, &admin, "Summer").await;
    let viewer = login(
        &app,
        "/api/viewer/login",
        json!({"username":"Summer","password":"viewer-password"}),
    )
    .await;
    let viewer_cookie = cookie(&viewer);
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/admin/users",
            Value::Null,
            Some((&viewer_cookie, ""))
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    for path in [
        "/api/admin/users?page=0",
        "/api/admin/users?page=1000001",
        "/api/admin/users?size=1",
        "/api/admin/users?size=21",
        "/api/admin/users?page=-1",
    ] {
        assert_eq!(
            admin_json(&app, "GET", path, Value::Null, &admin)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    for payload in [
        json!({"username":" ","password":"password"}),
        json!({"username":"Winter","password":" "}),
    ] {
        assert_eq!(
            admin_json(&app, "POST", "/api/admin/users", payload, &admin)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    for (method, path, payload) in [
        (
            "POST",
            "/api/admin/users".to_owned(),
            json!({"username":"Winter","password":"password"}),
        ),
        (
            "PUT",
            format!("/api/admin/users/{}/password", user["id"].as_str().unwrap()),
            json!({"version":1,"new_password":"new"}),
        ),
        (
            "DELETE",
            format!("/api/admin/users/{}", user["id"].as_str().unwrap()),
            json!({"version":1}),
        ),
    ] {
        assert_eq!(
            request(&app, method, &path, payload, Some((&admin.0, "")))
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        admin_json(
            &app,
            "DELETE",
            "/api/admin/users/invalid",
            json!({"version":1}),
            &admin
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    let missing = format!("/api/admin/users/{}", uuid::Uuid::new_v4());
    assert_eq!(
        admin_json(&app, "DELETE", &missing, json!({"version":1}), &admin)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        admin_json(
            &app,
            "PUT",
            &format!("{missing}/password"),
            json!({"version":1,"new_password":"new-password"}),
            &admin
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        admin_json(
            &app,
            "PUT",
            &format!("/api/admin/users/{}/password", user["id"].as_str().unwrap()),
            json!({"version":1,"new_password":" "}),
            &admin
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        admin_json(
            &app,
            "DELETE",
            &format!("/api/admin/users/{}", user["id"].as_str().unwrap()),
            json!({"version":0}),
            &admin
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        admin_json(
            &app,
            "DELETE",
            &format!("/api/admin/users/{}", user["id"].as_str().unwrap()),
            json!({}),
            &admin
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

// Catches stale writes, incomplete session revocation, old password reuse, and missing delete cascade.
#[tokio::test]
async fn reset_and_delete_check_version_and_revoke_all_sessions() {
    let (db, app, admin) = setup().await;
    let user = create(&app, &admin, "Summer").await;
    let id = user["id"].as_str().unwrap();
    let path = format!("/api/admin/users/{id}");
    let first = login(
        &app,
        "/api/viewer/login",
        json!({"username":"summer","password":"viewer-password"}),
    )
    .await;
    let second = login(
        &app,
        "/api/viewer/login",
        json!({"username":"Summer","password":"viewer-password"}),
    )
    .await;
    let cookies = [cookie(&first), cookie(&second)];
    let overview =
        body(admin_json(&app, "GET", "/api/admin/users", Value::Null, &admin).await).await;
    assert!(overview["items"][0]["last_login_at"].is_string());
    let conflict = admin_json(
        &app,
        "PUT",
        &format!("{path}/password"),
        json!({"version":2,"new_password":"new-password"}),
        &admin,
    )
    .await;
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/viewer/session",
            Value::Null,
            Some((&cookies[0], ""))
        )
        .await
        .status(),
        StatusCode::OK
    );
    let reset = admin_json(
        &app,
        "PUT",
        &format!("{path}/password"),
        json!({"version":1,"new_password":"new-password"}),
        &admin,
    )
    .await;
    assert_eq!(reset.status(), StatusCode::OK);
    let reset = body(reset).await;
    assert_eq!(reset["version"], 2);
    assert_eq!(reset["username"], "Summer");
    assert_eq!(reset["has_active_session"], false);
    assert_safe(&reset);
    for cookie in &cookies {
        assert_eq!(
            request(
                &app,
                "GET",
                "/api/viewer/session",
                Value::Null,
                Some((cookie, ""))
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert!(
        viewer_session::Entity::find()
            .all(&*db)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        login(
            &app,
            "/api/viewer/login",
            json!({"username":"Summer","password":"viewer-password"})
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let new_login = login(
        &app,
        "/api/viewer/login",
        json!({"username":"Summer","password":"new-password"}),
    )
    .await;
    assert_eq!(new_login.status(), StatusCode::OK);
    let new_cookie = cookie(&new_login);
    assert_eq!(
        admin_json(&app, "DELETE", &path, json!({"version":1}), &admin)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/viewer/session",
            Value::Null,
            Some((&new_cookie, ""))
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        admin_json(&app, "DELETE", &path, json!({"version":2}), &admin)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert!(
        viewer_user::Entity::find_by_id(id.parse::<uuid::Uuid>().unwrap())
            .one(&*db)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        viewer_session::Entity::find()
            .filter(viewer_session::Column::ViewerUserId.eq(id.parse::<uuid::Uuid>().unwrap()))
            .all(&*db)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/viewer/session",
            Value::Null,
            Some((&new_cookie, ""))
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        admin_json(&app, "DELETE", &path, json!({"version":2}), &admin)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(create(&app, &admin, "summer").await["version"], 1);
}

// Catches lost updates when two administrators submit the same snapshot concurrently.
#[tokio::test]
async fn concurrent_resets_allow_only_one_version_winner() {
    let (db, app, admin) = setup().await;
    let user = create(&app, &admin, "Summer").await;
    let path = format!("/api/admin/users/{}/password", user["id"].as_str().unwrap());
    let (a, b) = tokio::join!(
        admin_json(
            &app,
            "PUT",
            &path,
            json!({"version":1,"new_password":"password-a"}),
            &admin
        ),
        admin_json(
            &app,
            "PUT",
            &path,
            json!({"version":1,"new_password":"password-b"}),
            &admin
        )
    );
    let mut statuses = [a.status().as_u16(), b.status().as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409]);
    let stored = viewer_user::Entity::find()
        .one(&*db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.version, 2);
    let winner = if a.status() == StatusCode::OK {
        "password-a"
    } else {
        "password-b"
    };
    assert!(
        password::verify(winner.into(), stored.password_hash)
            .await
            .ok()
            .unwrap()
    );
}

// Catches relying solely on a pre-insert duplicate check instead of the database unique constraint.
#[tokio::test]
async fn concurrent_case_variant_creation_has_one_winner() {
    let (db, app, admin) = setup().await;
    let (a, b) = tokio::join!(
        admin_json(
            &app,
            "POST",
            "/api/admin/users",
            json!({"username":"Summer","password":"password-a"}),
            &admin
        ),
        admin_json(
            &app,
            "POST",
            "/api/admin/users",
            json!({"username":" SUMMER ","password":"password-b"}),
            &admin
        )
    );
    let mut statuses = [a.status().as_u16(), b.status().as_u16()];
    statuses.sort();
    assert_eq!(statuses, [201, 409]);
    assert_eq!(
        viewer_user::Entity::find().all(&*db).await.unwrap().len(),
        1
    );
}

// Catches password writes escaping the transaction when session deletion fails.
#[tokio::test]
async fn session_revocation_failure_rolls_back_password_and_version() {
    let (db, app, admin) = setup().await;
    let user = create(&app, &admin, "Summer").await;
    let viewer = login(
        &app,
        "/api/viewer/login",
        json!({"username":"Summer","password":"viewer-password"}),
    )
    .await;
    let viewer_cookie = cookie(&viewer);
    let before = viewer_user::Entity::find()
        .one(&*db)
        .await
        .unwrap()
        .unwrap();
    db.execute_unprepared("CREATE FUNCTION reject_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test revocation failure'; END $$").await.unwrap();
    db.execute_unprepared("CREATE TRIGGER reject_session_delete BEFORE DELETE ON viewer_session FOR EACH ROW EXECUTE FUNCTION reject_session_delete()").await.unwrap();
    let result = admin_json(
        &app,
        "PUT",
        &format!("/api/admin/users/{}/password", user["id"].as_str().unwrap()),
        json!({"version":1,"new_password":"new-password"}),
        &admin,
    )
    .await;
    assert_eq!(result.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let after = viewer_user::Entity::find()
        .one(&*db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.password_hash, before.password_hash);
    assert_eq!(after.version, 1);
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/viewer/session",
            Value::Null,
            Some((&viewer_cookie, ""))
        )
        .await
        .status(),
        StatusCode::OK
    );
    let result = admin_json(
        &app,
        "DELETE",
        &format!("/api/admin/users/{}", user["id"].as_str().unwrap()),
        json!({"version":1}),
        &admin,
    )
    .await;
    assert_eq!(result.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(
        viewer_user::Entity::find_by_id(before.id)
            .one(&*db)
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(
        viewer_session::Entity::find()
            .all(&*db)
            .await
            .unwrap()
            .len(),
        1
    );
}

// Catches independent locks letting a stale deletion remove a freshly reset user.
#[tokio::test]
async fn concurrent_reset_and_delete_cannot_both_commit_the_same_version() {
    let (db, app, admin) = setup().await;
    let user = create(&app, &admin, "Summer").await;
    let path = format!("/api/admin/users/{}", user["id"].as_str().unwrap());
    let password_path = format!("{path}/password");
    let (reset, deleted) = tokio::join!(
        admin_json(
            &app,
            "PUT",
            &password_path,
            json!({"version":1,"new_password":"new-password"}),
            &admin
        ),
        admin_json(&app, "DELETE", &path, json!({"version":1}), &admin)
    );
    match (reset.status(), deleted.status()) {
        (StatusCode::OK, StatusCode::CONFLICT) => assert_eq!(
            viewer_user::Entity::find()
                .one(&*db)
                .await
                .unwrap()
                .unwrap()
                .version,
            2
        ),
        (StatusCode::NOT_FOUND, StatusCode::NO_CONTENT) => assert!(
            viewer_user::Entity::find()
                .all(&*db)
                .await
                .unwrap()
                .is_empty()
        ),
        statuses => panic!("unexpected concurrent results: {statuses:?}"),
    }
}
