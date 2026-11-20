//! The notification-area icon: hovering it answers the question without
//! reopening anything, so it carries the live reading, not the app name.
use serde_json::Value;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Runtime};

pub struct Tray<R: Runtime> {
    pub icon: tauri::tray::TrayIcon<R>,
    pub always_on_top: CheckMenuItem<R>,
    pub minimize_to_tray: CheckMenuItem<R>,
    pub updates: MenuItem<R>,
}

fn format_tokens(n: f64) -> String {
    if n >= 1e9 { format!("{:.1}B", n / 1e9) } else if n >= 1e6 { format!("{:.1}M", n / 1e6) } else if n >= 1e3 { format!("{}k", (n / 1e3).round()) } else { format!("{}", n.round()) }
}

pub fn tooltip(payload: Option<&Value>) -> String {
    let mut lines = vec!["LLM Speedometer".to_string()];
    if let Some(d) = payload {
        if let Some(week) = d["sevenDay"]["percent"].as_f64() {
            lines.push(format!("Week: {:.0}% left", 100.0 - week));
        }
        if let Some(left) = d["budget"]["sevenDay"]["remainingTokens"].as_f64() {
            lines.push(format!("~{} tokens left this week", format_tokens(left)));
        }
        let rate = d["tokensPerMinute"].as_f64().unwrap_or(0.0).round() as i64;
        lines.push(format!("{} tok/min", rate.to_string().as_bytes().rchunks(3).rev().map(|c| std::str::from_utf8(c).unwrap_or("")).collect::<Vec<_>>().join(",")));
    }
    lines.join("\n")
}

/// Build the icon and its menu. Ids are what the app matches on.
pub fn create<R: Runtime>(app: &AppHandle<R>, always_on_top: bool, minimize_to_tray: bool) -> tauri::Result<Tray<R>> {
    let show = MenuItem::with_id(app, "show", "Show dashboard", true, None::<&str>)?;
    let pill = MenuItem::with_id(app, "pill", "Collapse to pill", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh now", true, None::<&str>)?;
    let aot = CheckMenuItem::with_id(app, "alwaysOnTop", "Always on top", true, always_on_top, None::<&str>)?;
    let mtt = CheckMenuItem::with_id(app, "minimizeToTray", "Minimise to tray", true, minimize_to_tray, None::<&str>)?;
    let updates = MenuItem::with_id(app, "updates", "Check for updates", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &pill, &PredefinedMenuItem::separator(app)?, &refresh, &aot, &mtt, &PredefinedMenuItem::separator(app)?, &updates, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main").menu(&menu).show_menu_on_left_click(false).tooltip(tooltip(None));
    if let Some(icon) = app.default_window_icon() {
        // Not a template image: this is a gauge face, mostly opaque, and
        // templating would collapse the dial to one filled disc.
        builder = builder.icon(icon.clone()).icon_as_template(false);
    }
    let icon = builder
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                crate::reveal_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(Tray { icon, always_on_top: aot, minimize_to_tray: mtt, updates })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_tooltip_carries_the_reading() {
        assert_eq!(tooltip(None), "LLM Speedometer");
        let t = tooltip(Some(&json!({ "sevenDay": { "percent": 18.4 }, "budget": { "sevenDay": { "remainingTokens": 158_722_651.0 } }, "tokensPerMinute": 6968.4 })));
        assert_eq!(t, "LLM Speedometer\nWeek: 82% left\n~158.7M tokens left this week\n6,968 tok/min");
        assert_eq!(tooltip(Some(&json!({ "sevenDay": { "percent": null }, "budget": {}, "tokensPerMinute": 0 }))), "LLM Speedometer\n0 tok/min");
    }
}
