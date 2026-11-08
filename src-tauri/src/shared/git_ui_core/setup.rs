use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use git2::{ObjectType, Oid, Repository};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::context::workspace_entry_for_id;
use crate::shared::process_core::tokio_command;
use crate::types::WorkspaceEntry;
use crate::utils::{git_env_path, resolve_git_binary};

const MAX_FILES: usize = 5000;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_REVIEW_BYTES: u64 = 64 * 1024 * 1024;
const BASE_RULES: &str = ".DS_Store\nThumbs.db\n.env\n.env.*\n!.env.example\n!.env.sample\n!.env.template\n.aws/\n.ssh/\n.mrn-local/\n*.pem\n*.key\n*.p12\n*.pfx\nid_rsa\nid_ed25519\ncredentials.json\nservice-account*.json\n*service_account*.json\nauth.json\nwp-config.php\nwp-config-*.php\n!wp-config-sample.php\n/*.sql\n*.sql.gz\n*.dump\n*.sqlite\n*.sqlite3\n*.db\n*.zip\n*.tar\n*.tar.gz\n*.tgz\n*.log\nbackups/\nbackup/\nlogs/\nnode_modules/\nvendor/\ncoverage/\n.cache/\n";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitInitSelection {
    pub(crate) root: String,
    #[serde(default)]
    pub(crate) excluded_paths: Vec<String>,
    pub(crate) fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupFile {
    pub(crate) path: String,
    pub(crate) bytes: u64,
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitInitReview {
    pub(crate) root: String,
    pub(crate) relative_root: String,
    pub(crate) profile: String,
    pub(crate) suggested_roots: Vec<String>,
    pub(crate) existing_repo: Option<String>,
    pub(crate) author: Option<String>,
    pub(crate) included: Vec<SetupFile>,
    pub(crate) excluded: Vec<SetupFile>,
    pub(crate) ignore_content: String,
    pub(crate) blockers: Vec<String>,
    pub(crate) fingerprint: String,
}

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Result<Self, String> {
        let path =
            std::env::temp_dir().join(format!("codex-monitor-git-review-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).map_err(|e| e.to_string())?;
        Ok(Self(path))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err("Choose a folder or file inside this project using a relative path.".into());
    }
    if path.components().any(|part| {
        part.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(".git")
    }) {
        return Err("The .git folder cannot be selected.".into());
    }
    if value.contains(['\n', '\r', '\0']) {
        return Err("Paths containing control characters are unsupported.".into());
    }
    Ok(path.to_path_buf())
}

fn choose_root(entry: &WorkspaceEntry, root: &str) -> Result<(PathBuf, PathBuf, String), String> {
    let workspace =
        fs::canonicalize(&entry.path).map_err(|e| format!("Project folder unavailable: {e}"))?;
    let selected = fs::canonicalize(workspace.join(relative_path(root)?))
        .map_err(|e| format!("Repository folder unavailable: {e}"))?;
    if !selected.is_dir() || !selected.starts_with(&workspace) {
        return Err(
            "Choose a real folder inside this project; links outside it are not allowed.".into(),
        );
    }
    let relative = selected
        .strip_prefix(&workspace)
        .map_err(|e| e.to_string())?;
    let label = if relative.as_os_str().is_empty() {
        ".".into()
    } else {
        relative.to_string_lossy().replace('\\', "/")
    };
    Ok((workspace, selected, label))
}

async fn git(root: &Path, args: &[String], config: Option<&Path>) -> Result<Vec<u8>, String> {
    let binary = resolve_git_binary().map_err(|e| e.to_string())?;
    let mut command = tokio_command(binary);
    command
        .args(args)
        .current_dir(root)
        .env("PATH", git_env_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .kill_on_drop(true);
    if let Some(config) = config {
        command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", config);
    }
    // Avoid inheriting an unrelated repository/index from the launching shell.
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
    ] {
        command.env_remove(key);
    }
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .map_err(|_| "Git setup took too long. Choose a smaller source folder.".to_string())?
        .map_err(|e| format!("Git setup command failed: {e}"))?;
    if !output.status.success() {
        return Err("A Git setup command failed. Check the repository folder and Git identity configuration.".into());
    }
    Ok(output.stdout)
}

fn paths(output: Vec<u8>) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for name in output
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
    {
        let name = String::from_utf8(name.to_vec()).map_err(|_| {
            "A filename is not valid UTF-8; review this project manually.".to_string()
        })?;
        relative_path(&name)?;
        result.push(name);
        if result.len() > MAX_FILES {
            return Err(
                "More than 5,000 entries need review. Choose a smaller source folder.".into(),
            );
        }
    }
    Ok(result)
}

fn ignore_literal(path: &str) -> String {
    let mut escaped = String::from("/");
    for ch in path.chars() {
        if matches!(ch, '\\' | '*' | '?' | '[' | ']' | '#' | '!' | ' ') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

fn protected_name(path: &str) -> bool {
    let name = Path::new(path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let sample_env = [".env.example", ".env.sample", ".env.template"].contains(&name.as_str());
    (name.starts_with(".env") && !sample_env)
        || [
            "wp-config.php",
            "credentials.json",
            "auth.json",
            "id_rsa",
            "id_ed25519",
        ]
        .contains(&name.as_str())
        || [
            ".pem", ".key", ".p12", ".pfx", ".sql.gz", ".sqlite", ".sqlite3", ".dump",
        ]
        .iter()
        .any(|suffix| name.ends_with(suffix))
        || (name.contains("service-account") && name.ends_with(".json"))
}

fn likely_secret(bytes: &[u8]) -> bool {
    let value = String::from_utf8_lossy(bytes);
    if value.contains("PRIVATE KEY-----") {
        return true;
    }
    for prefix in ["AKIA", "ASIA", "ghp_", "gho_", "ghs_", "github_pat_"] {
        for (offset, matched) in value.match_indices(prefix) {
            let tail = &value[offset + matched.len()..];
            let token_length = tail
                .chars()
                .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
                .count();
            if (prefix == "AKIA" || prefix == "ASIA") && token_length >= 16
                || prefix.starts_with("gh") && token_length >= 20
            {
                return true;
            }
        }
    }
    for line in value.lines() {
        let lower = line.to_ascii_lowercase();
        if ![
            "password",
            "secret",
            "api_key",
            "apikey",
            "access_token",
            "client_secret",
        ]
        .iter()
        .any(|key| lower.contains(key))
        {
            continue;
        }
        let Some(split) = line.find(['=', ':']) else {
            continue;
        };
        let lhs = lower[..split].trim().trim_end_matches(['\'', '"']);
        let key = lhs
            .rsplit(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
            .find(|part| !part.is_empty())
            .unwrap_or("");
        if ![
            "password",
            "passwd",
            "db_password",
            "secret",
            "secret_key",
            "api_key",
            "apikey",
            "access_token",
            "client_secret",
        ]
        .contains(&key)
        {
            continue;
        }
        let rhs = line[split + 1..].trim();
        let Some(quote) = rhs.chars().next().filter(|ch| *ch == '\'' || *ch == '"') else {
            continue;
        };
        let literal = rhs[quote.len_utf8()..].split(quote).next().unwrap_or("");
        if literal.len() < 8
            || literal.contains("${")
            || literal.starts_with("your_")
            || literal.starts_with("example_")
            || ["changeme", "password", "REDACTED"].contains(&literal)
        {
            continue;
        }
        return true;
    }
    false
}

fn profile(root: &Path) -> (&'static str, &'static str) {
    if root.join("wp-admin").is_dir()
        || root.join("wp-includes").is_dir()
        || root.join("wp-config.php").exists()
        || root.join("wp-content").is_dir()
    {
        return ("WordPress installation", "");
    }
    let components: Vec<_> = root
        .components()
        .map(|p| p.as_os_str().to_string_lossy())
        .collect();
    if components.windows(2).any(|p| {
        p[0] == "wp-content" && (p[1] == "themes" || p[1] == "plugins" || p[1] == "mu-plugins")
    }) {
        return ("WordPress source", "");
    }
    if root.join("Cargo.toml").exists() {
        return ("Rust", "target/\n");
    }
    if root.join("package.json").exists() {
        return ("Node / web app", "dist/\nbuild/\n.next/\n.nuxt/\n");
    }
    if root.join("pyproject.toml").exists() || root.join("requirements.txt").exists() {
        return (
            "Python",
            ".venv/\nvenv/\n__pycache__/\n*.pyc\n.pytest_cache/\n",
        );
    }
    if root.join("composer.json").exists() {
        return ("PHP", "");
    }
    ("Source project", "")
}

fn suggested_roots(workspace: &Path) -> Vec<String> {
    let mut roots = BTreeSet::from([".".to_string()]);
    for base in [
        "wp-content/themes",
        "wp-content/plugins",
        "wp-content/mu-plugins",
        "public/wp-content/themes",
        "public/wp-content/plugins",
        "app/public/wp-content/themes",
        "app/public/wp-content/plugins",
    ] {
        if let Ok(entries) = fs::read_dir(workspace.join(base)) {
            for entry in entries.flatten().take(100) {
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    roots.insert(format!("{base}/{}", entry.file_name().to_string_lossy()));
                }
            }
        }
    }
    for name in ["src", "app", "packages", "theme", "plugin"] {
        if workspace.join(name).is_dir() {
            roots.insert(name.into());
        }
    }
    roots.into_iter().collect()
}

async fn inspect(
    entry: &WorkspaceEntry,
    root: &str,
    branch: &str,
    excluded: &[String],
    config: Option<&Path>,
) -> Result<(GitInitReview, BTreeMap<String, String>), String> {
    let (_, selected, relative_root) = choose_root(entry, root)?;
    let workspace = fs::canonicalize(&entry.path).map_err(|e| e.to_string())?;
    let branch = super::commands::validate_branch_name(branch)?;
    let (project_profile, rules) = profile(&selected);
    let mut review = GitInitReview {
        root: selected.to_string_lossy().into(),
        relative_root,
        profile: project_profile.into(),
        suggested_roots: suggested_roots(&workspace),
        existing_repo: None,
        author: None,
        included: Vec::new(),
        excluded: Vec::new(),
        ignore_content: String::new(),
        blockers: Vec::new(),
        fingerprint: String::new(),
    };
    if let Ok(existing) = Repository::discover(&selected) {
        let path = existing
            .workdir()
            .unwrap_or_else(|| existing.path())
            .to_string_lossy()
            .into_owned();
        review.blockers.push(format!("Git already exists at {path}. Use that repository instead of initializing another one."));
        review.existing_repo = Some(path);
    }
    if project_profile == "WordPress installation"
        || selected.join("public/wp-content").is_dir()
        || selected.join("app/public/wp-content").is_dir()
    {
        review.blockers.push("Choose the custom theme or plugin folder below. A full WordPress installation includes core, uploads, and third-party code.".into());
    }
    let ignore_path = selected.join(".gitignore");
    if let Ok(meta) = fs::symlink_metadata(&ignore_path) {
        if !meta.is_file() || meta.len() > 65536 {
            return Err("The existing .gitignore must be a regular file under 64 KB.".into());
        }
    }
    let original = if ignore_path.exists() {
        fs::read_to_string(&ignore_path)
            .map_err(|_| "Could not read the existing .gitignore.".to_string())?
    } else {
        String::new()
    };
    if likely_secret(original.as_bytes()) {
        review.blockers.push(
            "The existing .gitignore may contain a credential. Remove it before continuing.".into(),
        );
        return Ok((review, BTreeMap::new()));
    }
    let mut ignore_content = original.clone();
    if !ignore_content.ends_with('\n') && !ignore_content.is_empty() {
        ignore_content.push('\n');
    }
    ignore_content.push_str("\n# Codex Monitor project setup\n");
    ignore_content.push_str(BASE_RULES);
    ignore_content.push_str(rules);
    for path in excluded {
        relative_path(path)?;
        if path == ".gitignore" {
            return Err("Keep .gitignore in the initial commit.".into());
        }
        ignore_content.push_str(&format!("{}\n", ignore_literal(path)));
    }
    review.ignore_content = ignore_content.clone();
    let name = git(&selected, &["config".into(), "user.name".into()], config)
        .await
        .ok()
        .and_then(|v| String::from_utf8(v).ok())
        .unwrap_or_default();
    let email = git(&selected, &["config".into(), "user.email".into()], config)
        .await
        .ok()
        .and_then(|v| String::from_utf8(v).ok())
        .unwrap_or_default();
    if name.trim().is_empty() || email.trim().is_empty() {
        review
            .blockers
            .push("Set your Git user.name and user.email before creating the first commit.".into());
    } else {
        review.author = Some(format!("{} <{}>", name.trim(), email.trim()));
    }
    if !review.blockers.is_empty() {
        return Ok((review, BTreeMap::new()));
    }

    let scratch = Scratch::new()?;
    let git_dir = scratch.0.join("repository");
    Repository::init_bare(&git_dir).map_err(|e| e.to_string())?;
    let ignore_file = scratch.0.join("review.ignore");
    fs::write(&ignore_file, &ignore_content).map_err(|e| e.to_string())?;
    let prefix = vec![
        format!("--git-dir={}", git_dir.display()),
        format!("--work-tree={}", selected.display()),
    ];
    let mut command = prefix.clone();
    command.extend([
        "ls-files".into(),
        "--others".into(),
        "--exclude-standard".into(),
        format!("--exclude-from={}", ignore_file.display()),
        "-z".into(),
    ]);
    let mut candidates = paths(git(&selected, &command, config).await?)?;
    candidates.retain(|path| path != ".gitignore");
    let mut hashes = BTreeMap::new();
    let mut scanned = 0u64;
    let mut omitted = Vec::new();
    for path in candidates {
        let full = selected.join(&path);
        let metadata = fs::symlink_metadata(&full)
            .map_err(|_| "A file changed during review. Refresh the review.".to_string())?;
        let reason = if metadata.is_symlink() {
            Some("Symbolic link; review its target separately.")
        } else if metadata.is_dir() {
            review.blockers.push(format!("Nested repository or unreviewed folder: {path}. Select that folder as the repository root instead."));
            Some("Nested repository / folder.")
        } else if !metadata.is_file() {
            Some("Special file excluded.")
        } else if protected_name(&path) {
            Some("Credential or database filename.")
        } else if metadata.len() > MAX_FILE_BYTES {
            Some("File exceeds the 5 MB initial-review limit.")
        } else {
            None
        };
        if let Some(reason) = reason {
            omitted.push(path.clone());
            review.excluded.push(SetupFile {
                path,
                bytes: metadata.len(),
                reason: Some(reason.into()),
            });
            continue;
        }
        scanned += metadata.len();
        if scanned > MAX_REVIEW_BYTES {
            return Err(
                "More than 64 MB of files need review. Choose a smaller source folder.".into(),
            );
        }
        let bytes = fs::read(&full)
            .map_err(|_| "A file could not be read. Refresh the review.".to_string())?;
        if likely_secret(&bytes) {
            review.blockers.push(format!("Review the possible credential in {path}. Exclude that file or remove the credential before continuing."));
            omitted.push(path.clone());
            review.excluded.push(SetupFile { path, bytes: bytes.len() as u64, reason: Some("Possible embedded credential; excluded. Remove the credential or review this file separately.".into()) });
            continue;
        }
        hashes.insert(
            path.clone(),
            Oid::hash_object(ObjectType::Blob, &bytes)
                .map_err(|e| e.to_string())?
                .to_string(),
        );
        review.included.push(SetupFile {
            path,
            bytes: bytes.len() as u64,
            reason: None,
        });
    }
    for path in omitted {
        ignore_content.push_str(&format!("{}\n", ignore_literal(&path)));
    }
    review.ignore_content = ignore_content.clone();
    hashes.insert(
        ".gitignore".into(),
        Oid::hash_object(ObjectType::Blob, ignore_content.as_bytes())
            .map_err(|e| e.to_string())?
            .to_string(),
    );
    review.included.push(SetupFile {
        path: ".gitignore".into(),
        bytes: ignore_content.len() as u64,
        reason: None,
    });
    let mut ignored_command = prefix;
    ignored_command.extend([
        "ls-files".into(),
        "--others".into(),
        "--ignored".into(),
        "--directory".into(),
        "--exclude-standard".into(),
        format!("--exclude-from={}", ignore_file.display()),
        "-z".into(),
    ]);
    for path in paths(git(&selected, &ignored_command, config).await?)? {
        let reason = if excluded.contains(&path) {
            "Excluded by you."
        } else {
            "Existing or proposed ignore rule."
        };
        review.excluded.push(SetupFile {
            path,
            bytes: 0,
            reason: Some(reason.into()),
        });
    }
    review.included.sort_by(|a, b| a.path.cmp(&b.path));
    review.excluded.sort_by(|a, b| a.path.cmp(&b.path));
    let snapshot = serde_json::to_vec(&(
        entry.id.as_str(),
        &review.root,
        branch,
        &original,
        &review.author,
        &ignore_content,
        &hashes,
    ))
    .map_err(|e| e.to_string())?;
    review.fingerprint = Oid::hash_object(ObjectType::Blob, &snapshot)
        .map_err(|e| e.to_string())?
        .to_string();
    Ok((review, hashes))
}

pub(crate) async fn preview(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
    root: String,
    branch: String,
    excluded_paths: Vec<String>,
) -> Result<Value, String> {
    let entry = workspace_entry_for_id(workspaces, &workspace_id).await?;
    let (review, _) = inspect(&entry, &root, &branch, &excluded_paths, None).await?;
    serde_json::to_value(review).map_err(|e| e.to_string())
}

pub(crate) async fn initialize(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
    branch: String,
    selection: Option<GitInitSelection>,
) -> Result<Value, String> {
    static SETUP_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = SETUP_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    initialize_with_config(workspaces, workspace_id, branch, selection, None).await
}

async fn initialize_with_config(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
    branch: String,
    selection: Option<GitInitSelection>,
    config: Option<&Path>,
) -> Result<Value, String> {
    let selection = selection
        .ok_or_else(|| "Review the Git setup before initializing this project.".to_string())?;
    let entry = workspace_entry_for_id(workspaces, &workspace_id).await?;
    let (review, hashes) = inspect(
        &entry,
        &selection.root,
        &branch,
        &selection.excluded_paths,
        config,
    )
    .await?;
    if !review.blockers.is_empty() {
        return Err(review.blockers.join("\n"));
    }
    if review.fingerprint.is_empty() || review.fingerprint != selection.fingerprint {
        return Err(
            "Files or Git settings changed since the review. Refresh it before initializing."
                .into(),
        );
    }
    let root = PathBuf::from(&review.root);
    // The final fresh review must finish before any project files or Git state are written.
    let mut options = git2::RepositoryInitOptions::new();
    options.no_reinit(true).initial_head(branch.trim());
    Repository::init_opts(&root, &options)
        .map_err(|e| format!("Could not initialize the reviewed folder: {e}"))?;
    fs::write(root.join(".gitignore"), &review.ignore_content)
        .map_err(|e| format!("Git was created but .gitignore could not be saved: {e}"))?;
    let included: Vec<_> = hashes.keys().cloned().collect();
    // Compare Git's filtered objects (including line-ending conversion), not just raw bytes.
    // https://git-scm.com/docs/git-hash-object
    let mut expected_objects = BTreeMap::new();
    for chunk in included.chunks(100) {
        let mut args = vec!["hash-object".to_string(), "--".to_string()];
        args.extend_from_slice(chunk);
        let output = git(&root, &args, config).await?;
        let object_ids: Vec<_> = String::from_utf8(output)
            .map_err(|e| e.to_string())?
            .lines()
            .map(str::to_string)
            .collect();
        if object_ids.len() != chunk.len() {
            return Err("Could not verify the reviewed file contents. No commit was made.".into());
        }
        for (path, id) in chunk.iter().zip(object_ids) {
            expected_objects.insert(path.clone(), id);
        }
    }
    for chunk in included.chunks(100) {
        let mut args = vec!["add".to_string(), "--".to_string()];
        args.extend_from_slice(chunk);
        git(&root, &args, config).await.map_err(|_| {
            "Git was created, but staging failed. Review the Git panel; nothing was pushed."
                .to_string()
        })?;
    }
    for (path, expected) in &hashes {
        let bytes = fs::read(root.join(path)).map_err(|_| {
            "A reviewed file changed while staging. Review the Git panel before committing."
                .to_string()
        })?;
        if Oid::hash_object(ObjectType::Blob, &bytes)
            .map_err(|e| e.to_string())?
            .to_string()
            != *expected
        {
            return Err("A reviewed file changed while staging. No initial commit was made; review the Git panel.".into());
        }
    }
    {
        let repository = Repository::open(&root).map_err(|e| e.to_string())?;
        let index = repository.index().map_err(|e| e.to_string())?;
        if index.len() != expected_objects.len()
            || expected_objects.iter().any(|(path, expected)| {
                index
                    .get_path(Path::new(path), 0)
                    .is_none_or(|entry| entry.id.to_string() != *expected)
            })
        {
            return Err("Staged contents differ from the reviewed files. No initial commit was made; review the Git panel.".into());
        }
    }
    git(&root, &["commit".into(), "--allow-empty".into(), "-m".into(), "Initial commit".into()], config).await
        .map_err(|_| "Git and ignore rules were created, but the initial commit failed. Files remain staged; review the Git panel. Nothing was pushed.".to_string())?;
    let repository = Repository::open(&root).map_err(|e| e.to_string())?;
    let commit = repository
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| e.to_string())?;
    let mut committed = BTreeMap::new();
    commit
        .tree()
        .map_err(|e| e.to_string())?
        .walk(git2::TreeWalkMode::PreOrder, |base, item| {
            if item.kind() == Some(ObjectType::Blob) {
                committed.insert(
                    format!("{base}{}", item.name().unwrap_or("")),
                    item.id().to_string(),
                );
            }
            git2::TreeWalkResult::Ok
        })
        .map_err(|e| e.to_string())?;
    if committed != expected_objects {
        return Err("A Git hook changed the reviewed commit. Inspect it before publishing; nothing was pushed.".into());
    }
    Ok(
        json!({ "status": "initialized", "repoRoot": review.root, "relativeRoot": review.relative_root, "initialCommit": commit.id().to_string() }),
    )
}

#[cfg(test)]
#[path = "setup_tests.rs"]
mod tests;
