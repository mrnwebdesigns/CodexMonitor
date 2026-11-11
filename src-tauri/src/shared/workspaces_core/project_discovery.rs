//! Read-only project evidence. Never return manifests or SSH configuration verbatim.
mod mainwp;

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use tokio::sync::Mutex;

use crate::types::{ProjectDiscovery, ProjectFinding, WorkspaceEntry};

pub(super) fn finding(value: &str, detail: &str) -> ProjectFinding {
    ProjectFinding {
        value: value.into(),
        detail: detail.into(),
    }
}

pub(super) fn read_bounded(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > 512 * 1024 {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > 512 * 1024 {
        return None;
    }
    let mut text = String::new();
    file.take(512 * 1024).read_to_string(&mut text).ok()?;
    Some(text)
}

// Intentionally deserialize an allowlist: manifests may also contain database credentials.
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Manifest {
    local_root: String,
    live_url: String,
    local_url: String,
    provider: String,
    remote_ssh: String,
    runtime_status: String,
}

pub(crate) fn website_url(text: &str) -> Option<reqwest::Url> {
    let text = text.trim();
    let url = reqwest::Url::parse(if text.contains("://") {
        text
    } else {
        return website_url(&format!("https://{text}"));
    })
    .ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return None;
    }
    Some(url)
}

fn same_website(a: &str, b: &str) -> bool {
    match (website_url(a), website_url(b)) {
        (Some(a), Some(b)) => {
            a.host_str() == b.host_str()
                && a.port_or_known_default() == b.port_or_known_default()
                && a.path().trim_end_matches('/') == b.path().trim_end_matches('/')
        }
        _ => false,
    }
}

fn canonical(path: &Path) -> Option<PathBuf> {
    path.canonicalize().ok()
}

fn find_manifest(root: &Path, home: &Path, website: &str) -> Option<Manifest> {
    // Themes/plugins can be nested below the Local Hub root.
    for parent in root.ancestors().take(5) {
        if let Some(manifest) = read_bounded(&parent.join(".mrn-site.json"))
            .and_then(|s| serde_json::from_str::<Manifest>(&s).ok())
        {
            return Some(manifest);
        }
    }
    let data_root = std::env::var_os("MRN_LOCAL_HUB_DATA_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".mrn-local-hub"));
    let settings: serde_json::Value = read_bounded(&data_root.join("settings.json"))
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let sites = std::env::var_os("MRN_LOCAL_SITES_ROOT")
        .map(PathBuf::from)
        .or_else(|| settings["sitesRoot"].as_str().map(PathBuf::from))
        .unwrap_or_else(|| home.join("Development/MRN-sites"));
    let mut matches = Vec::new();
    for entry in std::fs::read_dir(sites).ok()?.take(512).flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Some(m) = read_bounded(&entry.path().join(".mrn-site.json"))
            .and_then(|s| serde_json::from_str::<Manifest>(&s).ok())
        else {
            continue;
        };
        if canonical(Path::new(&m.local_root)).is_some_and(|p| root.starts_with(p)) {
            return Some(m);
        }
        if !website.is_empty() && same_website(website, &m.live_url) {
            matches.push(m);
        }
    }
    // Multiple local copies of the same live site are ambiguous.
    if matches.len() == 1 {
        matches.pop()
    } else {
        None
    }
}

fn project_type(root: &Path, depth: usize) -> Option<&'static str> {
    if root.join("wp-config.php").is_file()
        || root.join("wp-includes/version.php").is_file()
        || root.join("wp-content").is_dir()
    {
        return Some("wordpress");
    }
    if read_bounded(&root.join("style.css")).is_some_and(|s| s.contains("Theme Name:")) {
        return Some("wordpress");
    }
    if root.join("src-tauri/tauri.conf.json").is_file() || root.join("Package.swift").is_file() {
        return Some("mac-app");
    }
    let entries: Vec<_> = std::fs::read_dir(root).ok()?.take(160).flatten().collect();
    for entry in &entries {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".xcodeproj") || name.ends_with(".xcworkspace") {
            return Some("mac-app");
        }
        if name.ends_with(".php")
            && read_bounded(&entry.path())
                .is_some_and(|s| s.lines().take(60).any(|l| l.contains("Plugin Name:")))
        {
            return Some("wordpress");
        }
    }
    // WordPress plugins often use React for their editor; the PHP header wins.
    let package: serde_json::Value = read_bounded(&root.join("package.json"))
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    for section in ["dependencies", "devDependencies"] {
        if package[section]["@tauri-apps/api"].is_string() {
            return Some("mac-app");
        }
        if ["react", "vue", "next", "svelte", "vite", "astro", "express"]
            .iter()
            .any(|name| package[section][name].is_string())
        {
            return Some("web-app");
        }
    }
    if depth == 0 {
        return None;
    }
    for entry in entries {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.')
            || matches!(
                name.as_ref(),
                "node_modules"
                    | "vendor"
                    | "target"
                    | "dist"
                    | "build"
                    | "backups"
                    | "qa-reports"
                    | "reports"
                    | "review"
            )
        {
            continue;
        }
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            if let Some(kind) = project_type(&entry.path(), depth - 1) {
                return Some(kind);
            }
        }
    }
    None
}

fn provider(value: &str) -> Option<&'static str> {
    let value = value.to_ascii_lowercase();
    if value.contains("siteground") || value.ends_with(".sgvps.net") {
        Some("SiteGround")
    } else if value.contains("kinsta") {
        Some("Kinsta")
    } else if value.contains("wpmudev") || value.ends_with(".tempurl.host") {
        Some("WPMU DEV")
    } else if value.contains("cloudways") {
        Some("Cloudways")
    } else if value.contains("wpengine") {
        Some("WP Engine")
    } else {
        None
    }
}

fn ssh_target(value: &str) -> Option<String> {
    // Only return an SSH host/alias; never accept commands, passwords, URLs, or options.
    let target = value.trim().rsplit('@').next()?;
    if !target.is_empty()
        && target.len() < 254
        && target
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        && !target.starts_with('-')
    {
        Some(target.into())
    } else {
        None
    }
}

fn ssh_aliases(home: &Path, website: &str) -> Vec<String> {
    let Some(url) = website_url(website) else {
        return Vec::new();
    };
    let host = url.host_str().unwrap_or_default();
    let Some(config) = read_bounded(&home.join(".ssh/config")) else {
        return Vec::new();
    };
    let mut aliases = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for line in config.lines() {
        let line = line.split('#').next().unwrap_or_default().replace('=', " ");
        let mut words = line.split_whitespace();
        match words
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "host" => {
                names = words.filter_map(ssh_target).collect();
                if names.iter().any(|n| n == host) {
                    aliases.extend(names.clone());
                }
            }
            "hostname" if words.next() == Some(host) => aliases.extend(names.clone()),
            _ => {}
        }
    }
    aliases.sort();
    aliases.dedup();
    aliases
}

fn inspect_local(
    root: &Path,
    home: &Path,
    website: &str,
    hint: &str,
) -> (ProjectDiscovery, Option<String>) {
    let manifest = find_manifest(root, home, website);
    let kind = if matches!(hint, "wordpress" | "mac-app" | "web-app" | "other") {
        Some(hint)
    } else if manifest.is_some() {
        Some("wordpress")
    } else {
        project_type(root, 2)
    };
    let mut result = ProjectDiscovery {
        checked_at: chrono::Utc::now().timestamp_millis(),
        website: website_url(website).map(|u| u.to_string()).unwrap_or_default(),
        project_type: finding(kind.unwrap_or(""), if !hint.is_empty() { "Selected project type" } else { "Detected from project files and Local Hub metadata" }),
        hosting: finding("Unknown", "Hosting could not be identified from local configuration"),
        ssh: finding("Not found", "No matching target found in the Local Hub manifest or ~/.ssh/config; no SSH session was attempted"),
        local_hub: finding("Not found", "No unambiguous matching Local Hub manifest found"),
        mainwp: finding("Not checked", "Discover connections checks the exact WordPress website"),
    };
    let mut local_url = None;
    if let Some(m) = manifest {
        if result.website.is_empty() || same_website(&result.website, &m.local_url) {
            result.website = website_url(&m.live_url)
                .map(|u| u.to_string())
                .unwrap_or_default();
        }
        result.local_hub = finding(
            "Registered",
            &format!(
                "Local Hub manifest reports: {}. Running status has not been verified.",
                m.runtime_status
            ),
        );
        local_url = website_url(&m.local_url).map(|u| u.to_string());
        if let Some(host) = ssh_target(&m.remote_ssh) {
            result.ssh = finding(
                &host,
                "Configured in the Local Hub manifest; SSH access has not been tested",
            );
            if let Some(name) = provider(&host) {
                result.hosting = finding(name, "Suggested by the configured SSH target; this may differ from current live hosting");
            }
        }
        if let Some(name) = provider(&m.provider) {
            result.hosting = finding(name, "Provider recorded in the Local Hub manifest; current live hosting has not been verified");
        }
    }
    let aliases = ssh_aliases(home, &result.website);
    if !aliases.is_empty() {
        result.ssh = finding(
            &aliases.join(", "),
            "Matching ~/.ssh/config aliases; SSH access has not been tested",
        );
    }
    (result, local_url)
}

async fn check_local_site(url: &str) -> bool {
    let Some(url) = website_url(url) else {
        return false;
    };
    let host = url.host_str().unwrap_or_default();
    if host != "localhost" && host != "127.0.0.1" && !host.ends_with(".localhost") {
        return false;
    }
    // Local Hub uses a self-signed certificate. This client is restricted to loopback.
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(3))
        .resolve(
            host,
            ([127, 0, 0, 1], url.port_or_known_default().unwrap_or(443)).into(),
        )
        .build()
    else {
        return false;
    };
    client
        .head(url)
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}

fn hosting_headers(headers: &reqwest::header::HeaderMap) -> Option<ProjectFinding> {
    // Provider-documented markers, rather than generic proxy/cache headers:
    // https://kinsta.com/docs/wordpress-hosting/wordpress-analytics-mykinsta/
    // https://www.siteground.com/kb/siteground-cdn-configuration/
    if headers.contains_key("x-kinsta-cache") || headers.contains_key("ki-cf-cache-status") {
        Some(finding(
            "Kinsta",
            "Kinsta response headers detected on the live website",
        ))
    } else if headers.get("x-sg-cdn").is_some_and(|v| v == "1") {
        Some(finding(
            "SiteGround",
            "SiteGround CDN detected on the live website; origin hosting may need confirmation",
        ))
    } else {
        None
    }
}

fn public_address(address: std::net::IpAddr) -> bool {
    match address {
        std::net::IpAddr::V4(ip) => {
            let [first, second, _, _] = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && !ip.is_broadcast()
                && !ip.is_documentation()
                && first != 0
                && first < 224
                && !(first == 100 && (64..=127).contains(&second))
                && !(first == 198 && matches!(second, 18 | 19))
                && !(first == 192 && second == 0)
        }
        std::net::IpAddr::V6(ip) => {
            !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_unique_local()
                && !ip.is_unicast_link_local()
                && !ip.is_multicast()
                && ip.to_ipv4_mapped().is_none()
                && (ip.segments()[0] & 0xe000) == 0x2000
                && !(ip.segments()[0] == 0x2001
                    && (ip.segments()[1] < 0x200 || ip.segments()[1] == 0xdb8))
        }
    }
}

async fn check_live_hosting(website: &str) -> Option<ProjectFinding> {
    let mut url = website_url(website)?;
    let host = url.host_str()?.to_string();
    let port = url.port_or_known_default()?;
    // Probe only the origin homepage, with no credentials, cookies, or user-supplied query.
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    let addresses = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::net::lookup_host((host.as_str(), port)),
    )
    .await
    .ok()?
    .ok()?;
    let addresses: Vec<_> = addresses.take(16).collect();
    if addresses.is_empty() || addresses.iter().any(|a| !public_address(a.ip())) {
        return None;
    }
    // Pin the resolved public address, disable proxies and redirects, and keep normal TLS verification.
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(5))
        .resolve(&host, addresses[0])
        .build()
        .ok()?;
    let response = client.head(url).send().await.ok()?;
    if response.status().is_client_error() || response.status().is_server_error() {
        return None;
    }
    hosting_headers(response.headers())
}

pub(crate) async fn discover_project_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: &str,
    website: String,
    project_type: String,
) -> Result<ProjectDiscovery, String> {
    let root = workspaces
        .lock()
        .await
        .get(workspace_id)
        .map(|w| PathBuf::from(&w.path))
        .ok_or("Workspace not found")?;
    if !website.trim().is_empty() && website_url(&website).is_none() {
        return Err("Enter an HTTP or HTTPS website without credentials".into());
    }
    let home = crate::codex::home::resolve_home_dir().ok_or("Home directory unavailable")?;
    let mainwp_home = home.clone();
    let (mut result, local_url) = tokio::task::spawn_blocking(move || {
        let root = root
            .canonicalize()
            .map_err(|_| "Project folder is unavailable")?;
        Ok::<_, String>(inspect_local(&root, &home, &website, &project_type))
    })
    .await
    .map_err(|_| "Project discovery failed")??;
    if let Some(url) = local_url {
        if check_local_site(&url).await {
            result.local_hub = finding(
                "Responding locally",
                &format!("{url} responded successfully on loopback; Local Hub registration found"),
            );
        }
    }
    if result.project_type.value == "wordpress" {
        if let Some(hosting) = check_live_hosting(&result.website).await {
            result.hosting = hosting;
        }
        result.mainwp = mainwp::discover(&mainwp_home, &result.website).await;
    } else if result.project_type.value.is_empty() {
        result.mainwp = finding(
            "Not checked",
            "Select WordPress as the project type and add its live website to check MainWP",
        );
    } else {
        result.mainwp = finding("Not applicable", "MainWP manages WordPress sites");
    }
    result.checked_at = chrono::Utc::now().timestamp_millis();
    Ok(result)
}

#[cfg(test)]
mod tests;
