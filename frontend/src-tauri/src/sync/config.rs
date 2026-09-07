//! Sync settings persistence (tauri-plugin-store `sync.json`), token handling
//! and local network address discovery.

use log::warn;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

/// Store file (relative to the app data directory, managed by tauri-plugin-store).
pub const STORE_FILE: &str = "sync.json";
/// Default TCP port for the sync API.
pub const DEFAULT_PORT: u16 = 47110;

const KEY_TOKEN: &str = "token";
const KEY_ENABLED: &str = "enabled";
const KEY_PORT: &str = "port";

/// Number of random bytes in a token (hex encoded -> 64 characters).
const TOKEN_BYTES: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncSettings {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
}

/// Loads the settings, generating and persisting a token on first use.
pub fn load_settings<R: Runtime>(app: &AppHandle<R>) -> Result<SyncSettings, String> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| format!("Failed to open sync store: {}", e))?;

    let mut dirty = false;

    let token = match store
        .get(KEY_TOKEN)
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|token| is_valid_token(token))
    {
        Some(token) => token,
        None => {
            let token = generate_token();
            store.set(KEY_TOKEN, serde_json::Value::String(token.clone()));
            dirty = true;
            token
        }
    };

    let enabled = match store.get(KEY_ENABLED).and_then(|value| value.as_bool()) {
        Some(enabled) => enabled,
        None => {
            store.set(KEY_ENABLED, serde_json::Value::Bool(true));
            dirty = true;
            true
        }
    };

    let port = store
        .get(KEY_PORT)
        .and_then(|value| value.as_u64())
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_PORT);

    if dirty {
        store
            .save()
            .map_err(|e| format!("Failed to save sync store: {}", e))?;
    }

    Ok(SyncSettings {
        enabled,
        port,
        token,
    })
}

/// Reads only the token (used per request by the auth middleware).
pub fn current_token<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    load_settings(app).map(|settings| settings.token)
}

pub fn set_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<SyncSettings, String> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| format!("Failed to open sync store: {}", e))?;
    store.set(KEY_ENABLED, serde_json::Value::Bool(enabled));
    store
        .save()
        .map_err(|e| format!("Failed to save sync store: {}", e))?;
    load_settings(app)
}

pub fn set_port<R: Runtime>(app: &AppHandle<R>, port: u16) -> Result<SyncSettings, String> {
    if port < 1024 {
        return Err("Port must be 1024 or higher".to_string());
    }
    let store = app
        .store(STORE_FILE)
        .map_err(|e| format!("Failed to open sync store: {}", e))?;
    store.set(KEY_PORT, serde_json::Value::from(port));
    store
        .save()
        .map_err(|e| format!("Failed to save sync store: {}", e))?;
    load_settings(app)
}

/// Replaces the token with a freshly generated one.
pub fn regenerate_token<R: Runtime>(app: &AppHandle<R>) -> Result<SyncSettings, String> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| format!("Failed to open sync store: {}", e))?;
    store.set(KEY_TOKEN, serde_json::Value::String(generate_token()));
    store
        .save()
        .map_err(|e| format!("Failed to save sync store: {}", e))?;
    load_settings(app)
}

/// 32 bytes from the OS CSPRNG, hex encoded (64 lowercase hex characters).
pub fn generate_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex_encode(&bytes)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// A stored token is accepted only if it looks like something we generated.
pub fn is_valid_token(token: &str) -> bool {
    token.len() == TOKEN_BYTES * 2 && token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Constant-time byte comparison. The running time depends only on the length
/// of the longer input, never on where the first difference occurs.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let len = a.len().max(b.len());
    let mut diff = (a.len() ^ b.len()) as u8;
    for i in 0..len {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= x ^ y;
    }
    // black_box keeps the optimiser from short-circuiting on `diff`.
    std::hint::black_box(diff) == 0
}

/// Extracts the bearer token from an `Authorization` header value.
pub fn bearer_token(header_value: &str) -> Option<&str> {
    let (scheme, rest) = header_value.trim().split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = rest.trim();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

/// Tailscale hands out addresses from the CGNAT range 100.64.0.0/10.
pub fn is_tailscale_ip(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

/// Non-loopback IPv4 addresses of this machine, Tailscale addresses first.
pub fn local_addresses() -> Vec<String> {
    let mut addresses: Vec<(bool, String)> = match if_addrs::get_if_addrs() {
        Ok(interfaces) => interfaces
            .into_iter()
            .filter(|iface| !iface.is_loopback())
            .filter_map(|iface| match iface.ip() {
                IpAddr::V4(ip) if !ip.is_link_local() && !ip.is_unspecified() => {
                    Some((is_tailscale_ip(ip), ip.to_string()))
                }
                _ => None,
            })
            .collect(),
        Err(e) => {
            warn!("[sync] failed to enumerate network interfaces: {}", e);
            Vec::new()
        }
    };
    addresses.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    addresses.dedup();
    addresses.into_iter().map(|(_, ip)| ip).collect()
}

/// The address a client should prefer: Tailscale if present, else the first LAN address.
pub fn preferred_address(addresses: &[String]) -> Option<String> {
    addresses
        .iter()
        .find(|ip| ip.parse::<Ipv4Addr>().map(is_tailscale_ip).unwrap_or(false))
        .or_else(|| addresses.first())
        .cloned()
}

pub fn device_name() -> String {
    sysinfo::System::host_name().unwrap_or_else(|| "This PC".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_tokens_are_64_hex_chars_and_unique() {
        let a = generate_token();
        let b = generate_token();
        assert!(is_valid_token(&a));
        assert!(is_valid_token(&b));
        assert_ne!(a, b);
    }

    #[test]
    fn constant_time_eq_matches_equal_inputs() {
        let token = generate_token();
        assert!(constant_time_eq(token.as_bytes(), token.as_bytes()));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn constant_time_eq_rejects_differences_anywhere() {
        assert!(!constant_time_eq(b"abcdef", b"abcdeg"));
        assert!(!constant_time_eq(b"abcdef", b"bbcdef"));
        assert!(!constant_time_eq(b"abcdef", b"abcdefg"));
        assert!(!constant_time_eq(b"abcdefg", b"abcdef"));
        assert!(!constant_time_eq(b"", b"a"));
        // A prefix of the token must never authenticate.
        assert!(!constant_time_eq(b"abcdef", b"abc"));
    }

    #[test]
    fn is_valid_token_rejects_malformed_values() {
        assert!(!is_valid_token(""));
        assert!(!is_valid_token("abc"));
        assert!(!is_valid_token(&"g".repeat(64)));
        assert!(is_valid_token(&"a".repeat(64)));
    }

    #[test]
    fn bearer_token_parsing() {
        assert_eq!(bearer_token("Bearer abc"), Some("abc"));
        assert_eq!(bearer_token("bearer   abc  "), Some("abc"));
        assert_eq!(bearer_token("Basic abc"), None);
        assert_eq!(bearer_token("Bearer "), None);
        assert_eq!(bearer_token("abc"), None);
    }

    #[test]
    fn tailscale_range_detection() {
        assert!(is_tailscale_ip(Ipv4Addr::new(100, 64, 0, 1)));
        assert!(is_tailscale_ip(Ipv4Addr::new(100, 101, 5, 9)));
        assert!(is_tailscale_ip(Ipv4Addr::new(100, 127, 255, 254)));
        assert!(!is_tailscale_ip(Ipv4Addr::new(100, 63, 0, 1)));
        assert!(!is_tailscale_ip(Ipv4Addr::new(100, 128, 0, 1)));
        assert!(!is_tailscale_ip(Ipv4Addr::new(192, 168, 1, 10)));
    }

    #[test]
    fn preferred_address_prefers_tailscale() {
        let addrs = vec!["192.168.1.10".to_string(), "100.101.1.2".to_string()];
        assert_eq!(preferred_address(&addrs).as_deref(), Some("100.101.1.2"));
        let lan_only = vec!["192.168.1.10".to_string()];
        assert_eq!(preferred_address(&lan_only).as_deref(), Some("192.168.1.10"));
        assert_eq!(preferred_address(&[]), None);
    }
}
