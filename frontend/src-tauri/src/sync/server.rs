//! axum server lifecycle, authentication and request logging.

use super::config;
use super::jobs::ImportJobs;
use super::routes;
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use log::{error, info, warn};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tokio::sync::{oneshot, Mutex};

/// Uploads above this size are rejected (2 GB).
pub const MAX_UPLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Body limit for the upload route: the file plus multipart framing/fields.
const UPLOAD_BODY_LIMIT: usize = (MAX_UPLOAD_BYTES as usize) + 4 * 1024 * 1024;
/// Body limit for JSON routes (summary markdown can be large but not huge).
const JSON_BODY_LIMIT: usize = 16 * 1024 * 1024;

/// Shared handler context.
pub struct ApiContext {
    pub app: AppHandle,
    pub jobs: Arc<ImportJobs>,
}

pub type Ctx = Arc<ApiContext>;

struct RunningServer {
    port: u16,
    shutdown: oneshot::Sender<()>,
}

/// Tauri-managed state: the running server (if any) and the import job map.
pub struct SyncState {
    running: Mutex<Option<RunningServer>>,
    pub jobs: Arc<ImportJobs>,
}

impl Default for SyncState {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncState {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(None),
            jobs: Arc::new(ImportJobs::new()),
        }
    }

    pub async fn running_port(&self) -> Option<u16> {
        self.running.lock().await.as_ref().map(|server| server.port)
    }

    /// Starts (or restarts) the server on `port`, bound to all interfaces.
    pub async fn start(&self, app: AppHandle, port: u16) -> Result<(), String> {
        let mut running = self.running.lock().await;
        if let Some(previous) = running.take() {
            info!("[sync] stopping server on port {} before restart", previous.port);
            let _ = previous.shutdown.send(());
        }

        let listener = bind_with_retry(port).await?;
        let local = listener
            .local_addr()
            .map(|addr| addr.to_string())
            .unwrap_or_else(|_| format!("0.0.0.0:{}", port));

        let ctx: Ctx = Arc::new(ApiContext {
            app,
            jobs: self.jobs.clone(),
        });
        let router = build_router(ctx);
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        tauri::async_runtime::spawn(async move {
            let serve = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            });
            if let Err(e) = serve.await {
                error!("[sync] server error: {}", e);
            }
            info!("[sync] server on port {} stopped", port);
        });

        info!("[sync] local sync API listening on http://{}/api/v1", local);
        *running = Some(RunningServer {
            port,
            shutdown: shutdown_tx,
        });
        Ok(())
    }

    pub async fn stop(&self) {
        let mut running = self.running.lock().await;
        if let Some(server) = running.take() {
            info!("[sync] stopping server on port {}", server.port);
            let _ = server.shutdown.send(());
        }
    }

    /// Brings the server in line with the persisted settings.
    pub async fn apply(&self, app: AppHandle, settings: &config::SyncSettings) -> Result<(), String> {
        if settings.enabled {
            if self.running_port().await == Some(settings.port) {
                return Ok(());
            }
            self.start(app, settings.port).await
        } else {
            self.stop().await;
            Ok(())
        }
    }
}

/// Binding right after a graceful shutdown can race with the old listener
/// being dropped, so retry briefly.
async fn bind_with_retry(port: u16) -> Result<tokio::net::TcpListener, String> {
    let addr = SocketAddr::from((Ipv4Addr::UNSPECIFIED, port));
    let mut last_error = None;
    for attempt in 0..20 {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => return Ok(listener),
            Err(e) => {
                if attempt == 0 {
                    warn!("[sync] bind {} failed ({}), retrying", addr, e);
                }
                last_error = Some(e);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
    Err(format!(
        "Could not bind sync server on port {}: {}",
        port,
        last_error
            .map(|e| e.to_string())
            .unwrap_or_else(|| "unknown error".to_string())
    ))
}

pub fn build_router(ctx: Ctx) -> Router {
    let upload_routes = Router::new()
        .route(
            "/meetings",
            get(routes::list_meetings).post(routes::upload_meeting),
        )
        .layer(DefaultBodyLimit::max(UPLOAD_BODY_LIMIT));

    let json_routes = Router::new()
        .route(
            "/meetings/:id",
            get(routes::get_meeting).delete(routes::delete_meeting),
        )
        .route("/meetings/:id/status", get(routes::get_status))
        .route(
            "/meetings/:id/summary",
            axum::routing::post(routes::generate_summary).put(routes::save_summary),
        )
        .layer(DefaultBodyLimit::max(JSON_BODY_LIMIT));

    let protected = upload_routes
        .merge(json_routes)
        .route_layer(middleware::from_fn_with_state(ctx.clone(), require_auth));

    Router::new()
        .route("/api/v1/health", get(routes::health))
        .nest("/api/v1", protected)
        .fallback(not_found)
        .layer(middleware::from_fn(log_requests))
        .with_state(ctx)
}

async fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": "not found" })),
    )
        .into_response()
}

/// Bearer-token authentication for every protected route.
async fn require_auth(State(ctx): State<Ctx>, request: Request<Body>, next: Next) -> Response {
    let presented = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(config::bearer_token);

    let expected = match config::current_token(&ctx.app) {
        Ok(token) => token,
        Err(e) => {
            error!("[sync] cannot read sync token: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "sync token unavailable" })),
            )
                .into_response();
        }
    };

    let authorised = presented
        .map(|token| config::constant_time_eq(token.as_bytes(), expected.as_bytes()))
        .unwrap_or(false);

    if authorised {
        next.run(request).await
    } else {
        let mut response = (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "unauthorized" })),
        )
            .into_response();
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static("Bearer realm=\"Minuteman\""),
        );
        response
    }
}

/// Logs method, path and status for every request (never the token).
async fn log_requests(request: Request<Body>, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let started = Instant::now();
    let response = next.run(request).await;
    info!(
        "[sync] {} {} -> {} ({} ms)",
        method,
        path,
        response.status().as_u16(),
        started.elapsed().as_millis()
    );
    response
}
