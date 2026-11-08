use chrono::{DateTime, Duration, Local, TimeZone, Utc};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;

use crate::codex::home::{resolve_default_codex_home, resolve_workspace_codex_home};
use crate::types::{ProjectTimeDay, ProjectTimeSnapshot, ProjectTimeThread, WorkspaceEntry};

const MAX_ACTIVITY_GAP_MS: i64 = 120_000;

#[derive(Clone, Copy)]
struct Span {
    start: i64,
    end: i64,
    estimated: bool,
}

struct ThreadSpans {
    id: String,
    workspace_id: String,
    title: Option<String>,
    spans: Vec<Span>,
}

fn owner_id<'a>(id: &'a str, workspaces: &'a HashMap<String, WorkspaceEntry>) -> &'a str {
    let mut current = id;
    let mut seen = HashSet::new();
    while seen.insert(current) {
        let Some(entry) = workspaces.get(current) else {
            break;
        };
        let Some(parent) = entry
            .parent_id
            .as_deref()
            .or(entry.settings.clone_source_workspace_id.as_deref())
        else {
            break;
        };
        if !workspaces.contains_key(parent) {
            break;
        }
        current = parent;
    }
    current
}

pub(crate) async fn project_time_snapshot_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
    days: Option<u32>,
) -> Result<ProjectTimeSnapshot, String> {
    let workspaces = workspaces.lock().await.clone();
    if !workspaces.contains_key(&workspace_id) {
        return Err("Workspace not found".into());
    }
    let project_id = owner_id(&workspace_id, &workspaces);
    let members: HashSet<String> = workspaces
        .keys()
        .filter(|id| owner_id(id, &workspaces) == project_id)
        .cloned()
        .collect();
    let mut homes = HashSet::new();
    for id in &members {
        let entry = &workspaces[id];
        let parent = entry.parent_id.as_ref().and_then(|id| workspaces.get(id));
        if let Some(home) =
            resolve_workspace_codex_home(entry, parent).or_else(resolve_default_codex_home)
        {
            homes.insert(home);
        }
    }
    tokio::task::spawn_blocking(move || {
        scan_project_time(
            &workspaces,
            &members,
            &homes,
            days.unwrap_or(30).clamp(1, 90),
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

fn scan_project_time(
    workspaces: &HashMap<String, WorkspaceEntry>,
    members: &HashSet<String>,
    homes: &HashSet<PathBuf>,
    days: u32,
) -> Result<ProjectTimeSnapshot, String> {
    let now = Local::now();
    let today = now.date_naive();
    let first_day = today - Duration::days(i64::from(days) - 1);
    let start = Local
        .from_local_datetime(&first_day.and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .ok_or("Invalid report start date")?
        .timestamp_millis();
    let end = now.timestamp_millis();
    let mut files = BTreeMap::new();
    let mut unreadable = 0;
    for home in homes {
        // Rollouts are filed by creation date, so older directories must also be scanned.
        for directory in ["sessions", "archived_sessions"] {
            collect_files(&home.join(directory), &mut files, &mut unreadable);
        }
    }
    let mut threads: BTreeMap<(String, String), ThreadSpans> = BTreeMap::new();
    for path in files.values() {
        match read_thread(path, workspaces, members) {
            Ok(Some(thread)) => {
                let key = (thread.workspace_id.clone(), thread.id.clone());
                if let Some(existing) = threads.get_mut(&key) {
                    existing.spans.extend(thread.spans);
                    if thread.title.is_some() {
                        existing.title = thread.title;
                    }
                } else {
                    threads.insert(key, thread);
                }
            }
            Ok(None) => {}
            Err(_) => unreadable += 1,
        }
    }
    let threads = threads
        .into_values()
        .filter_map(|thread| {
            let days = aggregate_spans(thread.spans, start, end);
            if days.is_empty() {
                return None;
            }
            Some(ProjectTimeThread {
                thread_id: thread.id,
                workspace_id: thread.workspace_id,
                title: thread.title,
                days,
            })
        })
        .collect();
    Ok(ProjectTimeSnapshot {
        updated_at: end,
        range_start: first_day.to_string(),
        range_end: today.to_string(),
        time_zone: now.offset().to_string(),
        threads,
        warnings: if unreadable > 0 {
            vec![format!("{unreadable} transcript files or directories could not be read. Totals may be incomplete.")]
        } else {
            Vec::new()
        },
    })
}

fn collect_files(directory: &Path, files: &mut BTreeMap<PathBuf, PathBuf>, unreadable: &mut usize) {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => {
            *unreadable += 1;
            return;
        }
    };
    for entry in entries {
        let Ok(entry) = entry else {
            *unreadable += 1;
            continue;
        };
        let Ok(kind) = entry.file_type() else {
            *unreadable += 1;
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            collect_files(&path, files, unreadable);
        } else if kind.is_file() {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            if name.ends_with(".jsonl") || name.ends_with(".jsonl.zst") {
                files.insert(path.clone(), path);
            }
        }
    }
}

fn timestamp(value: &Value) -> Option<i64> {
    if let Some(text) = value.as_str() {
        return DateTime::parse_from_rfc3339(text)
            .ok()
            .map(|date| date.timestamp_millis());
    }
    let number = value.as_i64()?;
    Some(if number > 0 && number < 1_000_000_000_000 {
        number * 1000
    } else {
        number
    })
}

fn read_thread(
    path: &Path,
    workspaces: &HashMap<String, WorkspaceEntry>,
    members: &HashSet<String>,
) -> Result<Option<ThreadSpans>, std::io::Error> {
    let file = File::open(path)?;
    let reader: Box<dyn BufRead> = if path.extension().is_some_and(|ext| ext == "zst") {
        Box::new(BufReader::new(zstd::stream::read::Decoder::new(file)?))
    } else {
        Box::new(BufReader::new(file))
    };
    parse_thread(reader, workspaces, members)
}

fn workspace_for_cwd<'a>(
    cwd: &str,
    workspaces: &'a HashMap<String, WorkspaceEntry>,
) -> Option<&'a WorkspaceEntry> {
    workspaces
        .values()
        .filter(|entry| Path::new(cwd).starts_with(&entry.path))
        .max_by_key(|entry| entry.path.len())
}

fn parse_thread(
    reader: impl BufRead,
    workspaces: &HashMap<String, WorkspaceEntry>,
    members: &HashSet<String>,
) -> Result<Option<ThreadSpans>, std::io::Error> {
    let mut thread: Option<ThreadSpans> = None;
    let mut active: Option<(i64, i64)> = None;
    let mut previous_activity = None;
    let mut cwd_matches = true;
    for line in reader.lines() {
        let line = line?;
        if line.len() > 512_000 {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let kind = value["type"].as_str().unwrap_or("");
        let payload = &value["payload"];
        if kind == "session_meta" {
            let Some(cwd) = payload["cwd"].as_str() else {
                return Ok(None);
            };
            let Some(workspace) = workspace_for_cwd(cwd, workspaces) else {
                return Ok(None);
            };
            if !members.contains(&workspace.id) {
                return Ok(None);
            }
            let Some(id) = payload["id"].as_str().or(payload["session_id"].as_str()) else {
                return Ok(None);
            };
            thread = Some(ThreadSpans {
                id: id.to_owned(),
                workspace_id: workspace.id.clone(),
                spans: Vec::new(),
                title: payload["title"]
                    .as_str()
                    .or(payload["name"].as_str())
                    .map(|s| s.chars().take(160).collect()),
            });
            continue;
        }
        let Some(thread) = thread.as_mut() else {
            continue;
        };
        if kind == "turn_context" {
            if let Some(cwd) = payload["cwd"].as_str() {
                cwd_matches = workspace_for_cwd(cwd, workspaces)
                    .is_some_and(|entry| entry.id == thread.workspace_id);
                if !cwd_matches {
                    active = None;
                    previous_activity = None;
                }
            }
            continue;
        }
        if !cwd_matches {
            continue;
        }
        let Some(time) = value.get("timestamp").and_then(timestamp) else {
            continue;
        };
        let event = payload["type"].as_str().unwrap_or("");
        if kind == "event_msg" && event == "task_started" {
            if let Some((start, end)) = active.take() {
                thread.spans.push(Span {
                    start,
                    end,
                    estimated: true,
                });
            }
            let start = payload
                .get("started_at")
                .and_then(timestamp)
                .unwrap_or(time);
            active = Some((start, start));
            previous_activity = None;
        } else if kind == "event_msg" && matches!(event, "task_complete" | "turn_aborted") {
            let end = payload
                .get("completed_at")
                .and_then(timestamp)
                .unwrap_or(time);
            let start = payload
                .get("started_at")
                .and_then(timestamp)
                .or_else(|| {
                    payload["duration_ms"]
                        .as_i64()
                        .filter(|duration| *duration >= 0)
                        .map(|duration| end.saturating_sub(duration))
                })
                .or_else(|| active.map(|(start, _)| start));
            if let Some(start) = start {
                thread.spans.push(Span {
                    start,
                    end,
                    estimated: false,
                });
            }
            active = None;
            previous_activity = None;
        } else if (kind == "event_msg" && event == "user_message")
            || (kind == "response_item"
                && payload["type"] == "message"
                && payload["role"] == "user")
        {
            if thread.title.is_none() {
                if let Some(message) = payload["message"].as_str() {
                    let message = message.trim();
                    if !message.starts_with('<')
                        && !message.starts_with("# AGENTS.md")
                        && !message.is_empty()
                    {
                        thread.title = Some(
                            message
                                .split_whitespace()
                                .collect::<Vec<_>>()
                                .join(" ")
                                .chars()
                                .take(160)
                                .collect(),
                        );
                    }
                }
            }
            previous_activity = None;
        } else if (kind == "event_msg"
            && matches!(event, "agent_message" | "agent_reasoning" | "token_count"))
            || (kind == "response_item"
                && (payload["role"] == "assistant" || payload["type"] != "message"))
        {
            if let Some((_, last)) = active.as_mut() {
                *last = (*last).max(time);
            } else {
                if let Some(start) = previous_activity {
                    if time > start && time - start <= MAX_ACTIVITY_GAP_MS {
                        thread.spans.push(Span {
                            start,
                            end: time,
                            estimated: true,
                        });
                    }
                }
                previous_activity = Some(time);
            }
        }
    }
    if let (Some(thread), Some((start, end))) = (thread.as_mut(), active) {
        thread.spans.push(Span {
            start,
            end,
            estimated: true,
        });
    }
    Ok(thread)
}

fn aggregate_spans(spans: Vec<Span>, range_start: i64, range_end: i64) -> Vec<ProjectTimeDay> {
    // Union duplicate/overlapping spans within a thread. Recorded timing takes precedence
    // over legacy estimates, including copied and compressed versions of the same rollout.
    let mut events: BTreeMap<i64, (i32, i32)> = BTreeMap::new();
    for span in spans {
        let start = span.start.max(range_start);
        let end = span.end.min(range_end);
        if end <= start {
            continue;
        }
        let delta = if span.estimated { (0, 1) } else { (1, 0) };
        let entry = events.entry(start).or_default();
        entry.0 += delta.0;
        entry.1 += delta.1;
        let entry = events.entry(end).or_default();
        entry.0 -= delta.0;
        entry.1 -= delta.1;
    }
    let mut daily: BTreeMap<String, ProjectTimeDay> = BTreeMap::new();
    let (mut recorded, mut estimated) = (0, 0);
    let mut previous = range_start;
    for (end, delta) in events {
        if recorded > 0 || estimated > 0 {
            let mut cursor = previous;
            while cursor < end {
                let Some(local) = Utc
                    .timestamp_millis_opt(cursor)
                    .single()
                    .map(|time| time.with_timezone(&Local))
                else {
                    break;
                };
                let day = local.date_naive();
                let Some(next_date) = day.succ_opt() else {
                    break;
                };
                let Some(midnight) = Local
                    .from_local_datetime(&next_date.and_hms_opt(0, 0, 0).unwrap())
                    .earliest()
                else {
                    break;
                };
                let boundary = end.min(midnight.timestamp_millis());
                if boundary <= cursor {
                    break;
                }
                let key = day.to_string();
                let total = daily.entry(key.clone()).or_insert_with(|| ProjectTimeDay {
                    day: key,
                    ..Default::default()
                });
                total.agent_time_ms += boundary - cursor;
                if recorded == 0 {
                    total.estimated_time_ms += boundary - cursor;
                }
                cursor = boundary;
            }
        }
        recorded += delta.0;
        estimated += delta.1;
        previous = end;
    }
    daily.into_values().collect()
}

#[cfg(test)]
#[path = "project_time_core_tests.rs"]
mod tests;
