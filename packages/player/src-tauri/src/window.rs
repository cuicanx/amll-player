use tauri::{AppHandle, Manager, WebviewWindowBuilder};
use tracing::*;

pub async fn create_common_win<'a>(
    app: &'a AppHandle,
    url: tauri::WebviewUrl,
    label: &str,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let win = WebviewWindowBuilder::new(app, label, url);

    // PERF/UX: Windows used to request a transparent window together with two
    // competing DWM backdrop effects (Tabbed + Mica). Before the webview drew
    // its first frame, the transparent window showed only the custom titlebar
    // outline with the desktop visible through the middle; while resizing,
    // DWM re-composited the backdrop on every size change, causing low frame
    // rates, flicker and intermittent see-through. The acrylic look is now
    // drawn entirely in CSS on an opaque window, stable on Win10 and Win11.
    #[cfg(not(desktop))]
    let win = win;

    #[cfg(desktop)]
    let win = win
        .center()
        .inner_size(800.0, 600.0)
        .theme(None)
        .title({
            #[cfg(target_os = "macos")]
            {
                ""
            }
            #[cfg(not(target_os = "macos"))]
            {
                "AMLL Player"
            }
        })
        .visible({
            #[cfg(target_os = "macos")]
            {
                true
            }
            #[cfg(not(target_os = "macos"))]
            {
                false
            }
        })
        .decorations({
            #[cfg(target_os = "macos")]
            {
                true
            }
            #[cfg(not(target_os = "macos"))]
            {
                false
            }
        });

    #[cfg(target_os = "macos")]
    let win = win.title_bar_style(tauri::TitleBarStyle::Overlay);

    win
}

pub async fn recreate_window(app: &AppHandle, label: &str, path: Option<&str>) {
    info!("Recreating window: {}", label);
    if let Some(win) = app.get_webview_window(label) {
        #[cfg(desktop)]
        {
            let _ = win.show();
            let _ = win.set_focus();
        }
        #[cfg(not(desktop))]
        let _ = win;
        return;
    }
    #[cfg(debug_assertions)]
    let url = {
        tauri::WebviewUrl::External(
            app.config()
                .build
                .dev_url
                .clone()
                .unwrap()
                .join(path.unwrap_or(""))
                .expect("Failed to create external URL"),
        )
    };
    #[cfg(not(debug_assertions))]
    let url = tauri::WebviewUrl::App(path.unwrap_or("index.html").into());
    let win = create_common_win(app, url, label).await;

    let win = win.build().expect("can't show original window");

    // PERF: the old code forced a 0x0 -> original size round trip here to work
    // around a first-paint bug of the transparent window. With an opaque window
    // and an inline first-paint background this is unnecessary, and it used to
    // trigger a full relayout/resize on every startup.
    #[cfg(desktop)]
    {
        let _ = win.set_focus();
    }
    #[cfg(not(desktop))]
    let _ = win;

    info!("Created window: {}", label);
}

#[tauri::command]
pub async fn open_screenshot_window(app: AppHandle) {
    recreate_window(&app, "screenshot", Some("screenshot.html")).await;
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn set_window_always_on_top(enabled: bool, app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_always_on_top(enabled).map_err(|e| e.to_string())
    } else {
        Err("Main window not found.".to_string())
    }
}
