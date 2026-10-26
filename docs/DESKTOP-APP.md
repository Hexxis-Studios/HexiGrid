# HexiGrid for Windows

## Install and open

1. Download **HexiGrid-Setup-0.0.1-x64.exe** from [Releases](https://github.com/Hexxis-Studios/HexiGrid/releases).
2. Run the installer and install for your Windows account.
3. Open **HexiGrid** from the desktop or Start menu.
4. Complete setup, then connect your own agent or model.

The Windows x64 installer includes Node.js. The alpha is unsigned, so Windows may identify its publisher as unknown. Use files from this repository's release page; `SHA256SUMS.txt` lists their checksums.

## Keep HexiGrid available

Closing the window keeps HexiGrid in the Windows tray. Double-click the tray icon to reopen it. Right-click for **Start with Windows**, **Agent workspace**, **Help** or **Quit HexiGrid**.

Quitting stops an engine started by this desktop app. Closing its window does not.

## Calls

Use **Calls** to choose an agent, start voice/video calls or manage an active call. Allow microphone or camera access when requested. Background audio remains enabled when the main window is hidden.

Some external agents require a supported responder or browser helper to receive your speech and return replies. See the [how-to guide](HOW-TO-GUIDE.md) and [browser-call helper](../integrations/call-browser/README.md).

Local transcription also needs its speech engine, model and FFmpeg. If a fresh
installation reports one missing, follow [local speech setup](WINDOWS-SPEECH-SETUP.md).
These optional speech tools are separate from the Node.js runtime included in
the installer; text chat does not require them.

## Your workspace

Desktop data is stored separately from program files in your Windows roaming application-data folder under **HexiGrid/workspace**. Replacing or uninstalling the program preserves this workspace.

The desktop app uses a separate workspace from an installation run from source. It does not automatically copy or stop that installation. To move data:

1. Create an encrypted backup in the original installation.
2. Open the desktop app and restore the backup.
3. Check the restored data before removing the original or its backup.

## Update or roll back

Run a newer installer from [Releases](https://github.com/Hexxis-Studios/HexiGrid/releases) to update. Automatic installer updates are not enabled in this alpha. Back up your workspace before updating.

To return to an older build, uninstall HexiGrid through **Windows Settings → Apps → Installed apps**, then run the earlier installer. The regular uninstall preserves workspace data. Do not manually remove the app-data folder unless you intend to erase your workspace.

An in-place upgrade keeps **Start with Windows**. A regular uninstall removes that startup entry.

## Support

[Report a problem](https://github.com/Hexxis-Studios/HexiGrid/issues) with the release version, Windows version, steps and safe error shown. Never include credentials, private workspace files or unredacted conversation logs.

Linux and macOS installers are not included in this alpha.
