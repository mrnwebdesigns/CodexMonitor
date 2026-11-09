//! Opt-in, one-way local history imports shared by the desktop and daemon.
//! The embedded stdlib-only Python helper owns SQLite transactions and locking.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{Mutex, MutexGuard};

use crate::backend::events::{AppServerEvent, EventSink};
use crate::codex::home::resolve_default_codex_home;
use crate::types::WorkspaceEntry;

const HELPER: &str = include_str!("../../../scripts/codex_history_sync.py");
pub(crate) const INTERVAL: Duration = Duration::from_secs(30);
static IMPORT_LOCK: Mutex<()> = Mutex::const_new(());
static LAST_RUN: StdMutex<Option<(PathBuf, Instant)>> = StdMutex::new(None);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    enabled: bool,
    source_profile: PathBuf,
    python_bin: PathBuf,
}

fn config(home: &Path) -> Result<Option<Config>, String> {
    let path = home.join("monitor-history-sync.json");
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read automatic history import configuration".into()),
    };
    let config: Config = serde_json::from_str(&text)
        .map_err(|_| "Invalid automatic history import configuration")?;
    if !config.enabled {
        return Ok(None);
    }
    if !config.python_bin.is_absolute() || !config.source_profile.is_absolute() {
        return Err("History import paths must be absolute".into());
    }
    Ok(Some(config))
}

async fn helper(home: &Path, config: &Config, extra: &[String]) -> Result<Value, String> {
    let mut command = crate::shared::process_core::tokio_command(&config.python_bin);
    command
        .args(["-I", "-c", HELPER, "--target"])
        .arg(home)
        .args(extra)
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(600), command.output())
        .await
        .map_err(|_| "Automatic history import timed out")?
        .map_err(|_| "Cannot start the configured history import Python runtime")?;
    if !output.status.success() {
        let detail = serde_json::from_slice::<Value>(&output.stderr)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "History import helper failed".into());
        return Err(detail);
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "Invalid history import report".into())
}

/// Serialize app requests with the importer. Opening a chat leases it to this
/// runtime; writing to it permanently opts that local copy out of future imports.
pub(crate) async fn prepare_request(
    home: Option<&Path>,
    runtime_pid: u32,
    method: &str,
    params: &Value,
) -> Result<Option<MutexGuard<'static, ()>>, String> {
    let lease = matches!(method, "thread/resume" | "thread/fork");
    let claim = matches!(
        method,
        "turn/start"
            | "turn/steer"
            | "thread/name/set"
            | "thread/archive"
            | "thread/unarchive"
            | "thread/delete"
            | "thread/compact/start"
            | "thread/revert"
            | "thread/rollback"
            | "thread/inject_items"
            | "review/start"
    );
    let read = matches!(
        method,
        "thread/list" | "thread/read" | "thread/turns/list" | "thread/items/list"
    );
    if !lease && !claim && !read {
        return Ok(None);
    }
    let Some(home) = home else { return Ok(None) };
    let Some(config) = config(home)? else {
        return Ok(None);
    };
    let guard = IMPORT_LOCK.lock().await;
    if read {
        return Ok(Some(guard));
    }
    let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
        return Ok(None);
    };
    let mut args = vec![
        if claim { "--claim" } else { "--lease" }.into(),
        thread_id.into(),
    ];
    if lease {
        args.extend(["--owner-pid".into(), runtime_pid.to_string()]);
    }
    helper(home, &config, &args)
        .await
        .map_err(|error| format!("Cannot protect the local chat from history imports: {error}"))?;
    Ok(Some(guard))
}

pub(crate) async fn sync_once(home: Option<&Path>) -> Result<Option<Value>, String> {
    let home = home
        .map(Path::to_path_buf)
        .or_else(resolve_default_codex_home);
    let Some(home) = home else { return Ok(None) };
    let Some(config) = config(&home)? else {
        return Ok(None);
    };
    let _guard = IMPORT_LOCK.lock().await;
    if LAST_RUN
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|(last_home, last)| last_home == &home && last.elapsed() < INTERVAL)
    {
        return Ok(None);
    }
    let report = helper(
        &home,
        &config,
        &[
            "--source".into(),
            config.source_profile.to_string_lossy().into_owned(),
            "--apply".into(),
        ],
    )
    .await?;
    *LAST_RUN.lock().unwrap() = Some((home, Instant::now()));
    Ok(Some(report))
}

pub(crate) fn emit_changes<E: EventSink>(
    report: &Value,
    workspaces: &HashMap<String, WorkspaceEntry>,
    sink: &E,
) {
    let Some(changes) = report.get("changed").and_then(Value::as_array) else {
        return;
    };
    let mut affected: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut activities: HashMap<&str, Vec<Value>> = HashMap::new();
    let roots: Vec<_> = workspaces
        .values()
        .map(|entry| {
            (
                entry,
                std::fs::canonicalize(&entry.path).unwrap_or_else(|_| PathBuf::from(&entry.path)),
            )
        })
        .collect();
    let snapshots = report.get("activitySnapshots").and_then(Value::as_array);
    for (change, snapshot) in changes
        .iter()
        .map(|change| (change, false))
        .chain(snapshots.into_iter().flatten().map(|change| (change, true)))
    {
        let Some(id) = change.get("id").and_then(Value::as_str) else {
            continue;
        };
        for key in ["cwd", "previousCwd"] {
            let Some(cwd) = change.get(key).and_then(Value::as_str) else {
                continue;
            };
            let path = Path::new(cwd);
            if let Some((workspace, _)) = roots
                .iter()
                .filter(|(_, root)| path.starts_with(root))
                .max_by_key(|(_, root)| root.as_os_str().len())
            {
                let ids = affected.entry(&workspace.id).or_default();
                if !snapshot && !ids.contains(&id) {
                    ids.push(id);
                }
                if key == "cwd" {
                    if let Some(activity) = imported_activity(change) {
                        let entries = activities.entry(&workspace.id).or_default();
                        if !entries.contains(&activity) {
                            entries.push(activity);
                        }
                    }
                }
            }
        }
    }
    for (workspace_id, thread_ids) in affected {
        sink.emit_app_server_event(AppServerEvent {
            workspace_id: workspace_id.into(),
            message: json!({"method":"codex/historySynced","params":{
                "threadIds":thread_ids,
                "activities":activities.remove(workspace_id).unwrap_or_default()
            }}),
        });
    }
}

fn imported_activity(change: &Value) -> Option<Value> {
    let thread_id = change.get("id")?.as_str()?;
    let activity = change.get("activity")?;
    let turn_id = activity.get("turnId")?.as_str()?;
    let status = activity.get("status")?.as_str()?;
    if thread_id.is_empty()
        || turn_id.is_empty()
        || !matches!(
            status,
            "inProgress" | "completed" | "interrupted" | "failed"
        )
    {
        return None;
    }
    Some(json!({"threadId":thread_id,"turnId":turn_id,"status":status}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::events::{TerminalExit, TerminalOutput};
    use std::sync::Arc;

    #[derive(Clone, Default)]
    struct Capture(Arc<StdMutex<Vec<AppServerEvent>>>);
    impl EventSink for Capture {
        fn emit_app_server_event(&self, event: AppServerEvent) {
            self.0.lock().unwrap().push(event);
        }
        fn emit_terminal_output(&self, _: TerminalOutput) {}
        fn emit_terminal_exit(&self, _: TerminalExit) {}
    }

    #[test]
    fn absent_configuration_does_not_enable_imports() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        assert!(config(&root).unwrap().is_none());
    }

    #[test]
    fn imported_activity_forwards_only_recognized_turn_metadata() {
        let activity = imported_activity(&json!({"id":"thread","activity":{
            "turnId":"turn", "status":"completed", "message":"private result"
        }}))
        .unwrap();
        assert_eq!(
            activity,
            json!({"threadId":"thread","turnId":"turn","status":"completed"})
        );
        assert!(imported_activity(
            &json!({"id":"thread","activity":{"turnId":"turn","status":"unknown"}})
        )
        .is_none());
        assert!(imported_activity(&json!({"id":"thread"})).is_none());
    }

    #[test]
    fn activity_snapshots_reach_the_specific_workspace_without_refreshing_thread_lists() {
        let workspaces = ["/test/project", "/test/project/tree"]
            .into_iter()
            .enumerate()
            .map(|(index, path)| {
                let id = index.to_string();
                let workspace =
                    serde_json::from_value(json!({"id":id,"name":id,"path":path})).unwrap();
                (id, workspace)
            })
            .collect();
        let snapshot = json!({"id":"thread","cwd":"/test/project/tree","activity":{
            "turnId":"turn","status":"completed"
        }});
        let sink = Capture::default();
        emit_changes(
            &json!({"changed":[],"activitySnapshots":[snapshot]}),
            &workspaces,
            &sink,
        );
        let events = sink.0.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].workspace_id, "1");
        assert_eq!(events[0].message["params"]["threadIds"], json!([]));
        assert_eq!(
            events[0].message["params"]["activities"][0]["threadId"],
            "thread"
        );
    }
}
