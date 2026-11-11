//! macOS website pane backed by CEF. The privileged app shell stays in WKWebView.
//! All CEF objects and Cocoa views are confined to the application main thread.
use super::{
    parse_selection, parse_url, session, BrowserBounds, BrowserDeviceViewport, BrowserState, SCRIPT,
};
use base64::Engine as _;
use cef::*;
use serde_json::Value;
use std::{
    cell::RefCell,
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

mod macos;

type Reply = oneshot::Sender<Result<Value, String>>;
type Pending = Arc<Mutex<HashMap<i32, Reply>>>;
static NEXT_REQUEST: AtomicI32 = AtomicI32::new(1);
const EVENTFLAG_COMMAND_DOWN: u32 = 1 << 7;
const VKEY_F: i32 = 0x46;

#[derive(Default)]
struct Engine {
    initialized: bool,
    startup_error: Option<String>,
    sessions: HashMap<String, BrowserSession>,
    active_thread_id: Option<String>,
    root_cache_path: Option<PathBuf>,
    loader: Option<library_loader::LibraryLoader>,
    pump: Option<macos::MessagePump>,
}

struct BrowserSession {
    thread_id: String,
    session_id: String,
    /// CEF exclusively owns this directory.
    profile_dir: PathBuf,
    /// App-owned URL and process-lock state; never pass this to CEF.
    metadata_dir: PathBuf,
    ownership: Option<session::OwnershipClaim>,
    browser: Browser,
    _request_context: RequestContext,
    device: Option<BrowserDeviceViewport>,
    observer: Option<Registration>,
    pending: Pending,
    closed: Arc<AtomicBool>,
    closing: bool,
}

thread_local! { static ENGINE: RefCell<Engine> = RefCell::new(Engine::default()); }

pub fn version() -> String {
    String::from_utf8_lossy(sys::CEF_VERSION)
        .trim_end_matches('\0')
        .to_string()
}

async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    operation: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(operation(&handle));
    })
    .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(30), rx)
        .await
        .map_err(|_| "Chromium did not respond in time".to_string())?
        .map_err(|_| "Chromium request was cancelled".to_string())?
}

fn initialize(app: &AppHandle, engine: &mut Engine) -> Result<(), String> {
    if engine.initialized {
        return Ok(());
    }
    if let Some(error) = &engine.startup_error {
        return Err(error.clone());
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let contents = executable
        .parent()
        .and_then(|path| path.parent())
        .ok_or("Chromium requires a packaged app bundle")?;
    let framework = contents.join("Frameworks/Chromium Embedded Framework.framework");
    let helper = contents.join(
        "Frameworks/Codex Monitor Chromium Helper.app/Contents/MacOS/Codex Monitor Chromium Helper",
    );
    if !framework.join("Chromium Embedded Framework").is_file() || !helper.is_file() {
        return Err("This app bundle is missing the Chromium framework or helper. Rebuild the Chromium app.".into());
    }
    if engine.loader.is_none() {
        let loader = library_loader::LibraryLoader::new(&executable, false);
        if !loader.load() {
            return Err("The Chromium framework could not be loaded".into());
        }
        engine.loader = Some(loader);
    }
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    macos::configure_application()?;
    let cache = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("chromium");
    std::fs::create_dir_all(&cache).map_err(|error| error.to_string())?;
    let identifier = app.config().identifier.as_str();
    let keychain_service = format!("{identifier} Chromium Safe Storage");
    let settings = Settings {
        external_message_pump: 1,
        // Renderer sandbox remains enabled; no remote debugging port is opened.
        no_sandbox: 0,
        persist_session_cookies: 1,
        keychain_service_name: CefString::from(keychain_service.as_str()),
        keychain_account_name: CefString::from(identifier),
        // Individual request contexts own persistent, thread-isolated profiles.
        cache_path: CefString::default(),
        root_cache_path: CefString::from(cache.to_string_lossy().as_ref()),
        framework_dir_path: CefString::from(framework.to_string_lossy().as_ref()),
        main_bundle_path: CefString::from(
            contents
                .parent()
                .ok_or("Invalid app bundle")?
                .to_string_lossy()
                .as_ref(),
        ),
        browser_subprocess_path: CefString::from(helper.to_string_lossy().as_ref()),
        log_file: CefString::from(cache.join("chromium.log").to_string_lossy().as_ref()),
        log_severity: LogSeverity::WARNING,
        ..Default::default()
    };
    let args = args::Args::new();
    let mut application = PaneApp::new();
    if cef::initialize(
        Some(args.as_main_args()),
        Some(&settings),
        Some(&mut application),
        std::ptr::null_mut(),
    ) != 1
    {
        return Err("Chromium could not be initialized".into());
    }
    engine.initialized = true;
    engine.root_cache_path = Some(cache);
    engine.pump = Some(macos::MessagePump::install()?);
    Ok(())
}

/// Attach CEF's Cocoa run-loop observers before Tauri starts that run loop.
/// Attaching during a navigation misses its entry and unbalances CEF's nesting.
pub fn prepare(app: &AppHandle) {
    ENGINE.with(|cell| {
        let mut engine = cell.borrow_mut();
        if let Err(error) = initialize(app, &mut engine) {
            engine.startup_error = Some(error);
        }
    });
}

fn current_url(browser: &Browser) -> Option<String> {
    let url = CefString::from(&browser.main_frame()?.url()).to_string();
    parse_url(&url).ok().map(|url| url.to_string())
}

fn emit_page(
    app: &AppHandle,
    browser: &Browser,
    thread_id: &str,
    session_id: &str,
    metadata_dir: &std::path::Path,
    title: Option<String>,
    error: Option<String>,
) {
    let Some(url) = current_url(browser) else {
        return;
    };
    if let Ok(record) = session::new_record(thread_id, Some(url.clone())) {
        let _ = session::write_record(metadata_dir, &record);
    }
    let _ = app.emit_to(
        "main",
        "browser-page",
        serde_json::json!({
            "threadId": thread_id, "sessionId": session_id,
            "url": url, "loading": browser.is_loading() != 0, "title": title, "error": error,
        }),
    );
}

fn log_session(event: &str, session: &BrowserSession, decision: &str) {
    eprintln!(
        "{}",
        serde_json::json!({
            "component": "internal_browser",
            "event": event,
            "decision": decision,
            "threadId": session.thread_id,
            "browserSessionId": session.session_id,
            "profileDirectory": session.profile_dir,
            "metadataDirectory": session.metadata_dir,
            "browserProcessId": std::process::id(),
            "browserId": session.browser.identifier(),
            "devtoolsConnection": format!("cef-devtools:{}", session.browser.identifier()),
        })
    );
}

fn disarm(app: &AppHandle) {
    app.state::<BrowserState>()
        .annotation_armed
        .store(false, Ordering::SeqCst);
}

fn apply_device(browser: &Browser, device: Option<BrowserDeviceViewport>) -> Result<(), String> {
    let host = browser.host().ok_or("Chromium page is unavailable")?;
    let (method, mut parameters) = if let Some(device) = device {
        let parameters = dictionary_value_create().ok_or("Device settings are unavailable")?;
        parameters.set_int(Some(&CefString::from("width")), device.width);
        parameters.set_int(Some(&CefString::from("height")), device.height);
        parameters.set_int(Some(&CefString::from("screenWidth")), device.width);
        parameters.set_int(Some(&CefString::from("screenHeight")), device.height);
        parameters.set_double(Some(&CefString::from("deviceScaleFactor")), 1.0);
        parameters.set_bool(Some(&CefString::from("mobile")), 1);
        parameters.set_double(Some(&CefString::from("scale")), device.scale);
        // The app sizes the native child view to the fitted viewport.
        parameters.set_bool(Some(&CefString::from("dontSetVisibleSize")), 1);
        ("Emulation.setDeviceMetricsOverride", Some(parameters))
    } else {
        ("Emulation.clearDeviceMetricsOverride", None)
    };
    if host.execute_dev_tools_method(
        NEXT_REQUEST.fetch_add(1, Ordering::SeqCst),
        Some(&CefString::from(method)),
        parameters.as_mut(),
    ) == 0
    {
        return Err("Chromium could not update the device viewport".into());
    }
    Ok(())
}

fn update_viewport(
    app: &AppHandle,
    browser_session: &mut BrowserSession,
    bounds: &BrowserBounds,
    device: Option<BrowserDeviceViewport>,
) -> Result<(), String> {
    macos::set_bounds(app, &browser_session.browser, bounds)?;
    if browser_session.device != device {
        apply_device(&browser_session.browser, device)?;
        browser_session.device = device;
    }
    Ok(())
}

fn hide_other_sessions(engine: &mut Engine, thread_id: &str) -> Result<(), String> {
    for (other_thread_id, browser_session) in &engine.sessions {
        if other_thread_id != thread_id {
            macos::set_visible(&browser_session.browser, false)?;
        }
    }
    engine.active_thread_id = Some(thread_id.to_string());
    Ok(())
}

fn create_session(
    app: &AppHandle,
    engine: &mut Engine,
    thread_id: &str,
    initial_url: &str,
    bounds: &BrowserBounds,
    hidden: bool,
) -> Result<(), String> {
    let root = engine
        .root_cache_path
        .as_ref()
        .ok_or("Chromium profile root is unavailable")?;
    let profile_dir = session::profile_dir(root, thread_id)?;
    // CEF must create and own the request-context cache directory. Move only
    // known metadata left by previous builds before CEF sees this path.
    session::migrate_legacy_metadata(root, thread_id)?;
    let metadata_dir = session::metadata_dir(root, thread_id)?;
    let session_id = session::session_id(thread_id)?;
    let ownership = session::claim_ownership(&metadata_dir, thread_id)?;
    let ownership_decision = ownership.decision;

    let parent = app
        .get_window("main")
        .ok_or("Main window is unavailable")?
        .ns_view()
        .map_err(|error| error.to_string())?;
    let mut window = WindowInfo {
        runtime_style: RuntimeStyle::ALLOY,
        ..Default::default()
    }
    .set_as_child(
        parent.cast(),
        &Rect {
            x: 0,
            y: 0,
            width: bounds.width.round().max(1.0) as i32,
            height: bounds.height.round().max(1.0) as i32,
        },
    );
    // cef::WindowInfo::set_as_child defaults macOS children to visible.
    window.hidden = i32::from(hidden);
    let closed = Arc::new(AtomicBool::new(false));
    let mut client = PaneClient::new(
        app.clone(),
        thread_id.to_string(),
        session_id.clone(),
        metadata_dir.clone(),
        closed.clone(),
    );
    let context_settings = RequestContextSettings {
        cache_path: CefString::from(profile_dir.to_string_lossy().as_ref()),
        persist_session_cookies: 1,
        ..Default::default()
    };
    let mut request_context = request_context_create_context(Some(&context_settings), None)
        .ok_or("The isolated Chromium request context could not be created")?;
    let browser = browser_host_create_browser_sync(
        Some(&window),
        Some(&mut client),
        Some(&CefString::from(initial_url)),
        Some(&BrowserSettings::default()),
        None,
        Some(&mut request_context),
    )
    .ok_or("The embedded Chromium view could not be created")?;
    if let Some(host) = browser.host() {
        host.set_accessibility_state(State::from(sys::cef_state_t::STATE_ENABLED));
    }
    // `WindowInfo::hidden` is not applied consistently by CEF on macOS while
    // the child view is being attached. Hide it again once it has a native
    // view so a tool-opened page can never flash at CEF's (0, 0) fallback
    // rectangle before BrowserPanel supplies its measured bounds.
    if hidden {
        macos::set_visible(&browser, false)?;
    }
    let browser_session = BrowserSession {
        thread_id: thread_id.to_string(),
        session_id,
        profile_dir,
        metadata_dir,
        ownership: Some(ownership),
        browser,
        _request_context: request_context,
        device: None,
        observer: None,
        pending: Arc::new(Mutex::new(HashMap::new())),
        closed,
        closing: false,
    };
    log_session(
        "session_open",
        &browser_session,
        match ownership_decision {
            session::OwnershipDecision::Claimed => "new-session",
            session::OwnershipDecision::RecoveredStale => "stale-recovery",
        },
    );
    engine
        .sessions
        .insert(thread_id.to_string(), browser_session);
    Ok(())
}

fn ensure_session(
    app: &AppHandle,
    engine: &mut Engine,
    thread_id: &str,
    requested_url: Option<&str>,
    bounds: &BrowserBounds,
    hidden_on_create: bool,
) -> Result<(), String> {
    session::validate_thread_id(thread_id)?;
    if let Some(existing) = engine.sessions.get(thread_id) {
        if existing.closing && !existing.closed.load(Ordering::SeqCst) {
            return Err("This thread's previous browser page is still closing".into());
        }
        log_session("session_open", existing, "reconnect");
        return Ok(());
    }
    let root = engine
        .root_cache_path
        .as_ref()
        .ok_or("Chromium profile root is unavailable")?;
    session::migrate_legacy_metadata(root, thread_id)?;
    let metadata = session::metadata_dir(root, thread_id)?;
    let restored = session::read_record(&metadata, thread_id).and_then(|record| record.url);
    let initial_url = requested_url
        .map(str::to_string)
        .or(restored)
        .ok_or("This thread has no internal-browser page yet; call internal_browser.open first")?;
    create_session(
        app,
        engine,
        thread_id,
        &initial_url,
        bounds,
        hidden_on_create,
    )
}

pub async fn navigate(
    app: &AppHandle,
    thread_id: String,
    url: tauri::Url,
    bounds: BrowserBounds,
    device: Option<BrowserDeviceViewport>,
) -> Result<(), String> {
    on_main(app, move |app| {
        ENGINE.with(|cell| {
            let mut engine = cell.borrow_mut();
            initialize(app, &mut engine)?;
            disarm(app);
            ensure_session(
                app,
                &mut engine,
                &thread_id,
                Some(url.as_str()),
                &bounds,
                false,
            )?;
            hide_other_sessions(&mut engine, &thread_id)?;
            let browser_session = engine
                .sessions
                .get_mut(&thread_id)
                .ok_or("Browser session is unavailable")?;
            update_viewport(app, browser_session, &bounds, device)?;
            browser_session
                .browser
                .main_frame()
                .ok_or("Chromium page is unavailable")?
                .load_url(Some(&CefString::from(url.as_str())));
            macos::set_visible(&browser_session.browser, true)
        })
    })
    .await
}

pub async fn get_url(app: &AppHandle, thread_id: String) -> Result<Option<String>, String> {
    on_main(app, move |app| {
        ENGINE.with(|cell| {
            let mut engine = cell.borrow_mut();
            initialize(app, &mut engine)?;
            if let Some(browser_session) = engine.sessions.get(&thread_id) {
                return Ok(current_url(&browser_session.browser));
            }
            let root = engine
                .root_cache_path
                .as_ref()
                .ok_or("Chromium profile root is unavailable")?;
            session::migrate_legacy_metadata(root, &thread_id)?;
            let metadata = session::metadata_dir(root, &thread_id)?;
            Ok(session::read_record(&metadata, &thread_id).and_then(|record| record.url))
        })
    })
    .await
}

pub async fn set_bounds(
    app: &AppHandle,
    thread_id: String,
    bounds: BrowserBounds,
    device: Option<BrowserDeviceViewport>,
) -> Result<(), String> {
    on_main(app, move |app| {
        ENGINE.with(|cell| {
            let mut engine = cell.borrow_mut();
            let Some(browser_session) = engine.sessions.get_mut(&thread_id) else {
                return Ok(());
            };
            update_viewport(app, browser_session, &bounds, device)
        })
    })
    .await
}

pub async fn set_visible(app: &AppHandle, thread_id: String, visible: bool) -> Result<(), String> {
    on_main(app, move |_| {
        ENGINE.with(|cell| {
            let mut engine = cell.borrow_mut();
            if visible {
                hide_other_sessions(&mut engine, &thread_id)?;
            }
            if let Some(browser_session) = engine.sessions.get(&thread_id) {
                macos::set_visible(&browser_session.browser, visible)?;
            }
            Ok(())
        })
    })
    .await
}

fn prepare_session_close(browser_session: &mut BrowserSession) -> Browser {
    browser_session.closing = true;
    browser_session.device = None;
    browser_session.observer.take();
    if let Ok(mut pending) = browser_session.pending.lock() {
        pending.clear();
    }
    browser_session.browser.clone()
}

fn request_browser_close(browser: Browser) -> Result<(), String> {
    if browser.is_valid() == 0 {
        return Ok(());
    }
    if let Some(host) = browser.host() {
        host.close_dev_tools();
    }
    macos::detach(&browser)
}

pub async fn close(app: &AppHandle, thread_id: String) -> Result<Option<String>, String> {
    let (url, closing, closed, ownership) = on_main(app, move |app| {
        disarm(app);
        let (browser, url, closing, closed, ownership) = ENGINE.with(|cell| {
            let mut engine = cell.borrow_mut();
            let Some(mut browser_session) = engine.sessions.remove(&thread_id) else {
                return (None, None, false, Arc::new(AtomicBool::new(true)), None);
            };
            let url = current_url(&browser_session.browser);
            if let Ok(record) = session::new_record(&thread_id, url.clone()) {
                let _ = session::write_record(&browser_session.metadata_dir, &record);
            }
            log_session("session_close", &browser_session, "thread-close");
            let ownership = browser_session.ownership.take();
            let browser = prepare_session_close(&mut browser_session);
            let closing = browser_session.closing;
            let closed = browser_session.closed.clone();
            if engine.active_thread_id.as_deref() == Some(thread_id.as_str()) {
                engine.active_thread_id = None;
            }
            (Some(browser), url, closing, closed, ownership)
        });
        if let Some(browser) = browser {
            request_browser_close(browser)?;
        }
        Ok((url, closing, closed, ownership))
    })
    .await?;
    if closing {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !closed.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| "Chromium did not close the page in time".to_string())?;
    }
    if let Some(ownership) = ownership {
        session::release_ownership(ownership);
    }
    Ok(url)
}

pub async fn action(app: &AppHandle, thread_id: String, action: String) -> Result<(), String> {
    if !matches!(
        action.as_str(),
        "back" | "forward" | "reload" | "stop" | "annotate" | "browse" | "devtools"
    ) {
        return Err("Unknown browser action".into());
    }
    on_main(app, move |app| {
        ENGINE.with(|cell| {
            let engine = cell.borrow();
            let Some(browser_session) = engine.sessions.get(&thread_id) else {
                return Ok(());
            };
            let browser = &browser_session.browser;
            if action == "devtools" {
                let host = browser.host().ok_or("Chromium page is unavailable")?;
                let window = WindowInfo {
                    window_name: CefString::from("Chromium DevTools"),
                    bounds: Rect {
                        width: 1000,
                        height: 700,
                        ..Default::default()
                    },
                    runtime_style: RuntimeStyle::CHROME,
                    ..Default::default()
                };
                let mut client = InspectorClient::new();
                host.show_dev_tools(
                    Some(&window),
                    Some(&mut client),
                    Some(&BrowserSettings::default()),
                    None,
                );
                return Ok(());
            }
            app.state::<BrowserState>()
                .annotation_armed
                .store(action == "annotate", Ordering::SeqCst);
            match action.as_str() {
                "back" => browser.go_back(),
                "forward" => browser.go_forward(),
                "reload" => browser.reload(),
                "stop" => browser.stop_load(),
                _ => {
                    if let Some(frame) = browser.main_frame() {
                        let script = format!(
                            "{}\nwindow.__codexMonitorBrowser?.setActive({});",
                            SCRIPT,
                            action == "annotate"
                        );
                        frame.execute_java_script(Some(&CefString::from(script.as_str())), None, 0);
                    }
                }
            }
            Ok(())
        })
    })
    .await
}

pub async fn find(
    app: &AppHandle,
    thread_id: String,
    query: String,
    forward: bool,
    find_next: bool,
) -> Result<(), String> {
    on_main(app, move |_| {
        ENGINE.with(|cell| {
            let engine = cell.borrow();
            let browser_session = engine
                .sessions
                .get(&thread_id)
                .ok_or("Open a website in this thread's internal browser first")?;
            let host = browser_session
                .browser
                .host()
                .ok_or("Chromium page is unavailable")?;
            if query.is_empty() {
                host.stop_finding(1);
            } else {
                host.find(
                    Some(&CefString::from(query.as_str())),
                    forward as i32,
                    0,
                    find_next as i32,
                );
            }
            Ok(())
        })
    })
    .await
}

pub async fn stop_find(app: &AppHandle, thread_id: String) -> Result<(), String> {
    on_main(app, move |_| {
        ENGINE.with(|cell| {
            let engine = cell.borrow();
            if let Some(browser_session) = engine.sessions.get(&thread_id) {
                if let Some(host) = browser_session.browser.host() {
                    host.stop_finding(1);
                    host.set_focus(1);
                }
            }
            Ok(())
        })
    })
    .await
}

async fn execute_devtools_method(
    app: &AppHandle,
    thread_id: String,
    method: String,
    parameters: Option<Value>,
) -> Result<Value, String> {
    let id = NEXT_REQUEST.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    let request_thread_id = thread_id.clone();
    on_main(app, move |_| {
        ENGINE.with(|cell| {
            let mut engine = cell.borrow_mut();
            let browser_session = engine
                .sessions
                .get_mut(&request_thread_id)
                .ok_or("Open a website in this thread's internal browser first")?;
            let browser = browser_session.browser.clone();
            if browser_session.observer.is_none() {
                let mut observer = CaptureObserver::new(browser_session.pending.clone());
                browser_session.observer = browser
                    .host()
                    .and_then(|host| host.add_dev_tools_message_observer(Some(&mut observer)));
                if browser_session.observer.is_none() {
                    return Err("Chromium DevTools observer is unavailable".into());
                }
            }
            let mut pending = browser_session
                .pending
                .lock()
                .map_err(|_| "Chromium DevTools state is unavailable")?;
            if pending.len() >= 4 {
                return Err("Too many browser tool calls are already running".into());
            }
            pending.insert(id, tx);
            drop(pending);
            let mut cef_parameters = parameters
                .map(|value| {
                    parse_json(
                        Some(&CefString::from(value.to_string().as_str())),
                        JsonParserOptions::RFC,
                    )
                    .and_then(|value| value.dictionary())
                    .ok_or("Invalid DevTools parameters")
                })
                .transpose()?;
            let sent = browser
                .host()
                .ok_or("Chromium page is unavailable")?
                .execute_dev_tools_method(
                    id,
                    Some(&CefString::from(method.as_str())),
                    cef_parameters.as_mut(),
                );
            if sent == 0 {
                if let Ok(mut pending) = browser_session.pending.lock() {
                    pending.remove(&id);
                }
                return Err("Chromium rejected the DevTools request".into());
            }
            Ok(())
        })
    })
    .await?;
    let result = tokio::time::timeout(Duration::from_secs(15), rx).await;
    if result.is_err() {
        let _ = on_main(app, move |_| {
            ENGINE.with(|cell| {
                if let Some(browser_session) = cell.borrow().sessions.get(&thread_id) {
                    if let Ok(mut pending) = browser_session.pending.lock() {
                        pending.remove(&id);
                    }
                }
            });
            Ok(())
        })
        .await;
    }
    result
        .map_err(|_| "Browser tool call timed out")?
        .map_err(|_| "Browser tool call was cancelled")?
}

pub async fn capture(app: &AppHandle, thread_id: String) -> Result<Vec<u8>, String> {
    let payload = execute_devtools_method(
        app,
        thread_id,
        "Page.captureScreenshot".into(),
        Some(serde_json::json!({"format":"png","captureBeyondViewport":false})),
    )
    .await?;
    let data = payload
        .get("data")
        .and_then(Value::as_str)
        .ok_or("Chromium returned no screenshot")?;
    if data.len() > 42 * 1024 * 1024 {
        return Err("Screenshot is too large".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "Invalid Chromium screenshot")?;
    if bytes.len() > 30 * 1024 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Chromium returned an invalid or oversized PNG".into());
    }
    Ok(bytes)
}

async fn ensure_tool_session(app: &AppHandle, thread_id: String) -> Result<(), String> {
    let activated_thread_id = thread_id.clone();
    on_main(app, move |app| {
        ENGINE.with(|cell| {
            let mut engine = cell.borrow_mut();
            initialize(app, &mut engine)?;
            let bounds = BrowserBounds {
                x: 0.0,
                y: 0.0,
                width: 800.0,
                height: 600.0,
            };
            // Agent tools can run while the React browser panel is closed. A
            // newly created native child must remain hidden until the panel
            // mounts and supplies its measured rectangle.
            ensure_session(app, &mut engine, &thread_id, None, &bounds, true)?;
            Ok(())
        })
    })
    .await?;
    let _ = app.emit_to(
        "main",
        "browser-session-activated",
        serde_json::json!({"threadId": activated_thread_id}),
    );
    Ok(())
}

async fn open_from_tool(app: &AppHandle, thread_id: String, url: tauri::Url) -> Result<(), String> {
    let activated_thread_id = thread_id.clone();
    on_main(app, move |app| {
        ENGINE.with(|cell| {
            let mut engine = cell.borrow_mut();
            initialize(app, &mut engine)?;
            disarm(app);
            let fallback_bounds = BrowserBounds {
                x: 0.0,
                y: 0.0,
                width: 800.0,
                height: 600.0,
            };
            let session_exists = engine.sessions.contains_key(&thread_id);
            // Do not overwrite an existing pane's measured bounds with the
            // fallback. For a new session, CEF creates the child hidden; the
            // activation event lets BrowserPanel measure, position, and show it.
            ensure_session(
                app,
                &mut engine,
                &thread_id,
                Some(url.as_str()),
                &fallback_bounds,
                true,
            )?;
            if session_exists {
                let frame = engine
                    .sessions
                    .get(&thread_id)
                    .and_then(|session| session.browser.main_frame())
                    .ok_or("Chromium page is unavailable")?;
                let _ = app.emit_to(
                    "main",
                    "browser-tool-navigation",
                    serde_json::json!({"threadId": thread_id}),
                );
                frame.load_url(Some(&CefString::from(url.as_str())));
            }
            Ok(())
        })
    })
    .await?;
    let _ = app.emit_to(
        "main",
        "browser-session-activated",
        serde_json::json!({"threadId": activated_thread_id}),
    );
    Ok(())
}

fn runtime_value(payload: Value) -> Result<Value, String> {
    if let Some(exception) = payload.get("exceptionDetails") {
        return Err(format!(
            "Page JavaScript failed: {}",
            exception
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
        ));
    }
    Ok(payload
        .get("result")
        .and_then(|result| result.get("value"))
        .cloned()
        .unwrap_or(Value::Null))
}

async fn evaluate(app: &AppHandle, thread_id: String, expression: String) -> Result<Value, String> {
    ensure_tool_session(app, thread_id.clone()).await?;
    let payload = execute_devtools_method(
        app,
        thread_id,
        "Runtime.evaluate".into(),
        Some(serde_json::json!({
            "expression": expression,
            "returnByValue": true,
            "awaitPromise": true,
            "userGesture": true
        })),
    )
    .await?;
    runtime_value(payload)
}

pub async fn tool_call(
    app: &AppHandle,
    thread_id: String,
    tool: String,
    arguments: Value,
) -> Result<Vec<Value>, String> {
    session::validate_thread_id(&thread_id)?;
    eprintln!(
        "{}",
        serde_json::json!({
            "component": "internal_browser", "event": "tool_call",
            "threadId": thread_id, "tool": tool,
            "argumentsLogged": false
        })
    );
    match tool.as_str() {
        "open" => {
            let url = arguments
                .get("url")
                .and_then(Value::as_str)
                .ok_or("url is required")?;
            let url = parse_url(url)?;
            open_from_tool(app, thread_id, url).await?;
            Ok(vec![
                serde_json::json!({"type":"inputText","text":"Opened in this thread's visible internal browser."}),
            ])
        }
        "tabs" => {
            let result = on_main(app, move |app| {
                ENGINE.with(|cell| {
                    let mut engine = cell.borrow_mut();
                    initialize(app, &mut engine)?;
                    if let Some(browser_session) = engine.sessions.get(&thread_id) {
                        return Ok(serde_json::json!([{
                            "id": browser_session.session_id,
                            "url": current_url(&browser_session.browser),
                            "visible": engine.active_thread_id.as_deref() == Some(thread_id.as_str()),
                        }]));
                    }
                    let root = engine
                        .root_cache_path
                        .as_ref()
                        .ok_or("Chromium profile root is unavailable")?;
                    session::migrate_legacy_metadata(root, &thread_id)?;
                    let metadata = session::metadata_dir(root, &thread_id)?;
                    let Some(record) = session::read_record(&metadata, &thread_id) else {
                        return Ok(serde_json::json!([]));
                    };
                    Ok(serde_json::json!([{
                        "id": record.session_id,
                        "url": record.url,
                        "visible": false,
                    }]))
                })
            }).await?;
            Ok(vec![
                serde_json::json!({"type":"inputText","text":result.to_string()}),
            ])
        }
        "snapshot" => {
            let expression = r#"(() => {
              const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
              const selector = (el) => {
                if (el.id) return '#' + CSS.escape(el.id);
                const parts = []; let node = el;
                while (node && node.nodeType === 1 && parts.length < 5) {
                  let part = node.tagName.toLowerCase();
                  const parent = node.parentElement;
                  if (parent) { const peers = [...parent.children].filter(x => x.tagName === node.tagName); if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(node) + 1})`; }
                  parts.unshift(part); node = parent;
                }
                return parts.join(' > ');
              };
              const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"]')].filter(visible).slice(0, 120);
              return { title: document.title, url: location.href, elements: nodes.map(el => ({
                selector: selector(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role'),
                label: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || '').trim().slice(0, 240),
                disabled: !!el.disabled
              })) };
            })()"#;
            let value = evaluate(app, thread_id, expression.into()).await?;
            Ok(vec![
                serde_json::json!({"type":"inputText","text":value.to_string()}),
            ])
        }
        "click" => {
            let selector = arguments
                .get("selector")
                .and_then(Value::as_str)
                .ok_or("selector is required")?;
            let selector = serde_json::to_string(selector).map_err(|error| error.to_string())?;
            let expression = format!("(() => {{ const el = document.querySelector({selector}); if (!el) throw new Error('Element not found'); el.scrollIntoView({{block:'center'}}); el.click(); return true; }})()");
            evaluate(app, thread_id, expression).await?;
            Ok(vec![
                serde_json::json!({"type":"inputText","text":"Clicked the element."}),
            ])
        }
        "fill" => {
            let selector = arguments
                .get("selector")
                .and_then(Value::as_str)
                .ok_or("selector is required")?;
            let value = arguments
                .get("value")
                .and_then(Value::as_str)
                .ok_or("value is required")?;
            let selector = serde_json::to_string(selector).map_err(|error| error.to_string())?;
            let value = serde_json::to_string(value).map_err(|error| error.to_string())?;
            let expression = format!("(() => {{ const el = document.querySelector({selector}); if (!el) throw new Error('Element not found'); el.focus(); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set; if (setter) setter.call(el, {value}); else el.value = {value}; el.dispatchEvent(new Event('input', {{bubbles:true}})); el.dispatchEvent(new Event('change', {{bubbles:true}})); return true; }})()");
            evaluate(app, thread_id, expression).await?;
            Ok(vec![
                serde_json::json!({"type":"inputText","text":"Filled the element. The value was not logged or returned."}),
            ])
        }
        "evaluate" => {
            let expression = arguments
                .get("expression")
                .and_then(Value::as_str)
                .ok_or("expression is required")?;
            let value = evaluate(app, thread_id, expression.to_string()).await?;
            Ok(vec![
                serde_json::json!({"type":"inputText","text":value.to_string()}),
            ])
        }
        "screenshot" => {
            ensure_tool_session(app, thread_id.clone()).await?;
            let png = capture(app, thread_id).await?;
            let encoded = base64::engine::general_purpose::STANDARD.encode(png);
            Ok(vec![
                serde_json::json!({"type":"inputImage","imageUrl":format!("data:image/png;base64,{encoded}")}),
            ])
        }
        _ => Err("Unknown internal browser tool".into()),
    }
}

/// Called on the main thread after the Tauri run loop exits.
pub fn shutdown() {
    let (sessions, initialized) = ENGINE.with(|cell| {
        let mut engine = cell.borrow_mut();
        let initialized = engine.initialized;
        let sessions = engine
            .sessions
            .drain()
            .map(|(_, mut browser_session)| {
                let browser = prepare_session_close(&mut browser_session);
                (
                    browser,
                    browser_session.closed,
                    browser_session.ownership.take(),
                )
            })
            .collect::<Vec<_>>();
        (sessions, initialized)
    });
    if !initialized {
        ENGINE.with(|cell| {
            if let Some(loader) = cell.borrow_mut().loader.take() {
                std::mem::forget(loader);
            }
        });
        return;
    }
    for (browser, _, _) in &sessions {
        let browser = browser.clone();
        let _ = request_browser_close(browser);
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while sessions
        .iter()
        .any(|(_, closed, _)| !closed.load(Ordering::SeqCst))
        && Instant::now() < deadline
    {
        objc2::rc::autoreleasepool(|_| cef::do_message_loop_work());
    }
    for (_, _, ownership) in sessions {
        if let Some(ownership) = ownership {
            session::release_ownership(ownership);
        }
    }
    ENGINE.with(|cell| {
        let mut engine = cell.borrow_mut();
        engine.pump.take();
        cef::shutdown();
        engine.initialized = false;
        // The dynamically registered Cocoa application protocol retains CEF
        // metadata. Leave the framework loaded until the OS tears down the process.
        if let Some(loader) = engine.loader.take() {
            std::mem::forget(loader);
        }
    });
}

wrap_app! {
    struct PaneApp;
    impl App {
        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> { Some(PaneProcess::new()) }
        fn on_before_command_line_processing(&self, _process: Option<&CefString>, command_line: Option<&mut CommandLine>) {
            if let Some(command_line) = command_line {
                // This build embeds a website pane, without Chrome sync, background
                // updates, or local-device discovery. Media Router and Web Bluetooth
                // otherwise cause Chromium helper processes to issue mDNS queries
                // (224.0.0.251) even when no page has requested either capability.
                for flag in ["no-first-run", "disable-background-networking", "disable-component-update", "disable-sync"] {
                    command_line.append_switch(Some(&CefString::from(flag)));
                }
                command_line.append_switch_with_value(
                    Some(&CefString::from("disable-features")),
                    Some(&CefString::from("MediaRouter,CastMediaRouteProvider,WebBluetooth")),
                );
            }
        }
    }
}

wrap_browser_process_handler! {
    struct PaneProcess;
    impl BrowserProcessHandler {
        // A bounded main-run-loop timer services work at 60 Hz. Providing this
        // handler selects CEF's external pump instead of its native event loop.
        fn on_schedule_message_pump_work(&self, _delay_ms: i64) {}
    }
}

wrap_client! {
    struct InspectorClient;
    impl Client {}
}

wrap_client! {
    struct PaneClient {
        app: AppHandle,
        thread_id: String,
        session_id: String,
        metadata_dir: PathBuf,
        closed: Arc<AtomicBool>
    }
    impl Client {
        fn load_handler(&self) -> Option<LoadHandler> { Some(PaneLoad::new(self.app.clone(), self.thread_id.clone(), self.session_id.clone(), self.metadata_dir.clone())) }
        fn display_handler(&self) -> Option<DisplayHandler> { Some(PaneDisplay::new(self.app.clone(), self.thread_id.clone(), self.session_id.clone(), self.metadata_dir.clone())) }
        fn request_handler(&self) -> Option<RequestHandler> { Some(PaneRequest::new(self.app.clone(), self.thread_id.clone(), self.session_id.clone(), self.metadata_dir.clone())) }
        fn life_span_handler(&self) -> Option<LifeSpanHandler> { Some(PaneLife::new(self.closed.clone())) }
        fn find_handler(&self) -> Option<FindHandler> { Some(PaneFind::new(self.app.clone(), self.thread_id.clone(), self.session_id.clone())) }
        fn keyboard_handler(&self) -> Option<KeyboardHandler> { Some(PaneKeyboard::new(self.app.clone(), self.thread_id.clone())) }
    }
}

wrap_find_handler! {
    struct PaneFind { app: AppHandle, thread_id: String, session_id: String }
    impl FindHandler {
        fn on_find_result(&self, _browser: Option<&mut Browser>, _identifier: i32, count: i32,
            _selection_rect: Option<&Rect>, active_match_ordinal: i32, final_update: i32) {
            let _ = self.app.emit_to("main", "browser-find-result", serde_json::json!({
                "threadId": self.thread_id,
                "sessionId": self.session_id,
                "activeMatch": active_match_ordinal,
                "totalMatches": count,
                "finalUpdate": final_update != 0,
            }));
        }
    }
}

wrap_keyboard_handler! {
    struct PaneKeyboard { app: AppHandle, thread_id: String }
    impl KeyboardHandler {
        fn on_pre_key_event(&self, _browser: Option<&mut Browser>, event: Option<&KeyEvent>,
            _os_event: *mut u8, _is_keyboard_shortcut: Option<&mut i32>) -> i32 {
            let Some(event) = event else { return 0 };
            let command_down = event.modifiers & EVENTFLAG_COMMAND_DOWN != 0;
            if event.type_ == KeyEventType::RAWKEYDOWN && command_down && event.windows_key_code == VKEY_F {
                if let Some(shell) = self.app.get_webview("main") {
                    let _ = shell.set_focus();
                }
                let _ = self.app.emit_to("main", "browser-find-open", serde_json::json!({
                    "threadId": self.thread_id,
                }));
                return 1;
            }
            0
        }
    }
}

wrap_load_handler! {
    struct PaneLoad { app: AppHandle, thread_id: String, session_id: String, metadata_dir: PathBuf }
    impl LoadHandler {
        fn on_loading_state_change(&self, browser: Option<&mut Browser>, _loading: i32, _back: i32, _forward: i32) {
            if let Some(browser) = browser { emit_page(&self.app, browser, &self.thread_id, &self.session_id, &self.metadata_dir, None, None); }
        }
        fn on_load_end(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, _status: i32) {
            if let Some(frame) = frame.filter(|frame| frame.is_main() != 0) {
                frame.execute_java_script(Some(&CefString::from(SCRIPT)), None, 0);
            }
        }
        fn on_load_error(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, code: Errorcode,
            _text: Option<&CefString>, failed_url: Option<&CefString>) {
            if frame.is_some_and(|frame| frame.is_main() != 0) {
                let native = sys::cef_errorcode_t::from(code);
                if native != sys::cef_errorcode_t::ERR_ABORTED {
                    if let Some(url) = failed_url.and_then(|url| parse_url(&url.to_string()).ok()) {
                        let _ = self.app.emit_to("main", "browser-page", serde_json::json!({
                            "threadId": self.thread_id, "sessionId": self.session_id,
                            "url": url.to_string(), "loading": false,
                            "error": format!("The website could not be loaded ({})", native as i32),
                        }));
                    } else if let Some(browser) = browser { emit_page(&self.app, browser, &self.thread_id, &self.session_id, &self.metadata_dir, None,
                        Some(format!("The website could not be loaded ({})", native as i32))); }
                }
            }
        }
    }
}

wrap_display_handler! {
    struct PaneDisplay { app: AppHandle, thread_id: String, session_id: String, metadata_dir: PathBuf }
    impl DisplayHandler {
        fn on_title_change(&self, browser: Option<&mut Browser>, title: Option<&CefString>) {
            if let Some(browser) = browser { emit_page(&self.app, browser, &self.thread_id, &self.session_id, &self.metadata_dir, title.map(|title| title.to_string()), None); }
        }
        fn on_address_change(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, _url: Option<&CefString>) {
            if frame.is_some_and(|frame| frame.is_main() != 0) {
                disarm(&self.app);
                if let Some(browser) = browser { emit_page(&self.app, browser, &self.thread_id, &self.session_id, &self.metadata_dir, None, None); }
            }
        }
    }
}

wrap_request_handler! {
    struct PaneRequest { app: AppHandle, thread_id: String, session_id: String, metadata_dir: PathBuf }
    impl RequestHandler {
        fn on_before_browse(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, request: Option<&mut Request>,
            _gesture: i32, _redirect: i32) -> i32 {
            let Some(request) = request else { return 1 };
            let Ok(url) = tauri::Url::parse(&CefString::from(&request.url()).to_string()) else { return 1 };
            if url.scheme() == "codex-monitor-annotation" {
                if let Some(frame) = frame.filter(|frame| frame.is_main() != 0) {
                    let armed = self.app.state::<BrowserState>().annotation_armed.swap(false, Ordering::SeqCst);
                    if armed {
                        if let Some(selection) = parse_selection(&url) {
                            if parse_url(&CefString::from(&frame.url()).to_string()).ok() == parse_url(&selection.url).ok() {
                                if let Some(shell) = self.app.get_webview("main") {
                                    let _ = shell.set_focus();
                                }
                                if let Ok(mut payload) = serde_json::to_value(selection) {
                                    if let Some(payload) = payload.as_object_mut() {
                                        payload.insert("threadId".into(), Value::String(self.thread_id.clone()));
                                        payload.insert("sessionId".into(), Value::String(self.session_id.clone()));
                                    }
                                    let _ = self.app.emit_to("main", "browser-selection", payload);
                                }
                            }
                        }
                    }
                }
                return 1;
            }
            if parse_url(url.as_str()).is_ok() { return 0; }
            // Embedded documents may use these schemes; top-level sites remain HTTP(S).
            if frame.is_some_and(|frame| frame.is_main() == 0) && matches!(url.scheme(), "about" | "data" | "blob") { return 0; }
            1
        }
        fn on_render_process_terminated(&self, browser: Option<&mut Browser>, _status: TerminationStatus,
            _code: i32, _message: Option<&CefString>) {
            disarm(&self.app);
            if let Some(browser) = browser {
                emit_page(&self.app, browser, &self.thread_id, &self.session_id, &self.metadata_dir, None,
                    Some("The Chromium page stopped. Use Reload to reopen it.".into()));
            }
        }
    }
}

wrap_life_span_handler! {
    struct PaneLife { closed: Arc<AtomicBool> }
    impl LifeSpanHandler {
        fn on_before_close(&self, _browser: Option<&mut Browser>) { self.closed.store(true, Ordering::SeqCst); }
        fn on_before_popup(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, _popup_id: i32,
            target_url: Option<&CefString>, _target_frame_name: Option<&CefString>, _disposition: WindowOpenDisposition,
            gesture: i32, _features: Option<&PopupFeatures>, _window: Option<&mut WindowInfo>, _client: Option<&mut Option<Client>>,
            _settings: Option<&mut BrowserSettings>, _extra: Option<&mut Option<DictionaryValue>>, _no_js: Option<&mut i32>) -> i32 {
            if gesture != 0 {
                if let (Some(frame), Some(url)) = (frame, target_url) {
                    if parse_url(&url.to_string()).is_ok() { frame.load_url(Some(url)); }
                }
            }
            1
        }
    }
}

wrap_dev_tools_message_observer! {
    struct CaptureObserver { pending: Pending }
    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(&self, _browser: Option<&mut Browser>, id: i32, success: i32, bytes: Option<&[u8]>) {
            let sender = self.pending.lock().ok().and_then(|mut pending| pending.remove(&id));
            if let Some(sender) = sender {
                let result = if success == 0 { Err("Chromium DevTools method failed".into()) }
                    else if let Some(bytes) = bytes.filter(|bytes| bytes.len() <= 43 * 1024 * 1024) {
                        serde_json::from_slice(bytes).map_err(|_| "Invalid screenshot response".into())
                    } else { Err("Chromium DevTools response is too large".into()) };
                let _ = sender.send(result);
            }
        }
    }
}
