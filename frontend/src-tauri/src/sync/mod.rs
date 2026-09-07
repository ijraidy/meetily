//! Local HTTP sync API.
//!
//! Exposes an authenticated JSON API (bound on `0.0.0.0:<port>`, default 47110)
//! so that a companion device (the iPhone app, over Tailscale or the LAN) can
//! list meetings, upload recordings for transcription, trigger summary
//! generation and edit summaries. Everything goes through the same Rust code
//! paths as the desktop UI (import pipeline, summary service, repositories).
//!
//! Layout:
//! - `config`   - token/enabled/port persistence in the `sync.json` store,
//!                 constant-time token comparison, local address discovery
//! - `jobs`     - in-memory import job map fed by the import-progress events
//! - `markdown` - extraction of markdown from stored summary JSON
//! - `server`   - axum router, auth + logging middleware, server lifecycle
//! - `routes`   - request handlers
//! - `commands` - Tauri commands used by Settings > Sync

pub mod commands;
pub mod config;
pub mod jobs;
pub mod markdown;
pub mod routes;
pub mod server;

pub use server::SyncState;

use log::{error, info};
use tauri::{AppHandle, Listener, Manager};

/// Wire the sync subsystem into a running app: subscribe the job map to the
/// import events and start the HTTP server when sync is enabled.
///
/// Must be called after `SyncState` has been registered with `app.manage`.
pub fn init(app: &AppHandle) {
    let state = app.state::<SyncState>();
    let jobs = state.jobs.clone();

    // Progress events are emitted by the import pipeline regardless of who
    // started the import; the job map only applies them to its active job.
    let progress_jobs = jobs.clone();
    app.listen("import-progress", move |event| {
        progress_jobs.handle_progress_event(event.payload());
    });

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match config::load_settings(&app_handle) {
            Ok(settings) => {
                let state = app_handle.state::<SyncState>();
                if settings.enabled {
                    if let Err(e) = state.start(app_handle.clone(), settings.port).await {
                        error!("[sync] failed to start local sync server: {}", e);
                    }
                } else {
                    info!("[sync] local sync server disabled in settings");
                }
            }
            Err(e) => error!("[sync] failed to load sync settings: {}", e),
        }
    });
}
