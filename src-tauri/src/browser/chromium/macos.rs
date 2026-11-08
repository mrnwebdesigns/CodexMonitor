//! Cocoa embedding and the public CEF NSApplication protocol integration.
use super::BrowserBounds;
use cef::{Browser, ImplBrowser, ImplBrowserHost};
use core_foundation_sys::{
    base::CFRelease,
    date::CFAbsoluteTimeGetCurrent,
    runloop::{
        kCFRunLoopCommonModes, CFRunLoopAddTimer, CFRunLoopGetMain, CFRunLoopTimerCreate,
        CFRunLoopTimerInvalidate, CFRunLoopTimerRef,
    },
};
use objc2::{
    rc::Retained,
    runtime::{AnyClass, AnyObject, AnyProtocol, Bool, Imp, ProtocolBuilder, Sel},
    sel, MainThreadMarker,
};
use objc2_app_kit::{NSApp, NSEvent, NSView};
use objc2_foundation::{NSObjectProtocol, NSPoint, NSRect, NSSize};
use std::{cell::Cell, ffi::c_void, sync::OnceLock};
use tauri::{AppHandle, Manager};

type SendEvent = unsafe extern "C" fn(&AnyObject, Sel, &NSEvent);
static ORIGINAL_SEND_EVENT: OnceLock<SendEvent> = OnceLock::new();
thread_local! {
    static HANDLING_EVENT: Cell<bool> = const { Cell::new(false) };
    static PUMPING: Cell<bool> = const { Cell::new(false) };
}

unsafe extern "C" {
    fn class_addProtocol(class: *const AnyClass, protocol: *const AnyProtocol) -> Bool;
    fn class_addMethod(
        class: *const AnyClass,
        selector: Sel,
        method: Imp,
        types: *const std::ffi::c_char,
    ) -> Bool;
}

extern "C" fn is_handling(_object: &AnyObject, _selector: Sel) -> Bool {
    Bool::new(HANDLING_EVENT.with(Cell::get))
}

extern "C" fn set_handling(_object: &AnyObject, _selector: Sel, handling: Bool) {
    HANDLING_EVENT.with(|state| state.set(handling.as_bool()));
}

unsafe extern "C" fn send_event(object: &AnyObject, _selector: Sel, event: &NSEvent) {
    let Some(original) = ORIGINAL_SEND_EVENT.get() else {
        return;
    };
    let previous = HANDLING_EVENT.with(|state| state.replace(true));
    // Call the original Tao NSApplication implementation, preserving its input handling.
    original(object, sel!(sendEvent:), event);
    HANDLING_EVENT.with(|state| state.set(previous));
}

pub(super) fn configure_application() -> Result<(), String> {
    if ORIGINAL_SEND_EVENT.get().is_some() {
        return Ok(());
    }
    let marker = MainThreadMarker::new().ok_or("Chromium must initialize on the main thread")?;
    let application = NSApp(marker);
    let class = AnyClass::get(c"TaoApp").ok_or("Tauri application class is unavailable")?;
    if !application.isKindOfClass(class) {
        return Err("Chromium requires the Tauri application instance".into());
    }
    // CEF publishes these protocols in cef_application_mac.h for the host to
    // declare. Rust bindings do not emit Objective-C protocol definitions.
    let base = AnyProtocol::get(c"CrAppProtocol").unwrap_or_else(|| {
        let mut protocol = ProtocolBuilder::new(c"CrAppProtocol").unwrap();
        protocol.add_method_description::<(), Bool>(sel!(isHandlingSendEvent), true);
        protocol.register()
    });
    let control = AnyProtocol::get(c"CrAppControlProtocol").unwrap_or_else(|| {
        let mut protocol = ProtocolBuilder::new(c"CrAppControlProtocol").unwrap();
        protocol.add_protocol(base);
        protocol.add_method_description::<(Bool,), ()>(sel!(setHandlingSendEvent:), true);
        protocol.register()
    });
    let protocol = AnyProtocol::get(c"CefAppProtocol").unwrap_or_else(|| {
        let mut protocol = ProtocolBuilder::new(c"CefAppProtocol").unwrap();
        protocol.add_protocol(control);
        protocol.register()
    });
    // Preserve the live application's isa and Cocoa observation state. A new
    // subclass also makes Tao's dynamic-superclass sendEvent dispatch recurse.
    let method = class
        .instance_method(sel!(sendEvent:))
        .ok_or("Tauri event handler is unavailable")?;
    let original: SendEvent = unsafe { std::mem::transmute(method.implementation()) };
    ORIGINAL_SEND_EVENT
        .set(original)
        .map_err(|_| "Chromium application already configured")?;
    unsafe {
        class_addProtocol(class, protocol);
        class_addMethod(
            class,
            sel!(isHandlingSendEvent),
            std::mem::transmute(is_handling as extern "C" fn(&AnyObject, Sel) -> Bool),
            c"B@:".as_ptr(),
        );
        class_addMethod(
            class,
            sel!(setHandlingSendEvent:),
            std::mem::transmute(set_handling as extern "C" fn(&AnyObject, Sel, Bool)),
            c"v@:B".as_ptr(),
        );
        method.set_implementation(std::mem::transmute(send_event as SendEvent));
    }
    Ok(())
}

fn native_view(browser: &Browser) -> Result<Retained<NSView>, String> {
    let _marker = MainThreadMarker::new().ok_or("Chromium view access requires the main thread")?;
    let pointer = browser
        .host()
        .ok_or("Chromium view is unavailable")?
        .window_handle();
    // CEF's macOS window handle is its NSView. Retain it for this operation.
    unsafe { Retained::retain(pointer.cast::<NSView>()) }
        .ok_or("Chromium view is unavailable".into())
}

pub(super) fn set_bounds(
    app: &AppHandle,
    browser: &Browser,
    bounds: &BrowserBounds,
) -> Result<(), String> {
    let pointer = app
        .get_window("main")
        .ok_or("Main window is unavailable")?
        .ns_view()
        .map_err(|error| error.to_string())?;
    let parent = unsafe { Retained::retain(pointer.cast::<NSView>()) }
        .ok_or("Main content view is unavailable")?;
    let y = if parent.isFlipped() {
        bounds.y
    } else {
        parent.bounds().size.height - bounds.y - bounds.height
    };
    native_view(browser)?.setFrame(NSRect::new(
        NSPoint::new(bounds.x, y),
        NSSize::new(bounds.width, bounds.height),
    ));
    Ok(())
}

pub(super) fn set_visible(browser: &Browser, visible: bool) -> Result<(), String> {
    native_view(browser)?.setHidden(!visible);
    Ok(())
}

pub(super) struct MessagePump(CFRunLoopTimerRef);

extern "C" fn pump(_timer: CFRunLoopTimerRef, _context: *mut c_void) {
    PUMPING.with(|state| {
        if state.replace(true) {
            return;
        }
        objc2::rc::autoreleasepool(|_| cef::do_message_loop_work());
        state.set(false);
    });
}

impl MessagePump {
    pub(super) fn install() -> Result<Self, String> {
        let timer = unsafe {
            CFRunLoopTimerCreate(
                std::ptr::null(),
                CFAbsoluteTimeGetCurrent() + 1.0 / 60.0,
                1.0 / 60.0,
                0,
                0,
                pump,
                std::ptr::null_mut(),
            )
        };
        if timer.is_null() {
            return Err("Chromium message pump could not be created".into());
        }
        unsafe {
            CFRunLoopAddTimer(CFRunLoopGetMain(), timer, kCFRunLoopCommonModes);
        }
        Ok(Self(timer))
    }
}

impl Drop for MessagePump {
    fn drop(&mut self) {
        unsafe {
            CFRunLoopTimerInvalidate(self.0);
            CFRelease(self.0.cast());
        }
    }
}
