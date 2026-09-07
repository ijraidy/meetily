//! Tauri commands backing Settings > Sync.

use super::config;
use super::server::SyncState;
use log::info;
use serde::Serialize;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize)]
pub struct SyncConfigView {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
    /// Non-loopback IPv4 addresses, Tailscale (100.64.0.0/10) first.
    pub addresses: Vec<String>,
    /// The Tailscale address if one exists.
    pub tailscale_address: Option<String>,
    /// Address the UI should show first (Tailscale, else first LAN address).
    pub preferred_address: Option<String>,
    pub device_name: String,
    /// Whether the HTTP server is currently listening.
    pub running: bool,
    /// Port the server is actually bound to (differs from `port` only while restarting).
    pub running_port: Option<u16>,
}

async fn build_view(app: &AppHandle, state: &SyncState) -> Result<SyncConfigView, String> {
    let settings = config::load_settings(app)?;
    let addresses = config::local_addresses();
    let tailscale_address = addresses
        .iter()
        .find(|ip| {
            ip.parse::<std::net::Ipv4Addr>()
                .map(config::is_tailscale_ip)
                .unwrap_or(false)
        })
        .cloned();
    let preferred_address = config::preferred_address(&addresses);
    let running_port = state.running_port().await;
    Ok(SyncConfigView {
        enabled: settings.enabled,
        port: settings.port,
        token: settings.token,
        addresses,
        tailscale_address,
        preferred_address,
        device_name: config::device_name(),
        running: running_port.is_some(),
        running_port,
    })
}

#[tauri::command]
pub async fn sync_get_config(
    app: AppHandle,
    state: tauri::State<'_, SyncState>,
) -> Result<SyncConfigView, String> {
    build_view(&app, &state).await
}

#[tauri::command]
pub async fn sync_regenerate_token(
    app: AppHandle,
    state: tauri::State<'_, SyncState>,
) -> Result<SyncConfigView, String> {
    info!("[sync] regenerating pairing token");
    config::regenerate_token(&app)?;
    build_view(&app, &state).await
}

#[tauri::command]
pub async fn sync_set_enabled(
    app: AppHandle,
    state: tauri::State<'_, SyncState>,
    enabled: bool,
) -> Result<SyncConfigView, String> {
    info!("[sync] set enabled = {}", enabled);
    let settings = config::set_enabled(&app, enabled)?;
    state.apply(app.clone(), &settings).await?;
    build_view(&app, &state).await
}

#[tauri::command]
pub async fn sync_set_port(
    app: AppHandle,
    state: tauri::State<'_, SyncState>,
    port: u16,
) -> Result<SyncConfigView, String> {
    info!("[sync] set port = {}", port);
    let settings = config::set_port(&app, port)?;
    state.apply(app.clone(), &settings).await?;
    build_view(&app, &state).await
}
