//! App-only directory paths for macOS HTML file drops. WebKit receives image
//! bytes and screenshot promises; only the sidebar needs absolute directory paths.
use std::path::PathBuf;
use tauri::{AppHandle, Webview};

fn matching_directories(paths: Vec<PathBuf>, names: &[String]) -> Vec<String> {
    if names.is_empty()
        || names.len() > 128
        || names.iter().any(|name| {
            name.is_empty()
                || matches!(name.as_str(), "." | "..")
                || name.contains(['/', '\\', '\0'])
        })
    {
        return Vec::new();
    }
    let mut matched = Vec::new();
    for path in paths {
        if path.is_dir()
            && path
                .file_name()
                .is_some_and(|name| names.iter().any(|expected| name == expected.as_str()))
        {
            let path = path.to_string_lossy().into_owned();
            if !matched.contains(&path) {
                matched.push(path);
            }
        }
    }
    matched
}

#[tauri::command]
pub async fn resolve_dropped_directories(
    app: AppHandle,
    webview: Webview,
    names: Vec<String>,
) -> Result<Vec<String>, String> {
    if webview.label() != "main" {
        return Err("Directory drops are available only to the app interface".into());
    }
    if names.is_empty() {
        return Ok(Vec::new());
    }
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            use objc2::ClassType;
            use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag};
            use objc2_foundation::{NSArray, NSURL};
            let board = unsafe { NSPasteboard::pasteboardWithName(NSPasteboardNameDrag) };
            let classes = NSArray::from_slice(&[NSURL::class()]);
            let objects = unsafe { board.readObjectsForClasses_options(&classes, None) };
            let paths = objects
                .into_iter()
                .flat_map(|items| items.to_vec())
                .filter_map(|item| item.downcast::<NSURL>().ok())
                .filter(|url| url.isFileURL())
                .filter_map(|url| url.path())
                .map(|path| PathBuf::from(path.to_string()))
                .collect();
            let _ = sender.send(matching_directories(paths, &names));
        })
        .map_err(|_| "Directory drop is unavailable")?;
        receiver
            .await
            .map_err(|_| "Directory drop was cancelled".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, names);
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_only_directories_matching_this_drop_and_deduplicates_paths() {
        let root = std::env::temp_dir().join(format!("directory-drop-{}", uuid::Uuid::new_v4()));
        let selected = root.join("selected");
        let other = root.join("other");
        let file = root.join("image.png");
        std::fs::create_dir_all(&selected).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(&file, b"fixture").unwrap();
        let paths = vec![selected.clone(), other, file, selected.clone()];
        assert_eq!(
            matching_directories(paths.clone(), &["selected".into(), "image.png".into()]),
            vec![selected.to_string_lossy()]
        );
        assert!(matching_directories(paths.clone(), &[]).is_empty());
        assert!(matching_directories(paths, &["../selected".into()]).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
