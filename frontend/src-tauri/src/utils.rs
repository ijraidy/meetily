pub fn format_timestamp(seconds: f64) -> String {
    let total_seconds = seconds as u64;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let secs = total_seconds % 60;
    format!("{:02}:{:02}:{:02}", hours, minutes, secs)
}

/// Opens macOS System Settings to a specific privacy preference pane
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn open_system_settings(preference_pane: String) -> Result<(), String> {
    use std::process::Command;

    // Construct the URL for System Settings
    let url = format!("x-apple.systempreferences:com.apple.preference.security?{}", preference_pane);

    // Use the 'open' command on macOS to open the URL
    Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("Failed to open system settings: {}", e))?;

    Ok(())
} 
/// One-time migration of per-user directories written under the app's previous
/// name. The models, custom templates and notification settings directories are
/// keyed by app name (not by the Tauri identifier), so a rename would otherwise
/// orphan downloaded models and saved preferences. Each old directory is renamed
/// in place only when the new one does not exist yet; any failure is logged and
/// ignored so startup is never blocked.
pub fn migrate_legacy_app_dirs() {
    const OLD_DATA_DIR: &str = "Meetily"; // former app name (data/models/templates)
    const OLD_CONFIG_DIR: &str = "meetily"; // former app name (notification settings)

    let candidates = [
        (dirs::data_dir(), OLD_DATA_DIR, "Minuteman"),
        (dirs::config_dir(), OLD_CONFIG_DIR, "minuteman"),
    ];

    for (base, old_name, new_name) in candidates {
        let Some(base) = base else { continue };
        let old_path = base.join(old_name);
        let new_path = base.join(new_name);
        if !old_path.is_dir() || new_path.exists() {
            continue;
        }
        match std::fs::rename(&old_path, &new_path) {
            Ok(()) => log::info!(
                "Migrated legacy app directory {} -> {}",
                old_path.display(),
                new_path.display()
            ),
            Err(e) => log::warn!(
                "Could not migrate legacy app directory {}: {}",
                old_path.display(),
                e
            ),
        }
    }
}
