use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::remote_backend;
use crate::shared::message_search_core::{self, SearchRequest};
use crate::state::AppState;

#[tauri::command]
pub(crate) async fn search_messages(
    query: String,
    workspace_ids: Vec<String>,
    include_tools: bool,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "search_messages",
            json!({"query":query,"workspaceIds":workspace_ids,"includeTools":include_tools}),
        )
        .await;
    }
    message_search_core::search_core(
        &state.workspaces,
        SearchRequest {
            query,
            workspace_ids,
            include_tools,
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn message_search_status(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(&*state, app, "message_search_status", json!({})).await;
    }
    message_search_core::status_core().await
}

#[tauri::command]
pub(crate) async fn message_search_control(
    action: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "message_search_control",
            json!({"action":action}),
        )
        .await;
    }
    message_search_core::control_core(action).await
}
