use super::*;
use crate::types::{WorkspaceKind, WorkspaceSettings};
use serde_json::json;
use std::io::Cursor;

fn workspace(id: &str, path: &str) -> WorkspaceEntry {
    WorkspaceEntry {
        id: id.into(),
        name: id.into(),
        path: path.into(),
        kind: WorkspaceKind::Main,
        parent_id: None,
        worktree: None,
        settings: WorkspaceSettings::default(),
    }
}

fn fixture() -> (HashMap<String, WorkspaceEntry>, HashSet<String>) {
    (
        HashMap::from([("project".into(), workspace("project", "/tmp/project"))]),
        HashSet::from(["project".into()]),
    )
}

fn meta() -> Value {
    json!({ "type": "session_meta", "payload": { "id": "thread-1", "cwd": "/tmp/project" } })
}

fn event(time: &str, payload: Value) -> Value {
    json!({ "type": "event_msg", "timestamp": time, "payload": payload })
}

fn parse(values: Vec<Value>) -> ThreadSpans {
    let (workspaces, members) = fixture();
    let text = values
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    parse_thread(Cursor::new(text), &workspaces, &members)
        .unwrap()
        .unwrap()
}

fn total(spans: Vec<Span>) -> (i64, i64) {
    aggregate_spans(spans, 0, i64::MAX)
        .iter()
        .fold((0, 0), |(time, estimate), day| {
            (time + day.agent_time_ms, estimate + day.estimated_time_ms)
        })
}

#[test]
fn recorded_turns_include_long_tool_waits_and_exclude_idle_between_turns() {
    let thread = parse(vec![
        meta(),
        event("2026-11-01T12:00:00Z", json!({"type":"task_started"})),
        event("2026-11-01T12:05:00Z", json!({"type":"task_complete"})),
        event("2026-11-02T12:00:00Z", json!({"type":"task_started"})),
        event("2026-11-02T12:01:00Z", json!({"type":"turn_aborted"})),
    ]);
    assert_eq!(total(thread.spans), (360_000, 0));
}

#[test]
fn completed_duration_without_start_event_overrides_overlapping_legacy_estimate() {
    let thread = parse(vec![
        meta(),
        event("2026-11-01T12:04:00Z", json!({"type":"agent_reasoning"})),
        event("2026-11-01T12:04:30Z", json!({"type":"agent_message"})),
        event(
            "2026-11-01T12:05:00Z",
            json!({"type":"task_complete", "duration_ms":300_000}),
        ),
    ]);
    assert_eq!(total(thread.spans), (300_000, 0));
}

#[test]
fn legacy_activity_excludes_long_gaps_and_user_idle_time() {
    let thread = parse(vec![
        meta(),
        event("2026-11-01T12:00:00Z", json!({"type":"agent_message"})),
        event("2026-11-01T12:00:30Z", json!({"type":"token_count"})),
        event("2026-11-01T12:10:00Z", json!({"type":"agent_message"})),
        event("2026-11-01T12:10:10Z", json!({"type":"user_message"})),
        event("2026-11-01T12:10:30Z", json!({"type":"agent_message"})),
    ]);
    assert_eq!(total(thread.spans), (30_000, 30_000));
}

#[test]
fn unfinished_turns_stop_at_last_logged_agent_activity() {
    let thread = parse(vec![
        meta(),
        event("2026-11-01T12:00:00Z", json!({"type":"task_started"})),
        event("2026-11-01T12:01:00Z", json!({"type":"agent_message"})),
        event("2026-11-02T12:00:00Z", json!({"type":"user_message"})),
    ]);
    assert_eq!(total(thread.spans), (60_000, 60_000));
}

#[test]
fn intervals_split_at_local_midnight_clip_to_range_and_deduplicate() {
    let midnight = Local
        .with_ymd_and_hms(2026, 11, 2, 0, 0, 0)
        .single()
        .unwrap()
        .timestamp_millis();
    let recorded = Span {
        start: midnight - 60_000,
        end: midnight + 60_000,
        estimated: false,
    };
    let days = aggregate_spans(
        vec![
            recorded,
            recorded,
            Span {
                estimated: true,
                ..recorded
            },
        ],
        midnight - 30_000,
        midnight + 60_000,
    );
    assert_eq!(days.len(), 2);
    assert_eq!(days[0].day, "2026-11-01");
    assert_eq!(days[0].agent_time_ms, 30_000);
    assert_eq!(days[1].agent_time_ms, 60_000);
    assert_eq!(days.iter().map(|day| day.estimated_time_ms).sum::<i64>(), 0);
}

#[test]
fn nested_unrelated_workspace_and_path_prefixes_are_excluded() {
    let (mut workspaces, members) = fixture();
    workspaces.insert("other".into(), workspace("other", "/tmp/project/other"));
    for cwd in ["/tmp/project/other/src", "/tmp/project-other"] {
        let text =
            json!({"type":"session_meta","payload":{"id":"other-thread","cwd":cwd}}).to_string();
        assert!(parse_thread(Cursor::new(text), &workspaces, &members)
            .unwrap()
            .is_none());
    }
}

#[test]
fn family_owner_includes_worktrees_and_clones() {
    let (mut workspaces, _) = fixture();
    let mut worktree = workspace("worktree", "/tmp/tree");
    worktree.parent_id = Some("project".into());
    let mut clone = workspace("clone", "/tmp/clone");
    clone.settings.clone_source_workspace_id = Some("worktree".into());
    workspaces.insert(worktree.id.clone(), worktree);
    workspaces.insert(clone.id.clone(), clone);
    assert_eq!(owner_id("clone", &workspaces), "project");
}

#[test]
fn scan_includes_old_resumed_and_archived_compressed_rollouts_without_double_counting() {
    let root = std::env::temp_dir().join(format!("project-time-{}", uuid::Uuid::new_v4()));
    let old = root.join("sessions/2025/01/01");
    let archive = root.join("archived_sessions");
    std::fs::create_dir_all(&old).unwrap();
    std::fs::create_dir_all(&archive).unwrap();
    let now = Local::now();
    let noon = Local
        .from_local_datetime(&now.date_naive().and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .unwrap();
    let start = noon - Duration::hours(1);
    let end = noon - Duration::minutes(59);
    let text = vec![
        meta(),
        event(&start.to_rfc3339(), json!({"type":"task_started"})),
        event(&end.to_rfc3339(), json!({"type":"task_complete"})),
    ]
    .iter()
    .map(Value::to_string)
    .collect::<Vec<_>>()
    .join("\n");
    std::fs::write(old.join("old.jsonl"), &text).unwrap();
    let compressed = zstd::stream::encode_all(Cursor::new(text), 1).unwrap();
    std::fs::write(archive.join("copy.jsonl.zst"), compressed).unwrap();
    let (workspaces, members) = fixture();
    let snapshot =
        scan_project_time(&workspaces, &members, &HashSet::from([root.clone()]), 7).unwrap();
    std::fs::remove_dir_all(root).unwrap();
    assert_eq!(snapshot.threads.len(), 1);
    assert_eq!(
        snapshot.threads[0]
            .days
            .iter()
            .map(|day| day.agent_time_ms)
            .sum::<i64>(),
        60_000
    );
    assert!(snapshot.warnings.is_empty());
}

#[test]
fn compressed_history_is_retained_when_a_partial_plain_sidecar_exists() {
    let root = std::env::temp_dir().join(format!("project-time-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let plain = root.join("rollout.jsonl");
    let compressed = root.join("rollout.jsonl.zst");
    std::fs::write(&plain, meta().to_string()).unwrap();
    let text = vec![
        meta(),
        event("2026-11-01T12:00:00Z", json!({"type":"task_started"})),
        event("2026-11-01T12:01:00Z", json!({"type":"task_complete"})),
    ]
    .iter()
    .map(Value::to_string)
    .collect::<Vec<_>>()
    .join("\n");
    std::fs::write(
        &compressed,
        zstd::stream::encode_all(Cursor::new(text), 1).unwrap(),
    )
    .unwrap();
    let mut files = BTreeMap::new();
    let mut unreadable = 0;
    collect_files(&root, &mut files, &mut unreadable);
    let (workspaces, members) = fixture();
    let spans = files
        .values()
        .flat_map(|path| {
            read_thread(path, &workspaces, &members)
                .unwrap()
                .unwrap()
                .spans
        })
        .collect();
    std::fs::remove_dir_all(root).unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(total(spans), (60_000, 0));
}

#[test]
#[ignore = "Opt-in read-only check: set PROJECT_TIME_SMOKE_HOME and PROJECT_TIME_SMOKE_WORKSPACE"]
fn project_time_local_history_smoke() {
    let home = std::env::var("PROJECT_TIME_SMOKE_HOME").expect("explicit transcript home");
    let path = std::env::var("PROJECT_TIME_SMOKE_WORKSPACE").expect("explicit workspace path");
    let workspaces = HashMap::from([("smoke".into(), workspace("smoke", &path))]);
    let before = std::time::Instant::now();
    let snapshot = scan_project_time(
        &workspaces,
        &HashSet::from(["smoke".into()]),
        &HashSet::from([PathBuf::from(home)]),
        30,
    )
    .unwrap();
    let agent_ms: i64 = snapshot
        .threads
        .iter()
        .flat_map(|thread| &thread.days)
        .map(|day| day.agent_time_ms)
        .sum();
    assert!(
        agent_ms > 0,
        "expected timed activity in the explicitly selected workspace"
    );
    println!(
        "project-time-smoke {}",
        json!({"threads":snapshot.threads.len(),"agentTimeMs":agent_ms,"warnings":snapshot.warnings,"scanMs":before.elapsed().as_millis()})
    );
}
