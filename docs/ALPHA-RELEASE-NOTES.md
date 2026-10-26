# HexiGrid 0.0.1 alpha

For invited testers using Windows or the browser app. HexiGrid starts empty: connect your own agents or models and choose what each can access.

Start with [Set up HexiGrid, step by step](PLATFORM-SETUP.md). It explains the
basic terms, separate platform paths, image/voice setup and common errors.

## Downloads

Get the Windows installer or browser archive from [Releases](https://github.com/Hexxis-Studios/HexiGrid/releases). Checksums are in `SHA256SUMS.txt`.

- **Windows x64:** includes the runtime; Node.js is not required separately.
- **Browser archive:** static files for your own web server. HTTPS is required on another device. Desktop tools require a paired host.
- **Source:** Node.js 22 or newer. Follow the [README](../README.md).

## Included

- Local/cloud model connections, external-agent Links, agent profiles and chat rooms.
- Voice/video calls, configured avatars and additional agents on hold.
- Scoped memory with revision history, conditions, evidence and correction controls.
- Local files, bounded tasks, plugins, MCP tools, permissions and action receipts.
- Encrypted backup/restore, optional Drive backup and Windows startup.
- Human and agent interfaces, collapsible navigation and searchable help with screenshots.
- Durable native-agent onboarding and automatic coordination of approved desktop agents without manual handoffs.
- Separate beginner guides for existing agents, Muse, native iLands, local models, installed computer tools, voices and transcription.
- Screenshots that enlarge and close inside the app, and paired-agent removal with inline disconnect confirmation.

## Known limitations

- Windows installers are unsigned. Automatic installer updates are not enabled.
- Linux and macOS installers are not included.
- External agents need a supported way to receive call transcripts and return replies. Some need the browser-call helper. A model profile alone cannot answer calls on another service.
- The Muse Chrome helper may need one-time unpacked-extension installation and native-host registration. The experimental iLands Android adapter requires a configured host; an Android environment is not bundled or installed by pairing.
- Local Windows transcription needs the local speech engine, model and FFmpeg. These speech prerequisites are separate from the app runtime; missing prerequisites prevent transcription. Read the setup guide before relying on calls.
- Device access, voice availability, WebGPU and provider CORS rules depend on your setup.
- The standalone browser cannot run desktop programs or guarantee scheduled work after it closes. Pair a Windows host for those features.
- Desktop and source installations have separate workspaces. Move data with encrypted backup and restore.

Keep a backup before using important data. Read [Data and privacy](DATA-PRIVACY.md) before granting account or computer access.

## Report a problem

[Open an issue](https://github.com/Hexxis-Studios/HexiGrid/issues) with your release, platform, steps and safe error. Redact screenshots and never attach keys, passcodes, tokens, backups or private chats.
