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
    config::Config,
    entities::{genre, movie_genre},
    genres::{self, service::GenreError},
};
use sea_orm::{ConnectOptions, ConnectionTrait, Database, DatabaseConnection, EntityTrait};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

const DEFAULT_GENRES: [&str; 12] = [
    "剧情",
    "喜剧",
    "动作",
    "科幻",
    "恐怖",
    "悬疑",
    "犯罪",
    "冒险",
    "奇幻",
    "家庭",
    "纪录片",
    "动画",
];

fn config() -> Config {
    Config {
        listen_addr: "127.0.0.1:3000".parse().unwrap(),
        database_url: String::new(),
        media_dir: "/tmp/media".into(),
        cookie_secure: true,
        public_origin: "https://harbor.test".into(),
        max_upload_bytes: 1024,
        admin_name: Some("Admin".into()),
        admin_initial_password: Some("initial-password".into()),
    }
}

async fn database() -> DatabaseConnection {
    let url =
        std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL is required for genre tests");
    let admin = Database::connect(&url).await.unwrap();
    let schema = format!("genres_test_{}", Uuid::new_v4().simple());
    admin
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let mut options = ConnectOptions::new(url);
    options.set_schema_search_path(schema);
    let db = Database::connect(options).await.unwrap();
    migration::Migrator::up(&db, None).await.unwrap();
    db
}

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    payload: Value,
    cookie: Option<&str>,
    csrf: Option<&str>,
    origin: Option<&str>,
) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "harbor.test")
        .header("content-type", "application/json");
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    if let Some(csrf) = csrf {
        request = request.header("x-csrf-token", csrf);
    }
    if let Some(origin) = origin {
        request = request.header("origin", origin);
    }
    let mut request = request.body(Body::from(payload.to_string())).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    app.clone().oneshot(request).await.unwrap()
}

async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

async fn credentials(app: &Router) -> (String, String) {
    let login = request(
        app,
        "POST",
        "/api/admin/login",
        json!({"name":"Admin","password":"initial-password"}),
        None,
        None,
        Some("https://harbor.test"),
    )
    .await;
    assert_eq!(login.status(), StatusCode::OK);
    let cookie = login.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let session = request(
        app,
        "GET",
        "/api/admin/session",
        json!(null),
        Some(&cookie),
        None,
        None,
    )
    .await;
    let csrf = body(session).await["csrf_token"]
        .as_str()
        .unwrap()
        .to_owned();
    (cookie, csrf)
}

async fn list(app: &Router, cookie: &str) -> Vec<Value> {
    let response = request(
        app,
        "GET",
        "/api/admin/genres",
        json!(null),
        Some(cookie),
        None,
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    body(response).await.as_array().unwrap().clone()
}

// Catches moving seed data to application startup, omitting a default, or changing display order.
#[tokio::test]
async fn migration_seeds_the_default_genres_in_display_order() {
    let db = database().await;
    let genres = genre::Entity::find().all(&db).await.unwrap();
    assert_eq!(genres.len(), DEFAULT_GENRES.len());
    let mut genres = genres;
    genres.sort_by_key(|genre| genre.sort_order);
    assert_eq!(
        genres
            .iter()
            .map(|genre| genre.name.as_str())
            .collect::<Vec<_>>(),
        DEFAULT_GENRES
    );
    assert!(genres.iter().all(|genre| genre.enabled));
}

// Catches unordered listing, missing CRUD behavior, or bypassing session/CSRF/configured-origin checks.
#[tokio::test]
async fn administrators_can_list_create_rename_and_deactivate_genres() {
    let db = database().await;
    let app = app::build(db, &config()).await.unwrap();
    let (cookie, csrf) = credentials(&app).await;

    assert_eq!(
        list(&app, &cookie)
            .await
            .iter()
            .map(|genre| genre["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        DEFAULT_GENRES
    );

    assert_eq!(
        request(
            &app,
            "POST",
            "/api/admin/genres",
            json!({"name":"西部"}),
            None,
            Some(&csrf),
            Some("https://harbor.test"),
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/admin/genres",
            json!({"name":"西部"}),
            Some(&cookie),
            None,
            Some("https://harbor.test"),
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/admin/genres",
            json!({"name":"西部"}),
            Some(&cookie),
            Some(&csrf),
            Some("https://evil.test"),
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );

    let created = request(
        &app,
        "POST",
        "/api/admin/genres",
        json!({"name":"  西部  "}),
        Some(&cookie),
        Some(&csrf),
        Some("https://harbor.test"),
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let created = body(created).await;
    assert_eq!(created["name"], "西部");
    assert_eq!(created["sort_order"], 13);
    assert_eq!(created["enabled"], true);
    let id = created["id"].as_str().unwrap();

    let renamed = request(
        &app,
        "PATCH",
        &format!("/api/admin/genres/{id}"),
        json!({"name":"经典西部"}),
        Some(&cookie),
        Some(&csrf),
        Some("https://harbor.test"),
    )
    .await;
    assert_eq!(renamed.status(), StatusCode::OK);
    assert_eq!(body(renamed).await["name"], "经典西部");

    let deactivated = request(
        &app,
        "POST",
        &format!("/api/admin/genres/{id}/deactivate"),
        json!({}),
        Some(&cookie),
        Some(&csrf),
        Some("https://harbor.test"),
    )
    .await;
    assert_eq!(deactivated.status(), StatusCode::OK);
    let deactivated = body(deactivated).await;
    assert_eq!(deactivated["name"], "经典西部");
    assert_eq!(deactivated["enabled"], false);
}

// Catches piecemeal reorder commits and accepting duplicate display positions.
#[tokio::test]
async fn reorder_is_atomic_and_rejects_duplicate_positions() {
    let app = app::build(database().await, &config()).await.unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let before = list(&app, &cookie).await;
    let reversed = before
        .iter()
        .rev()
        .enumerate()
        .map(|(index, genre)| json!({"id": genre["id"], "sort_order": index + 1}))
        .collect::<Vec<_>>();
    let response = request(
        &app,
        "PUT",
        "/api/admin/genres/order",
        json!({"items":reversed}),
        Some(&cookie),
        Some(&csrf),
        Some("https://harbor.test"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let reordered = body(response).await;
    assert_eq!(
        reordered
            .as_array()
            .unwrap()
            .iter()
            .map(|genre| genre["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        DEFAULT_GENRES.iter().rev().copied().collect::<Vec<_>>()
    );

    let mut invalid = reordered.as_array().unwrap().clone();
    invalid[0]["sort_order"] = json!(2);
    invalid[1]["sort_order"] = json!(2);
    let response = request(
        &app,
        "PUT",
        "/api/admin/genres/order",
        json!({"items":invalid}),
        Some(&cookie),
        Some(&csrf),
        Some("https://harbor.test"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        list(&app, &cookie).await,
        reordered.as_array().unwrap().clone()
    );
}

// Catches deleting referenced genres, removing old associations on deactivation, or allowing new ones.
#[tokio::test]
async fn referenced_or_inactive_genres_obey_association_rules() {
    let db = database().await;
    let app = app::build(db.clone(), &config()).await.unwrap();
    let (cookie, csrf) = credentials(&app).await;
    let genres = list(&app, &cookie).await;
    let referenced_id = genres[0]["id"].as_str().unwrap();
    let removable_id = genres[1]["id"].as_str().unwrap();
    let movie_id = Uuid::new_v4();
    db.execute_unprepared(&format!(
        "INSERT INTO movie (id, name) VALUES ('{movie_id}', 'Movie'); \
         INSERT INTO movie_genre (movie_id, genre_id) VALUES ('{movie_id}', '{referenced_id}')"
    ))
    .await
    .unwrap();

    assert_eq!(
        request(
            &app,
            "DELETE",
            &format!("/api/admin/genres/{referenced_id}"),
            json!({}),
            Some(&cookie),
            Some(&csrf),
            Some("https://harbor.test"),
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert!(
        genres::service::ensure_associable(&db, &[referenced_id.parse().unwrap()])
            .await
            .is_ok()
    );
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("/api/admin/genres/{referenced_id}/deactivate"),
            json!({}),
            Some(&cookie),
            Some(&csrf),
            Some("https://harbor.test"),
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert!(
        movie_genre::Entity::find()
            .one(&db)
            .await
            .unwrap()
            .is_some()
    );
    assert!(matches!(
        genres::service::ensure_associable(&db, &[referenced_id.parse().unwrap()]).await,
        Err(GenreError::Inactive)
    ));

    assert_eq!(
        request(
            &app,
            "DELETE",
            &format!("/api/admin/genres/{removable_id}"),
            json!({}),
            Some(&cookie),
            Some(&csrf),
            Some("https://harbor.test"),
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    assert!(
        genre::Entity::find_by_id(removable_id.parse::<Uuid>().unwrap())
            .one(&db)
            .await
            .unwrap()
            .is_none()
    );
}
