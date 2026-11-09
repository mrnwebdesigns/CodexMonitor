//! Desktop-only browser UI. Remote pages receive no Tauri capability grants.
//! The sole inbound page message is bounded annotation data, reviewed in the UI.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
#[cfg(not(chromium_browser))]
use tauri::Emitter;
#[cfg(not(chromium_browser))]
use tauri::WebviewUrl;
use tauri::{AppHandle, Manager};

#[cfg(any(chromium_browser, test))]
pub(crate) mod session;

#[cfg(chromium_browser)]
pub(crate) mod chromium;

#[cfg(not(chromium_browser))]
const LABEL: &str = "workspace-browser";
const SCRIPT: &str = include_str!("annotation.js");

#[derive(Default)]
pub struct BrowserState {
    annotation_armed: std::sync::atomic::AtomicBool,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(chromium_browser)]
#[derive(Clone, Copy, Deserialize, PartialEq)]
pub struct BrowserDeviceViewport {
    width: i32,
    height: i32,
    scale: f64,
}

#[cfg(chromium_browser)]
fn valid_device(device: Option<BrowserDeviceViewport>) -> bool {
    device.is_none_or(|device| {
        (200..=2400).contains(&device.width)
            && (200..=2400).contains(&device.height)
            && device.scale.is_finite()
            && device.scale > 0.0
            && device.scale <= 1.0
    })
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSelection {
    url: String,
    title: String,
    selector: String,
    text: String,
    tag: String,
    rect: BrowserBounds,
}

fn parse_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|_| "Enter a valid website address".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || matches!(
            url.host_str(),
            Some("tauri.localhost" | "asset.localhost" | "ipc.localhost")
        )
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only http/https websites without embedded credentials are allowed".into());
    }
    Ok(url)
}

fn valid_bounds(bounds: &BrowserBounds) -> bool {
    [bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .all(|n| n.is_finite())
        && bounds.x >= 0.0
        && bounds.y >= 0.0
        && bounds.width >= 1.0
        && bounds.height >= 1.0
        && bounds.width <= 16000.0
        && bounds.height <= 16000.0
}

fn parse_selection(url: &tauri::Url) -> Option<BrowserSelection> {
    if url.scheme() != "codex-monitor-annotation"
        || url.host_str() != Some("selection")
        || url.as_str().len() > 30000
    {
        return None;
    }
    let payload = url.query_pairs().find(|(key, _)| key == "payload")?.1;
    let selection: BrowserSelection = serde_json::from_str(&payload).ok()?;
    if parse_url(&selection.url).is_err()
        || selection.url.len() > 4096
        || selection.title.len() > 2048
        || selection.selector.len() > 4096
        || selection.text.len() > 6000
        || selection.tag.len() > 64
        || ![
            selection.rect.x,
            selection.rect.y,
            selection.rect.width,
            selection.rect.height,
        ]
        .iter()
        .all(|n| n.is_finite())
    {
        return None;
    }
    Some(selection)
}

fn check_owner(webview: &tauri::Webview) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Browser controls are available only to the app interface".into());
    }
    Ok(())
}

#[cfg(not(chromium_browser))]
fn page_event(
    app: &AppHandle,
    thread_id: &str,
    url: &tauri::Url,
    loading: bool,
    title: Option<String>,
) {
    let _ = app.emit_to(
        "main",
        "browser-page",
        serde_json::json!({"threadId":thread_id,"url":url.as_str(),"loading":loading,"title":title}),
    );
}

#[cfg(not(chromium_browser))]
#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    webview: tauri::Webview,
    url: String,
    thread_id: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    check_owner(&webview)?;
    let url = parse_url(&url)?;
    if !valid_bounds(&bounds) {
        return Err("Invalid browser panel size".into());
    }
    if let Some(browser) = app.get_webview(LABEL) {
        browser.navigate(url).map_err(|e| e.to_string())?;
        browser.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let navigation_app = app.clone();
    let selection_thread_id = thread_id.clone();
    let load_app = app.clone();
    let title_app = app.clone();
    let popup_app = app.clone();
    let load_thread_id = thread_id.clone();
    let title_thread_id = thread_id.clone();
    let builder = tauri::webview::WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .disable_drag_drop_handler()
        .initialization_script(SCRIPT)
        .on_navigation(move |url| {
            if url.scheme() == "codex-monitor-annotation" {
                let state = navigation_app.state::<BrowserState>();
                if state
                    .annotation_armed
                    .swap(false, std::sync::atomic::Ordering::SeqCst)
                {
                    if let Some(selection) = parse_selection(url) {
                        if let Ok(mut payload) = serde_json::to_value(selection) {
                            if let Some(payload) = payload.as_object_mut() {
                                payload.insert(
                                    "threadId".into(),
                                    serde_json::Value::String(selection_thread_id.clone()),
                                );
                            }
                            let _ = navigation_app.emit_to("main", "browser-selection", payload);
                        }
                    }
                }
                return false;
            }
            parse_url(url.as_str()).is_ok()
        })
        .on_page_load(move |browser, payload| {
            let loading = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
            load_app
                .state::<BrowserState>()
                .annotation_armed
                .store(false, std::sync::atomic::Ordering::SeqCst);
            page_event(&load_app, &load_thread_id, payload.url(), loading, None);
            if !loading {
                let _ = browser.eval(SCRIPT);
            }
        })
        .on_document_title_changed(move |browser, title| {
            if let Ok(url) = browser.url() {
                page_event(&title_app, &title_thread_id, &url, false, Some(title));
            }
        })
        .on_new_window(move |url, _| {
            if parse_url(url.as_str()).is_ok() {
                if let Some(browser) = popup_app.get_webview(LABEL) {
                    let _ = browser.navigate(url);
                }
            }
            tauri::webview::NewWindowResponse::Deny
        });
    let window = app.get_window("main").ok_or("Main window is unavailable")?;
    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(bounds.x, bounds.y),
            tauri::LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(chromium_browser))]
#[tauri::command]
pub async fn browser_get_url(
    app: AppHandle,
    webview: tauri::Webview,
    _thread_id: String,
) -> Result<Option<String>, String> {
    check_owner(&webview)?;
    app.get_webview(LABEL)
        .map(|browser| {
            browser
                .url()
                .map(|url| url.to_string())
                .map_err(|e| e.to_string())
        })
        .transpose()
}

#[tauri::command]
pub async fn browser_close(
    app: AppHandle,
    webview: tauri::Webview,
    thread_id: String,
) -> Result<Option<String>, String> {
    check_owner(&webview)?;
    #[cfg(chromium_browser)]
    return chromium::close(&app, thread_id).await;
    #[cfg(not(chromium_browser))]
    {
        let _ = &thread_id;
        app.state::<BrowserState>()
            .annotation_armed
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let Some(browser) = app.get_webview(LABEL) else {
            return Ok(None);
        };
        let url = browser
            .url()
            .ok()
            .and_then(|url| parse_url(url.as_str()).ok());
        browser.close().map_err(|error| error.to_string())?;
        Ok(url.map(|url| url.to_string()))
    }
}

#[cfg(not(chromium_browser))]
#[tauri::command]
pub async fn browser_set_bounds(
    app: AppHandle,
    webview: tauri::Webview,
    bounds: BrowserBounds,
    _thread_id: String,
) -> Result<(), String> {
    check_owner(&webview)?;
    if !valid_bounds(&bounds) {
        return Err("Invalid browser panel size".into());
    }
    if let Some(browser) = app.get_webview(LABEL) {
        browser
            .set_position(tauri::LogicalPosition::new(bounds.x, bounds.y))
            .map_err(|e| e.to_string())?;
        browser
            .set_size(tauri::LogicalSize::new(bounds.width, bounds.height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(not(chromium_browser))]
#[tauri::command]
pub async fn browser_set_visible(
    app: AppHandle,
    webview: tauri::Webview,
    visible: bool,
    _thread_id: String,
) -> Result<(), String> {
    check_owner(&webview)?;
    if !visible {
        app.state::<BrowserState>()
            .annotation_armed
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
    if let Some(browser) = app.get_webview(LABEL) {
        if visible {
            browser.show()
        } else {
            browser.hide()
        }
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(not(chromium_browser))]
#[tauri::command]
pub async fn browser_action(
    app: AppHandle,
    webview: tauri::Webview,
    action: String,
    _thread_id: String,
) -> Result<(), String> {
    check_owner(&webview)?;
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        "stop" => "window.stop()",
        "annotate" => "window.__codexMonitorBrowser?.setActive(true)",
        "browse" => "window.__codexMonitorBrowser?.setActive(false)",
        _ => return Err("Unknown browser action".into()),
    };
    app.state::<BrowserState>()
        .annotation_armed
        .store(action == "annotate", std::sync::atomic::Ordering::SeqCst);
    if let Some(browser) = app.get_webview(LABEL) {
        browser.eval(script).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(chromium_browser)]
async fn capture(app: &AppHandle, thread_id: String) -> Result<Vec<u8>, String> {
    chromium::capture(app, thread_id).await
}

#[cfg(all(target_os = "macos", not(chromium_browser)))]
async fn capture(app: &AppHandle, _thread_id: String) -> Result<Vec<u8>, String> {
    use objc2::{msg_send, runtime::AnyObject};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::NSDictionary;
    let browser = app
        .get_webview(LABEL)
        .ok_or("Open a website before capturing it")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    browser.with_webview(move |view| {
        let sender = std::sync::Mutex::new(Some(tx));
        let completion = block2::RcBlock::new(move |image: *mut NSImage, _error: *mut AnyObject| {
            let result = (|| unsafe {
                let image = image.as_ref().ok_or("Web page snapshot failed")?;
                let tiff = image.TIFFRepresentation().ok_or("Snapshot could not be encoded")?;
                let bitmap = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("Snapshot bitmap is unavailable")?;
                let png = bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()).ok_or("PNG encoding failed")?;
                if png.len() > 30 * 1024 * 1024 { return Err("Screenshot is too large".to_string()); }
                Ok(png.to_vec())
            })().map_err(|e: String| e);
            if let Some(sender) = sender.lock().ok().and_then(|mut value| value.take()) { let _ = sender.send(result); }
        });
        unsafe {
            let native = view.inner().cast::<AnyObject>();
            let _: () = msg_send![native, takeSnapshotWithConfiguration: std::ptr::null::<AnyObject>(), completionHandler: &*completion];
        }
    }).map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(15), rx)
        .await
        .map_err(|_| "Screenshot timed out")?
        .map_err(|_| "Screenshot was cancelled")?
}

#[cfg(not(target_os = "macos"))]
async fn capture(_app: &AppHandle, _thread_id: String) -> Result<Vec<u8>, String> {
    Err("Native screenshots are currently available on macOS".into())
}

#[tauri::command]
pub async fn browser_capture(
    app: AppHandle,
    webview: tauri::Webview,
    thread_id: String,
) -> Result<String, String> {
    check_owner(&webview)?;
    let png = capture(&app, thread_id).await?;
    let directory = capture_directory(&app)?.join("pending");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|e| e.to_string())?;
    let path = directory.join(format!("{}.png", uuid::Uuid::new_v4()));
    tokio::fs::write(&path, png)
        .await
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn capture_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join("browser-captures"))
        .map_err(|error| error.to_string())
}

fn pending_capture_name<'a>(directory: &Path, path: &'a Path) -> Option<&'a str> {
    if path.parent()? != directory {
        return None;
    }
    let name = path.file_name()?.to_str()?;
    let id = uuid::Uuid::parse_str(name.strip_suffix(".png")?).ok()?;
    (name == format!("{id}.png")).then_some(name)
}

#[tauri::command]
pub async fn browser_finish_capture(
    app: AppHandle,
    webview: tauri::Webview,
    path: String,
    keep: bool,
) -> Result<Option<String>, String> {
    check_owner(&webview)?;
    let directory = capture_directory(&app)?;
    let path = PathBuf::from(path);
    let name = pending_capture_name(&directory.join("pending"), &path)
        .ok_or("Invalid pending browser capture")?;
    if keep {
        let destination = directory.join(name);
        tokio::fs::rename(&path, &destination)
            .await
            .map_err(|error| error.to_string())?;
        return Ok(Some(destination.to_string_lossy().into_owned()));
    }
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub async fn reap_pending_captures(app: AppHandle) {
    let Ok(directory) = capture_directory(&app).map(|directory| directory.join("pending")) else {
        return;
    };
    let Ok(mut entries) = tokio::fs::read_dir(&directory).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let is_stale = entry
            .metadata()
            .await
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age.as_secs() >= 24 * 60 * 60);
        if is_stale && pending_capture_name(&directory, &path).is_some() {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRuntimeInfo {
    engine: &'static str,
    version: String,
}

#[tauri::command]
pub async fn browser_runtime_info(webview: tauri::Webview) -> Result<BrowserRuntimeInfo, String> {
    check_owner(&webview)?;
    #[cfg(chromium_browser)]
    return Ok(BrowserRuntimeInfo {
        engine: "Chromium",
        version: chromium::version(),
    });
    #[cfg(not(chromium_browser))]
    Ok(BrowserRuntimeInfo {
        engine: if cfg!(target_os = "macos") {
            "WebKit"
        } else {
            "System WebView"
        },
        version: String::new(),
    })
}

#[cfg(chromium_browser)]
#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    webview: tauri::Webview,
    url: String,
    thread_id: String,
    bounds: BrowserBounds,
    device: Option<BrowserDeviceViewport>,
) -> Result<(), String> {
    check_owner(&webview)?;
    let url = parse_url(&url)?;
    if !valid_bounds(&bounds) {
        return Err("Invalid browser panel size".into());
    }
    if !valid_device(device) {
        return Err("Invalid device viewport".into());
    }
    chromium::navigate(&app, thread_id, url, bounds, device).await
}

#[cfg(chromium_browser)]
#[tauri::command]
pub async fn browser_get_url(
    app: AppHandle,
    webview: tauri::Webview,
    thread_id: String,
) -> Result<Option<String>, String> {
    check_owner(&webview)?;
    chromium::get_url(&app, thread_id).await
}

#[cfg(chromium_browser)]
#[tauri::command]
pub async fn browser_set_bounds(
    app: AppHandle,
    webview: tauri::Webview,
    bounds: BrowserBounds,
    thread_id: String,
    device: Option<BrowserDeviceViewport>,
) -> Result<(), String> {
    check_owner(&webview)?;
    if !valid_bounds(&bounds) {
        return Err("Invalid browser panel size".into());
    }
    if !valid_device(device) {
        return Err("Invalid device viewport".into());
    }
    chromium::set_bounds(&app, thread_id, bounds, device).await
}

#[cfg(chromium_browser)]
#[tauri::command]
pub async fn browser_set_visible(
    app: AppHandle,
    webview: tauri::Webview,
    visible: bool,
    thread_id: String,
) -> Result<(), String> {
    check_owner(&webview)?;
    if !visible {
        app.state::<BrowserState>()
            .annotation_armed
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
    chromium::set_visible(&app, thread_id, visible).await
}

#[cfg(chromium_browser)]
#[tauri::command]
pub async fn browser_action(
    app: AppHandle,
    webview: tauri::Webview,
    action: String,
    thread_id: String,
) -> Result<(), String> {
    check_owner(&webview)?;
    chromium::action(&app, thread_id, action).await
}

#[tauri::command]
pub async fn browser_find(
    app: AppHandle,
    webview: tauri::Webview,
    thread_id: String,
    query: String,
    forward: bool,
    find_next: bool,
) -> Result<(), String> {
    check_owner(&webview)?;
    if query.len() > 1000 {
        return Err("Find text is too long".into());
    }
    #[cfg(chromium_browser)]
    return chromium::find(&app, thread_id, query, forward, find_next).await;
    #[cfg(not(chromium_browser))]
    {
        let _ = (thread_id, find_next);
        let Some(browser) = app.get_webview(LABEL) else {
            return Ok(());
        };
        let query = serde_json::to_string(&query).map_err(|error| error.to_string())?;
        browser
            .eval(format!(
                "window.find({query}, false, {}, true, false, true, false)",
                !forward
            ))
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub async fn browser_stop_find(
    app: AppHandle,
    webview: tauri::Webview,
    thread_id: String,
) -> Result<(), String> {
    check_owner(&webview)?;
    #[cfg(chromium_browser)]
    return chromium::stop_find(&app, thread_id).await;
    #[cfg(not(chromium_browser))]
    {
        let _ = thread_id;
        if let Some(browser) = app.get_webview(LABEL) {
            browser
                .eval("window.getSelection()?.removeAllRanges()")
                .map_err(|error| error.to_string())?;
            browser.set_focus().map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn browser_tool_call(
    app: AppHandle,
    webview: tauri::Webview,
    thread_id: String,
    tool: String,
    arguments: serde_json::Value,
) -> Result<Vec<serde_json::Value>, String> {
    check_owner(&webview)?;
    #[cfg(chromium_browser)]
    return chromium::tool_call(&app, thread_id, tool, arguments).await;
    #[cfg(not(chromium_browser))]
    {
        let _ = (app, thread_id, tool, arguments);
        Err("Agent-controlled internal browser tools require the Chromium build".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_finalization_is_limited_to_app_staged_pngs() {
        let directory = Path::new("/app/browser-captures/pending");
        let name = "f744e8fa-a1e6-42d1-ad7b-1dc58f024470.png";
        assert_eq!(
            pending_capture_name(directory, &directory.join(name)),
            Some(name)
        );
        assert!(pending_capture_name(directory, &directory.parent().unwrap().join(name)).is_none());
        assert!(pending_capture_name(directory, &directory.join("not-a-capture.png")).is_none());
        assert!(pending_capture_name(directory, &directory.join("nested").join(name)).is_none());
    }
    #[test]
    fn website_navigation_rejects_local_protocols_and_embedded_credentials() {
        for url in [
            "file:///etc/passwd",
            "tauri://localhost",
            "http://tauri.localhost",
            "https://asset.localhost",
            "javascript:alert(1)",
            "https://user:pass@example.com",
            "data:text/html,test",
        ] {
            assert!(parse_url(url).is_err());
        }
        assert!(parse_url("http://localhost:3000/").is_ok());
        assert!(parse_url("https://example.com/").is_ok());
    }
    #[test]
    fn rejects_forged_or_oversized_selection_payloads() {
        assert!(parse_selection(
            &tauri::Url::parse("codex-monitor-annotation://selection?payload=bad").unwrap()
        )
        .is_none());
        let payload = serde_json::json!({"url":"file:///etc/passwd","title":"x","selector":"p","text":"x","tag":"p","rect":{"x":0,"y":0,"width":1,"height":1}});
        let mut url = tauri::Url::parse("codex-monitor-annotation://selection").unwrap();
        url.query_pairs_mut()
            .append_pair("payload", &payload.to_string());
        assert!(parse_selection(&url).is_none());
    }
}
