use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use movie_harbor_api::{
    app, auth,
    config::Config,
    entities::{admin_user, viewer_user},
    viewer_auth,
};
use sea_orm::{ConnectionTrait, EntityTrait};
use tower::ServiceExt;
mod support;

const SECRET: &str = "media-authorization-test-proxy-secret";

async fn setup() -> (support::TestDatabase, Router, String, String) {
    let db = support::TestDatabase::migrated("media_auth").await;
    db.execute_unprepared("INSERT INTO viewer_user (id, username, normalized_username, password_hash) VALUES ('70000000-0000-0000-0000-000000000001', 'Viewer', 'viewer', 'unused')").await.unwrap();
    let cfg = Config {
        listen_addr: "127.0.0.1:3000".parse().unwrap(),
        database_url: String::new(),
        media_dir: std::env::temp_dir().join(format!("media_auth_{}", uuid::Uuid::new_v4())),
        cookie_secure: true,
        public_origin: "https://harbor.test".into(),
        allow_insecure_lan_http: false,
        trust_proxy_headers: true,
        trusted_proxy_secret: Some(SECRET.into()),
        max_upload_bytes: 1024,
        allowed_video_mime_types: vec!["video/mp4".into()],
        admin_name: Some("Admin".into()),
        admin_initial_password: Some("admin-password".into()),
    };
    let app = app::build(db.connection(), &cfg).await.unwrap();
    // Authorization deliberately has no files to consult: ownership, not file existence, grants access.
    std::fs::remove_dir_all(&cfg.media_dir).unwrap();
    let viewer = viewer_user::Entity::find()
        .one(&*db)
        .await
        .unwrap()
        .unwrap();
    let admin = admin_user::Entity::find().one(&*db).await.unwrap().unwrap();
    let viewer = viewer_auth::session::create(&*db, &viewer)
        .await
        .ok()
        .unwrap();
    let admin = auth::session::create(&*db, &admin).await.ok().unwrap();
    (
        db,
        app,
        format!("mh_viewer_session={viewer}"),
        format!("mh_session={admin}"),
    )
}

fn id(number: u32) -> String {
    format!("71000000-0000-0000-0000-{number:012}")
}
fn key(number: u32, kind: &str) -> String {
    format!(
        "{kind}/ab/ab{number:030x}.{}",
        if kind == "poster" { "png" } else { "mp4" }
    )
}
async fn asset(db: &support::TestDatabase, number: u32, kind: &str) {
    db.execute_unprepared(&format!("INSERT INTO media_asset (id, storage_key, original_name, mime_type, byte_size, purpose) VALUES ('{}', '{}', 'fixture', '{}', 2, '{kind}')", id(number), key(number, kind), if kind == "poster" { "image/png" } else { "video/mp4" })).await.unwrap();
}
async fn authorize(app: &Router, uri: &str, cookie: Option<&str>) -> Response {
    request(app, uri, cookie, &[("x-movie-harbor-proxy-token", SECRET)]).await
}
async fn request(
    app: &Router,
    uri: &str,
    cookie: Option<&str>,
    headers: &[(&str, &str)],
) -> Response {
    let mut builder = Request::builder()
        .uri("/api/media/authorize")
        .header("x-forwarded-uri", uri);
    if let Some(cookie) = cookie {
        builder = builder.header("cookie", cookie);
    }
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    app.clone()
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap()
}
async fn expect(app: &Router, uri: &str, cookie: Option<&str>, allowed: bool) {
    let response = authorize(app, uri, cookie).await;
    assert_eq!(
        response.status(),
        if allowed {
            StatusCode::NO_CONTENT
        } else {
            StatusCode::NOT_FOUND
        },
        "{uri} cookie={}",
        cookie.is_some()
    );
    assert_eq!(response.headers()["cache-control"], "private, no-store");
}

// Catches missing owner lifecycle/privacy checks, including incomplete publication metadata.
#[tokio::test]
async fn movie_and_series_media_follow_complete_authorization_matrix() {
    let (db, app, viewer, admin) = setup().await;
    let mut number = 1;
    for private in [false, true] {
        for (status, published_at) in [
            ("published", "CURRENT_TIMESTAMP"),
            ("draft", "NULL"),
            ("archived", "CURRENT_TIMESTAMP"),
            ("published", "NULL"),
        ] {
            for kind in ["poster", "video"] {
                asset(&db, number, kind).await;
                db.execute_unprepared(&format!("INSERT INTO movie (id, name, status, is_private, published_at, {kind}_asset_id) VALUES ('{}', 'Movie', '{status}', {private}, {published_at}, '{}')", id(number), id(number))).await.unwrap();
                let uri = format!("/media/{}", key(number, kind));
                let published = status == "published" && published_at != "NULL";
                expect(&app, &uri, None, published && !private).await;
                expect(&app, &uri, Some(&viewer), published).await;
                expect(&app, &uri, Some(&admin), true).await;
                number += 1;
            }
            asset(&db, number, "poster").await;
            let series_id = id(number);
            db.execute_unprepared(&format!("INSERT INTO series (id, name, status, is_private, published_at, poster_asset_id) VALUES ('{series_id}', 'Series', '{status}', {private}, {published_at}, '{series_id}'); INSERT INTO season (id, series_id, number) VALUES ('{series_id}', '{series_id}', 1)")).await.unwrap();
            let published = status == "published" && published_at != "NULL";
            let uri = format!("/media/{}", key(number, "poster"));
            expect(&app, &uri, None, published && !private).await;
            expect(&app, &uri, Some(&viewer), published).await;
            expect(&app, &uri, Some(&admin), true).await;
            number += 1;
            for (episode_status, episode_at) in [
                ("published", "CURRENT_TIMESTAMP"),
                ("draft", "NULL"),
                ("archived", "CURRENT_TIMESTAMP"),
                ("published", "NULL"),
            ] {
                asset(&db, number, "video").await;
                db.execute_unprepared(&format!("INSERT INTO episode (id, season_id, number, name, status, published_at, video_asset_id) VALUES ('{}', '{series_id}', {number}, 'Episode', '{episode_status}', {episode_at}, '{}')", id(number), id(number))).await.unwrap();
                let uri = format!("/media/{}", key(number, "video"));
                let visible = published && episode_status == "published" && episode_at != "NULL";
                expect(&app, &uri, None, visible && !private).await;
                expect(&app, &uri, Some(&viewer), visible).await;
                expect(&app, &uri, Some(&admin), true).await;
                number += 1;
            }
        }
    }
}

// Catches accepting unowned/misattached assets, forged proxy headers or normalized unsafe paths.
#[tokio::test]
async fn invalid_paths_ownership_and_proxy_credentials_are_denied_even_for_admin() {
    let (db, app, viewer, admin) = setup().await;
    asset(&db, 1, "video").await;
    asset(&db, 2, "video").await;
    db.execute_unprepared(&format!("INSERT INTO movie (id, name, status, published_at, video_asset_id) VALUES ('{}', 'Public', 'published', CURRENT_TIMESTAMP, '{}')", id(1), id(1))).await.unwrap();
    let valid = format!("/media/{}", key(1, "video"));
    expect(&app, &valid, None, true).await;
    expect(&app, &format!("{valid}?download=1"), None, true).await;
    for uri in [
        format!("/media/{}", key(2, "video")),
        "/media/.incoming/file".into(),
        "/media/.quarantine/file".into(),
        valid.replace("/video/", "/poster/"),
        valid.replace("/ab/", "/aa/"),
        valid.replace("/ab/", "/ab/../ab/"),
        valid.replace("/ab/", "/ab//"),
        valid.replace("/ab/", "/%61b/"),
        valid.replace("/ab/", "/ab%2f"),
        valid.replace("/ab/", "/ab\\"),
        format!("{valid}#fragment"),
        format!("https://harbor.test{valid}"),
        format!("{valid}/extra"),
    ] {
        for cookie in [None, Some(viewer.as_str()), Some(admin.as_str())] {
            expect(&app, &uri, cookie, false).await;
        }
    }
    for headers in [
        vec![],
        vec![("x-movie-harbor-proxy-token", "wrong")],
        vec![
            ("x-movie-harbor-proxy-token", SECRET),
            ("x-movie-harbor-proxy-token", SECRET),
        ],
        vec![
            ("x-movie-harbor-proxy-token", SECRET),
            ("x-forwarded-uri", &valid),
        ],
    ] {
        let response = request(&app, &valid, Some(&admin), &headers).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.headers()["cache-control"], "private, no-store");
    }
    // Database purpose mismatch cannot be bypassed by admin preview.
    db.execute_unprepared(&format!(
        "UPDATE media_asset SET purpose = 'poster' WHERE id = '{}'",
        id(1)
    ))
    .await
    .unwrap();
    expect(&app, &valid, Some(&admin), false).await;
    db.execute_unprepared(&format!("UPDATE media_asset SET purpose = 'video' WHERE id = '{}'; UPDATE media_asset_ownership SET owner_id = '{}' WHERE asset_id = '{}'", id(1), id(99), id(1))).await.unwrap();
    expect(&app, &valid, Some(&admin), false).await;
}

// Catches cached decisions after privacy/lifecycle changes, expiration, revocation or user deletion.
#[tokio::test]
async fn subsequent_requests_recheck_privacy_lifecycle_and_sessions() {
    let (db, app, viewer, admin) = setup().await;
    asset(&db, 1, "video").await;
    db.execute_unprepared(&format!("INSERT INTO movie (id, name, status, published_at, video_asset_id) VALUES ('{}', 'Movie', 'published', CURRENT_TIMESTAMP, '{}')", id(1), id(1))).await.unwrap();
    let uri = format!("/media/{}", key(1, "video"));
    expect(&app, &uri, None, true).await;
    db.execute_unprepared("UPDATE movie SET is_private = true")
        .await
        .unwrap();
    expect(&app, &uri, None, false).await;
    expect(&app, &uri, Some(&viewer), true).await;
    expect(&app, &uri, Some("mh_viewer_session=invalid"), false).await;
    expect(&app, &uri, Some(&format!("{viewer}; {viewer}")), false).await;
    db.execute_unprepared(
        "UPDATE viewer_session SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'",
    )
    .await
    .unwrap();
    expect(&app, &uri, Some(&viewer), false).await;
    db.execute_unprepared(
        "UPDATE viewer_session SET expires_at = CURRENT_TIMESTAMP + INTERVAL '1 hour'",
    )
    .await
    .unwrap();
    expect(&app, &uri, Some(&viewer), true).await;
    db.execute_unprepared("DELETE FROM viewer_user")
        .await
        .unwrap();
    expect(&app, &uri, Some(&viewer), false).await;
    expect(&app, &uri, Some(&admin), true).await;
    db.execute_unprepared(
        "UPDATE admin_session SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'",
    )
    .await
    .unwrap();
    expect(&app, &uri, Some(&admin), false).await;
    db.execute_unprepared("UPDATE movie SET is_private = false, status = 'archived'")
        .await
        .unwrap();
    expect(&app, &uri, None, false).await;
}

#[tokio::test]
async fn authorization_requires_enabled_proxy_trust_and_a_configured_secret() {
    let (db, _, _, admin) = setup().await;
    asset(&db, 1, "video").await;
    db.execute_unprepared(&format!("INSERT INTO movie (id, name, status, published_at, video_asset_id) VALUES ('{}', 'Movie', 'published', CURRENT_TIMESTAMP, '{}')", id(1), id(1))).await.unwrap();
    for (enabled, digest) in [(false, Some(auth::csrf::digest(SECRET))), (true, None)] {
        let state = auth::AuthState {
            db: db.connection(),
            cookie_secure: true,
            origin_policy: auth::csrf::OriginPolicy::new(
                "https://harbor.test".parse().unwrap(),
                false,
            ),
            trust_proxy_headers: enabled,
            trusted_proxy_secret_digest: digest,
            limits: Default::default(),
            password_work: std::sync::Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let app = movie_harbor_api::media::routes::authorization_router(state);
        expect(
            &app,
            &format!("/media/{}", key(1, "video")),
            Some(&admin),
            false,
        )
        .await;
    }
}
