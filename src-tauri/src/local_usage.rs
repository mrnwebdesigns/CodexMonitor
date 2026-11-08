use serde_json::json;
use tauri::{AppHandle, State};

use crate::remote_backend;
use crate::shared::local_usage_core;
use crate::shared::project_time_core;
use crate::shared::workspace_rpc::{self, ProjectTimeRequest};
use crate::state::AppState;
use crate::types::LocalUsageSnapshot;
use crate::types::ProjectTimeSnapshot;

#[tauri::command]
pub(crate) async fn project_time_snapshot(
    workspace_id: String,
    days: Option<u32>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ProjectTimeSnapshot, String> {
    if remote_backend::is_remote_mode(&*state).await {
        let request = ProjectTimeRequest { workspace_id, days };
        let response = remote_backend::call_remote(
            &*state, app, "project_time_snapshot",
            workspace_rpc::to_params(&request)?,
        ).await?;
        return serde_json::from_value(response).map_err(|err| err.to_string());
    }
    project_time_core::project_time_snapshot_core(&state.workspaces, workspace_id, days).await
}

#[tauri::command]
pub(crate) async fn local_usage_snapshot(
    days: Option<u32>,
    workspace_path: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<LocalUsageSnapshot, String> {
    if remote_backend::is_remote_mode(&*state).await {
        let response = remote_backend::call_remote(
            &*state,
            app,
            "local_usage_snapshot",
            json!({ "days": days, "workspacePath": workspace_path }),
        )
        .await?;
        return serde_json::from_value(response).map_err(|err| err.to_string());
    }

    local_usage_core::local_usage_snapshot_core(&state.workspaces, days, workspace_path).await
}
