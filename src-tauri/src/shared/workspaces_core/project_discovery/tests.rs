use super::*;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("monitor-discovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn write(&self, path: &str, text: &str) {
        let path = self.0.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn detects_wordpress_mac_and_web_without_guessing_from_folder_names() {
    let f = Fixture::new();
    f.write(
        "wordpress/themes/client/style.css",
        "/* Theme Name: Test */",
    );
    f.write("mac/src-tauri/tauri.conf.json", "{}");
    f.write("web/package.json", r#"{"dependencies":{"next":"1"}}"#);
    f.write("docs/README.md", "WordPress Mac app web app");
    f.write("plugin/plugin.php", "<?php /* Plugin Name: Editor */");
    f.write("plugin/package.json", r#"{"dependencies":{"react":"1"}}"#);
    assert_eq!(project_type(&f.0.join("wordpress"), 2), Some("wordpress"));
    assert_eq!(project_type(&f.0.join("mac"), 2), Some("mac-app"));
    assert_eq!(project_type(&f.0.join("web"), 2), Some("web-app"));
    assert_eq!(project_type(&f.0.join("docs"), 2), None);
    assert_eq!(project_type(&f.0.join("plugin"), 2), Some("wordpress"));
}

#[test]
fn manifest_credentials_are_never_in_discovery_and_running_is_not_assumed() {
    let f = Fixture::new();
    f.write("site/.mrn-site.json", r#"{"provider":"siteground","liveUrl":"https://example.com","localUrl":"https://site.localhost","remoteSsh":"test@ssh.siteground.example","runtimeStatus":"provisioned","dbPassword":"synthetic-private-value","sshIdentityFile":"private-key-path"}"#);
    let (result, _) = inspect_local(&f.0.join("site"), &f.0, "", "");
    let encoded = serde_json::to_string(&result).unwrap();
    assert!(!encoded.contains("synthetic-private-value"));
    assert!(!encoded.contains("private-key-path"));
    assert_eq!(result.project_type.value, "wordpress");
    assert_eq!(result.local_hub.value, "Registered");
    assert_eq!(result.hosting.value, "SiteGround");
    assert_eq!(result.ssh.value, "ssh.siteground.example");
    let (local_website, _) = inspect_local(&f.0.join("site"), &f.0, "https://site.localhost", "");
    assert_eq!(local_website.website, "https://example.com/");
}

#[test]
fn ssh_aliases_require_exact_hosts_and_ignore_wildcards_and_commands() {
    let f = Fixture::new();
    f.write(".ssh/config", "Host good\n HostName example.com\n IdentityFile /private/key\nHost wrong\n HostName not-example.com\nHost *\n HostName example.com\n ProxyCommand secret-command\n");
    assert_eq!(ssh_aliases(&f.0, "https://example.com"), vec!["good"]);
    assert!(ssh_target("ssh -i /private/key host").is_none());
    assert!(website_url("https://user:password@example.com").is_none());
    assert!(!same_website(
        "https://example.com",
        "https://other.example.com"
    ));
}

#[test]
fn ambiguous_local_copies_do_not_claim_a_local_hub_connection() {
    let f = Fixture::new();
    f.write(
        "Development/MRN-sites/one/.mrn-site.json",
        r#"{"liveUrl":"https://example.com"}"#,
    );
    f.write(
        "Development/MRN-sites/two/.mrn-site.json",
        r#"{"liveUrl":"https://example.com"}"#,
    );
    f.write("project/README.md", "project");
    assert!(find_manifest(&f.0.join("project"), &f.0, "https://example.com").is_none());
}

#[test]
fn unknown_workspace_is_rejected_before_discovery() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let workspaces = Mutex::new(HashMap::new());
    assert!(runtime
        .block_on(discover_project_core(
            &workspaces,
            "missing",
            "".into(),
            "".into()
        ))
        .is_err());
}

#[test]
fn public_hosting_evidence_does_not_mistake_cloudflare_for_the_origin() {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("server", "cloudflare".parse().unwrap());
    headers.insert("cf-cache-status", "HIT".parse().unwrap());
    assert!(hosting_headers(&headers).is_none());
    headers.insert("x-sg-cdn", "1".parse().unwrap());
    assert_eq!(hosting_headers(&headers).unwrap().value, "SiteGround");
    headers.remove("x-sg-cdn");
    headers.insert("x-kinsta-cache", "HIT".parse().unwrap());
    assert_eq!(hosting_headers(&headers).unwrap().value, "Kinsta");
    assert!(!public_address("127.0.0.1".parse().unwrap()));
    assert!(!public_address("192.168.1.1".parse().unwrap()));
    assert!(!public_address("100.64.0.1".parse().unwrap()));
    assert!(!public_address("2001:db8::1".parse().unwrap()));
    assert!(!public_address("::ffff:127.0.0.1".parse().unwrap()));
}
