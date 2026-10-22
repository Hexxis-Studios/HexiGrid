# Windows incoming-call notifications

On Windows 10/11, HexiGrid presents an incoming call as a Windows toast with **Allow** and **Deny** actions and the system notification sound. The app does not open a page, raise its window, or move focus when the toast appears or when an action is selected. When the Windows alert is sent, the in-page call dock also remains available; either control acts on the same call, so you only need to answer once. If the native notification path is unavailable, HexiGrid uses its in-app incoming-call prompt.

## Setup and controls

Packaged Windows installs register the HexiGrid Start Menu shortcut with the AppUserModelID and SnoreToast activator required for attributed toasts and button callbacks. The installer verifies both shortcut properties automatically; if registration fails, calls remain available in HexiGrid and the installer continues. Source checkouts can run `scripts/Install-HexiGrid-Launcher.ps1` after `npm ci` to create and register the shortcut for the local-engine launcher.

Windows owns banner and sound presentation. If HexiGrid banners or sound are off, or Windows Do not disturb / Focus Assist suppresses banners, the toast may appear only in Notification Center or may be hidden. Check **Settings → System → Notifications → HexiGrid** and Windows Do not disturb settings. Users can turn HexiGrid notifications off there. The in-app call dock remains an alternative while the owner page is open; HexiGrid shows a separate in-app prompt when it cannot send the native notification.

On the current owner Windows profile, `HKCU\Software\Microsoft\Windows\CurrentVersion\PushNotifications\ToastEnabled` is `0`. M603's packaged installer sets and verifies both Start Menu shortcut properties; an isolated installed shortcut also passed a read-only check. A visible banner and button click were not independently confirmed on this profile. HexiGrid leaves this OS-wide setting unchanged; after notifications are enabled in Windows Settings, retry the system-toast smoke test.

## Action and audio behavior

The toast contains only the paired caller's display name. Its action is bound to that notification's call ID. Before applying Allow or Deny, HexiGrid rechecks the exact current incoming call, active desktop session, connected Link, microphone and speaker grants, and current conversation policy. A stale or newly unauthorized action cannot accept a later call. Completed toast actions create the same human-readable call receipt as the in-app buttons.

Allow marks the call active and grants its existing session media channels. If the HexiGrid page is already open and the browser has previously granted microphone access, it attempts to start those devices without foregrounding the page. If browser device permission is missing or speaker playback requires a user gesture, the call stays accepted and the in-page dock explains how to enable/retry audio; the toast never opens a browser prompt or steals focus. Deny ends the call and pauses call audio.

The local HexiGrid engine and desktop-session authorization must still be running. This web app does not install a separate Windows service or capture audio when its browser media page is closed. Windows policy can suppress a toast, so keep HexiGrid's in-app dock available as the alternative; OS notification settings cannot be overridden by the app.
