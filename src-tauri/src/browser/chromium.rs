//! macOS website pane backed by CEF. The privileged app shell stays in WKWebView.
//! All CEF objects and Cocoa views are confined to the application main thread.
use super::{
    parse_selection, parse_url, BrowserBounds, BrowserDeviceViewport, BrowserState, SCRIPT,
};
use base64::Engine as _;
use cef::*;
use serde_json::Value;
use std::{
    cell::RefCell,
    collections::HashMap,
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

#[derive(Default)]
struct Engine {
    initialized: bool,
    startup_error: Option<String>,
    browser: Option<Browser>,
    device: Option<BrowserDeviceViewport>,
    observer: Option<Registration>,
    pending: Pending,
    closed: Arc<AtomicBool>,
    closing: bool,
    loader: Option<library_loader::LibraryLoader>,
    pump: Option<macos::MessagePump>,
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
        cache_path: CefString::from(cache.to_string_lossy().as_ref()),
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

fn emit_page(app: &AppHandle, browser: &Browser, title: Option<String>, error: Option<String>) {
    let Some(url) = current_url(browser) else {
        return;
    };
    let _ = app.emit_to(
        "main",
        "browser-page",
        serde_json::json!({
            "url": url, "loading": browser.is_loading() != 0, "title": title, "error": error,
        }),
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
    engine: &mut Engine,
    bounds: &BrowserBounds,
    device: Option<BrowserDeviceViewport>,
) -> Result<(), String> {
    let Some(browser) = engine.browser.as_ref() else {
        return Ok(());
    };
    macos::set_bounds(app, browser, bounds)?;
    if engine.device != device {
        apply_device(browser, device)?;
        engine.device = device;
    }
    Ok(())
}

pub async fn navigate(
    app: &AppHandle,
    url: tauri::Url,
    bounds: BrowserBounds,
    device: Option<BrowserDeviceViewport>,
) -> Result<(), String> {
    on_main(app, move |app| {
        ENGINE.with(|cell| {
            let mut engine = cell.borrow_mut();
            if engine.closing && !engine.closed.load(Ordering::SeqCst) {
                return Err("The previous browser page is still closing".into());
            }
            engine.closing = false;
            initialize(app, &mut engine)?;
            disarm(app);
            if let Some(browser) = engine.browser.clone() {
                update_viewport(app, &mut engine, &bounds, device)?;
                browser
                    .main_frame()
                    .ok_or("Chromium page is unavailable")?
                    .load_url(Some(&CefString::from(url.as_str())));
                return macos::set_visible(&browser, true);
            }
            let parent = app
                .get_window("main")
                .ok_or("Main window is unavailable")?
                .ns_view()
                .map_err(|error| error.to_string())?;
            let window = WindowInfo {
                runtime_style: RuntimeStyle::ALLOY,
                ..Default::default()
            }
            .set_as_child(
                parent.cast(),
                &Rect {
                    x: 0,
                    y: 0,
                    width: bounds.width.round() as i32,
                    height: bounds.height.round() as i32,
                },
            );
            let mut client = PaneClient::new(app.clone(), engine.closed.clone());
            engine.closed.store(false, Ordering::SeqCst);
            let browser = browser_host_create_browser_sync(
                Some(&window),
                Some(&mut client),
                Some(&CefString::from(url.as_str())),
                Some(&BrowserSettings::default()),
                None,
                None,
            )
            .ok_or("The embedded Chromium view could not be created")?;
            if let Some(host) = browser.host() {
                host.set_accessibility_state(State::from(sys::cef_state_t::STATE_ENABLED));
            }
            engine.browser = Some(browser.clone());
            update_viewport(app, &mut engine, &bounds, device)?;
            macos::set_visible(&browser, true)
        })
    })
    .await
}

pub async fn get_url(app: &AppHandle) -> Result<Option<String>, String> {
    on_main(app, |_| {
        ENGINE.with(|cell| Ok(cell.borrow().browser.as_ref().and_then(current_url)))
    })
    .await
}

pub async fn set_bounds(
    app: &AppHandle,
    bounds: BrowserBounds,
    device: Option<BrowserDeviceViewport>,
) -> Result<(), String> {
    on_main(app, move |app| {
        ENGINE.with(|cell| update_viewport(app, &mut cell.borrow_mut(), &bounds, device))
    })
    .await
}

pub async fn set_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
    on_main(app, move |_| {
        ENGINE.with(|cell| {
            if let Some(browser) = cell.borrow().browser.as_ref() {
                macos::set_visible(browser, visible)?;
            }
            Ok(())
        })
    })
    .await
}

fn take_browser_for_close(engine: &mut Engine) -> Option<Browser> {
    let browser = engine.browser.take()?;
    engine.closing = true;
    engine.device = None;
    engine.observer.take();
    if let Ok(mut pending) = engine.pending.lock() {
        pending.clear();
    }
    Some(browser)
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

pub async fn close(app: &AppHandle) -> Result<Option<String>, String> {
    let (url, closing, closed) = on_main(app, |app| {
        disarm(app);
        let (browser, url, closing, closed) = ENGINE.with(|cell| {
            let mut engine = cell.borrow_mut();
            let url = engine.browser.as_ref().and_then(current_url);
            let browser = take_browser_for_close(&mut engine);
            (browser, url, engine.closing, engine.closed.clone())
        });
        if let Some(browser) = browser {
            request_browser_close(browser)?;
        }
        Ok((url, closing, closed))
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
    Ok(url)
}

pub async fn action(app: &AppHandle, action: String) -> Result<(), String> {
    if !matches!(
        action.as_str(),
        "back" | "forward" | "reload" | "stop" | "annotate" | "browse" | "devtools"
    ) {
        return Err("Unknown browser action".into());
    }
    on_main(app, move |app| {
        ENGINE.with(|cell| {
            let engine = cell.borrow();
            let Some(browser) = engine.browser.as_ref() else {
                return Ok(());
            };
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

pub async fn capture(app: &AppHandle) -> Result<Vec<u8>, String> {
    let id = NEXT_REQUEST.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    on_main(app, move |_| {
        ENGINE.with(|cell| {
            let mut engine = cell.borrow_mut();
            let browser = engine
                .browser
                .clone()
                .ok_or("Open a website before capturing it")?;
            if engine.observer.is_none() {
                let mut observer = CaptureObserver::new(engine.pending.clone());
                engine.observer = browser
                    .host()
                    .and_then(|host| host.add_dev_tools_message_observer(Some(&mut observer)));
                if engine.observer.is_none() {
                    return Err("Chromium screenshot observer is unavailable".into());
                }
            }
            let mut pending = engine
                .pending
                .lock()
                .map_err(|_| "Screenshot state is unavailable")?;
            if pending.len() >= 4 {
                return Err("A screenshot is already being captured".into());
            }
            pending.insert(id, tx);
            drop(pending);
            let mut parameters =
                dictionary_value_create().ok_or("Screenshot parameters are unavailable")?;
            parameters.set_string(
                Some(&CefString::from("format")),
                Some(&CefString::from("png")),
            );
            parameters.set_bool(Some(&CefString::from("captureBeyondViewport")), 0);
            let sent = browser
                .host()
                .ok_or("Chromium page is unavailable")?
                .execute_dev_tools_method(
                    id,
                    Some(&CefString::from("Page.captureScreenshot")),
                    Some(&mut parameters),
                );
            if sent == 0 {
                if let Ok(mut pending) = engine.pending.lock() {
                    pending.remove(&id);
                }
                return Err("Chromium could not capture the page".into());
            }
            Ok(())
        })
    })
    .await?;
    let result = tokio::time::timeout(Duration::from_secs(15), rx).await;
    if result.is_err() {
        let _ = on_main(app, move |_| {
            ENGINE.with(|cell| {
                if let Ok(mut pending) = cell.borrow().pending.lock() {
                    pending.remove(&id);
                }
            });
            Ok(())
        })
        .await;
    }
    let payload = result
        .map_err(|_| "Screenshot timed out")?
        .map_err(|_| "Screenshot was cancelled")??;
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

/// Called on the main thread after the Tauri run loop exits.
pub fn shutdown() {
    let (browser, closing, closed, initialized) = ENGINE.with(|cell| {
        let mut engine = cell.borrow_mut();
        (
            take_browser_for_close(&mut engine),
            engine.closing,
            engine.closed.clone(),
            engine.initialized,
        )
    });
    if !initialized {
        ENGINE.with(|cell| {
            if let Some(loader) = cell.borrow_mut().loader.take() {
                std::mem::forget(loader);
            }
        });
        return;
    }
    if let Some(browser) = browser {
        let _ = request_browser_close(browser);
    }
    if closing {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !closed.load(Ordering::SeqCst) && Instant::now() < deadline {
            objc2::rc::autoreleasepool(|_| cef::do_message_loop_work());
        }
    }
    ENGINE.with(|cell| {
        let mut engine = cell.borrow_mut();
        engine.observer.take();
        engine.pump.take();
        if !closing || closed.load(Ordering::SeqCst) {
            cef::shutdown();
            engine.initialized = false;
        }
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
                // This build embeds a website pane, without Chrome sync or background updates.
                for flag in ["no-first-run", "disable-background-networking", "disable-component-update", "disable-sync"] {
                    command_line.append_switch(Some(&CefString::from(flag)));
                }
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
    struct PaneClient { app: AppHandle, closed: Arc<AtomicBool> }
    impl Client {
        fn load_handler(&self) -> Option<LoadHandler> { Some(PaneLoad::new(self.app.clone())) }
        fn display_handler(&self) -> Option<DisplayHandler> { Some(PaneDisplay::new(self.app.clone())) }
        fn request_handler(&self) -> Option<RequestHandler> { Some(PaneRequest::new(self.app.clone())) }
        fn life_span_handler(&self) -> Option<LifeSpanHandler> { Some(PaneLife::new(self.closed.clone())) }
    }
}

wrap_load_handler! {
    struct PaneLoad { app: AppHandle }
    impl LoadHandler {
        fn on_loading_state_change(&self, browser: Option<&mut Browser>, _loading: i32, _back: i32, _forward: i32) {
            if let Some(browser) = browser { emit_page(&self.app, browser, None, None); }
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
                            "url": url.to_string(), "loading": false,
                            "error": format!("The website could not be loaded ({})", native as i32),
                        }));
                    } else if let Some(browser) = browser { emit_page(&self.app, browser, None,
                        Some(format!("The website could not be loaded ({})", native as i32))); }
                }
            }
        }
    }
}

wrap_display_handler! {
    struct PaneDisplay { app: AppHandle }
    impl DisplayHandler {
        fn on_title_change(&self, browser: Option<&mut Browser>, title: Option<&CefString>) {
            if let Some(browser) = browser { emit_page(&self.app, browser, title.map(|title| title.to_string()), None); }
        }
        fn on_address_change(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, _url: Option<&CefString>) {
            if frame.is_some_and(|frame| frame.is_main() != 0) {
                disarm(&self.app);
                if let Some(browser) = browser { emit_page(&self.app, browser, None, None); }
            }
        }
    }
}

wrap_request_handler! {
    struct PaneRequest { app: AppHandle }
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
                                let _ = self.app.emit_to("main", "browser-selection", selection);
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
            if let Some(browser) = browser { emit_page(&self.app, browser, None,
                Some("The Chromium page stopped. Use Reload to reopen it.".into())); }
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
                let result = if success == 0 { Err("Chromium could not capture the page".into()) }
                    else if let Some(bytes) = bytes.filter(|bytes| bytes.len() <= 43 * 1024 * 1024) {
                        serde_json::from_slice(bytes).map_err(|_| "Invalid screenshot response".into())
                    } else { Err("Screenshot is too large".into()) };
                let _ = sender.send(result);
            }
        }
    }
}
