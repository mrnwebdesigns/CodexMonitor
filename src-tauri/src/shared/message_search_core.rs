//! Rebuildable, profile-local message search shared by the desktop and daemon.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::codex::home::{resolve_default_codex_home, resolve_workspace_codex_home};
use crate::types::WorkspaceEntry;

const HELPER: &str = include_str!("../../../scripts/message_search.py");
static WORKERS: Mutex<Option<HashSet<PathBuf>>> = Mutex::const_new(None);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchRequest {
    pub(crate) query: String,
    pub(crate) workspace_ids: Vec<String>,
    #[serde(default)]
    pub(crate) include_tools: bool,
}

fn python(home: &Path) -> Result<PathBuf, String> {
    let config = home.join("monitor-history-sync.json");
    match std::fs::read_to_string(config) {
        Ok(text) => {
            let value: Value = serde_json::from_str(&text)
                .map_err(|_| "Invalid local history runtime configuration")?;
            let path = value["pythonBin"]
                .as_str()
                .ok_or("The local history Python runtime is not configured")?;
            if !Path::new(path).is_absolute() {
                return Err("The local history Python path must be absolute".into());
            }
            Ok(PathBuf::from(path))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("python3".into()),
        Err(_) => Err("Cannot read the local history runtime configuration".into()),
    }
}

pub(crate) async fn ensure_worker(home: PathBuf) -> Result<(), String> {
    let runtime = python(&home)?;
    let mut workers = WORKERS.lock().await;
    if !workers
        .get_or_insert_with(HashSet::new)
        .insert(home.clone())
    {
        return Ok(());
    }
    tokio::spawn(async move {
        loop {
            let mut command = crate::shared::process_core::tokio_command(&runtime);
            command
                .args(["-I", "-c", HELPER, "--home"])
                .arg(&home)
                .args(["--worker", "--parent-pid", &std::process::id().to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            // A second app/daemon process may already own this profile's worker.
            // The helper uses a profile lock and exits without starting another scan.
            let _ = command.status().await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
    Ok(())
}

pub(crate) async fn start_default_worker() {
    if let Some(home) = resolve_default_codex_home() {
        let _ = ensure_worker(home).await;
    }
}

async fn run(home: &Path, request: Value) -> Result<Value, String> {
    ensure_worker(home.to_path_buf()).await?;
    let runtime = python(home)?;
    let mut command = crate::shared::process_core::tokio_command(runtime);
    command
        .args(["-I", "-c", HELPER, "--home"])
        .arg(home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| "Cannot start the local search Python runtime")?;
    let data = serde_json::to_vec(&request).map_err(|_| "Invalid search request")?;
    let mut input = child
        .stdin
        .take()
        .ok_or("Cannot open the search request channel")?;
    input
        .write_all(&data)
        .await
        .map_err(|_| "Cannot send the search request")?;
    drop(input);
    let output = tokio::time::timeout(Duration::from_secs(120), child.wait_with_output())
        .await
        .map_err(|_| "Local search maintenance timed out")?
        .map_err(|_| "Local search helper stopped")?;
    if !output.status.success() {
        return Err("Local message search is unavailable. Check the Python runtime, disk space, and index status.".into());
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "Invalid local search response".into())
}

pub(crate) async fn status_core() -> Result<Value, String> {
    let home = resolve_default_codex_home().ok_or("Cannot resolve the local Codex profile")?;
    run(&home, json!({"operation":"status"})).await
}

pub(crate) async fn control_core(action: String) -> Result<Value, String> {
    if !matches!(
        action.as_str(),
        "pause" | "resume" | "clear" | "rebuild" | "compact" | "enableTools" | "disableTools"
    ) {
        return Err("Unknown search index action".into());
    }
    let home = resolve_default_codex_home().ok_or("Cannot resolve the local Codex profile")?;
    run(&home, json!({"operation":"control","action":action})).await
}

pub(crate) async fn search_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    request: SearchRequest,
) -> Result<Value, String> {
    if request.query.trim().chars().count() < 3 || request.workspace_ids.is_empty() {
        return Ok(json!({"results":[],"elapsedMs":0,"status":null}));
    }
    if request.query.chars().count() > 256 {
        return Err("Search is limited to 256 characters".into());
    }
    let workspaces = workspaces.lock().await.clone();
    let requested: HashSet<_> = request.workspace_ids.iter().cloned().collect();
    let mut homes: HashMap<PathBuf, Vec<Value>> = HashMap::new();
    for id in request.workspace_ids {
        let entry = workspaces.get(&id).ok_or("Search workspace not found")?;
        let parent = entry.parent_id.as_ref().and_then(|id| workspaces.get(id));
        let home = resolve_workspace_codex_home(entry, parent)
            .or_else(resolve_default_codex_home)
            .ok_or("Cannot resolve the workspace Codex profile")?;
        homes.entry(home).or_default();
    }
    // Resolve ownership against every configured root, including hidden projects.
    // A hidden nested project must never appear under its visible parent.
    for entry in workspaces.values() {
        let parent = entry.parent_id.as_ref().and_then(|id| workspaces.get(id));
        let owner_home =
            resolve_workspace_codex_home(entry, parent).or_else(resolve_default_codex_home);
        for (home, roots) in &mut homes {
            roots.push(json!({"id":entry.id,"path":entry.path,
                "allowed":requested.contains(&entry.id) && owner_home.as_ref() == Some(home)}));
        }
    }
    let mut results = Vec::new();
    let mut elapsed = 0.0;
    let mut status = Value::Null;
    for (home, roots) in homes {
        let response = run(
            &home,
            json!({"operation":"search","query":request.query,
            "roots":roots,"includeTools":request.include_tools}),
        )
        .await?;
        if let Some(rows) = response["results"].as_array() {
            results.extend(rows.iter().cloned());
        }
        elapsed += response["elapsedMs"].as_f64().unwrap_or_default();
        status = response["status"].clone();
    }
    results.truncate(50);
    Ok(json!({"results":results,"elapsedMs":elapsed,"status":status}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_search_never_reads_another_profile() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let workspaces = Mutex::new(HashMap::new());
                let result = search_core(
                    &workspaces,
                    SearchRequest {
                        query: "achelios.com".into(),
                        workspace_ids: vec![],
                        include_tools: false,
                    },
                )
                .await
                .unwrap();
                assert_eq!(result["results"], json!([]));
            });
    }

    #[test]
    fn unknown_workspace_is_rejected_before_starting_a_worker() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let workspaces = Mutex::new(HashMap::new());
                assert!(search_core(
                    &workspaces,
                    SearchRequest {
                        query: "achelios.com".into(),
                        workspace_ids: vec!["missing".into()],
                        include_tools: false,
                    }
                )
                .await
                .unwrap_err()
                .contains("not found"));
            });
    }
}
