# HexiGrid

Connect your AI agents, talk with them, manage their access and keep your chats and memories on your own device.

HexiGrid works with local models, compatible cloud providers and agents connected through a HexiGrid Link. Bring your own agents and choose what each can access. No paid HexiGrid account is required.

**Windows and browser alpha · available to invited testers.**

**New here?** Follow [Set up HexiGrid, step by step](docs/PLATFORM-SETUP.md).
It explains the words used in the app and gives separate paths for iLands,
Muse, Codex, Claude Code, OpenCode, local models, images and voices.

## Download

Open [Releases](https://github.com/Hexxis-Studios/HexiGrid/releases) and choose:

| Download | Use it for |
| --- | --- |
| **HexiGrid-Setup-0.0.1-x64.exe** | Windows 10/11, 64-bit. Includes the runtime; no separate Node.js installation needed. |
| **HexiGrid-Browser-0.0.1.zip** | Hosting the browser app on your own HTTPS site. Desktop tools need a paired Windows host. |
| **Source code** | Running locally from source or contributing changes. Requires Node.js 22 or newer. |

The Windows installer is unsigned. Download only from this repository's release page; `SHA256SUMS.txt` lists the file checksums. Linux and macOS installers are not included in this alpha.

## Start on Windows

1. Run the installer, then open **HexiGrid** from your Start menu.
2. Complete first-run setup and create a local passcode.
3. Open **Agents → Connect or create** to connect an existing agent or create a new profile.
4. Follow the connection instructions. For a local model, open **Settings → Connections → AI providers** and choose your model app or a supported on-device model.
5. Open **Chat** to talk, or **Calls** to call a connected agent.

An agent on another service needs that service's supported connection or call responder. A model profile alone does not make an external service receive calls. The setup guide explains each connection's requirements.

Closing the desktop window keeps HexiGrid in the Windows tray. Use **Quit HexiGrid** from the tray menu to stop it. See the [desktop guide](docs/DESKTOP-APP.md) for startup, updates and moving a workspace.

## Find your way around

| Section | What you can do |
| --- | --- |
| **Home** | Check your workspace and recent activity. |
| **Agents** | Connect agents, edit profiles and manage access. Remove a paired agent and disconnect it in the same confirmation. |
| **Chat** | Talk with one agent or bring several into a room. |
| **Calls** | Use voice/video calls and switch between agents on hold. |
| **Memory** | Read, correct, organize and share memories within the access you grant. |
| **Workspace** | Work with local files and tasks. |
| **Settings** | Manage connections, models, usage, tools, permissions, backups and help. |

The in-app **Help** includes searchable walkthroughs and screenshots. Start with the [how-to guide](docs/HOW-TO-GUIDE.md). Agents use the [agent integration instructions](docs/AGENT-INTEGRATION-PROMPT.md) and the live agent interface served by your app.

An existing agent stays in its own app when paired. Creating an agent inside
HexiGrid uses a model connection you choose. Importing an agent record is an
optional data import; it is not required for ordinary pairing.

## Run in your browser from source

Install [Node.js 22 or newer](https://nodejs.org/en/download) and Git, then run:

```sh
git clone https://github.com/Hexxis-Studios/HexiGrid.git
cd HexiGrid
npm ci
npm start
```

Open [http://127.0.0.1:4318](http://127.0.0.1:4318). The workspace starts empty; connect your own agents and models.

For the browser-only archive, extract it and follow its included README. It needs a web server; opening `index.html` directly is not supported. Direct cloud connections depend on the provider allowing browser requests. See [secure network setup](docs/SECURE-NETWORK.md) for another device.

## Your data and access

- Chats, memories, files and settings stay on your device by default.
- Connecting a cloud model sends the context needed for that request to your chosen provider.
- Google sign-in and Google Drive backup are separate choices. Drive backup must be enabled explicitly and encrypts the backup before upload.
- Desktop credentials use the operating system's protected vault. The standalone browser app uses its encrypted browser vault.
- Agents act within their granted permissions and the current work mode. You can revoke a connection.
- Desktop and source-based installations have separate workspaces. Use encrypted backup and restore to move data.

Read [Data and privacy](docs/DATA-PRIVACY.md) and [Trust modes](docs/TRUST-MODES.md) before granting computer or outside-service access. Keep an encrypted backup before testing with important data.

## Alpha testing and support

Read the [release notes and limitations](docs/ALPHA-RELEASE-NOTES.md). Device permissions, voices, WebGPU and providers vary by setup. Optional provider services may charge their own fees.

[Report a problem](https://github.com/Hexxis-Studios/HexiGrid/issues) with your build, Windows/browser version, steps and the safe error shown. Redact screenshots. Never attach passcodes, keys, tokens, backups, private chats or full workspace logs.

To contribute, read [Contributing](CONTRIBUTING.md). Report vulnerabilities using [Security](SECURITY.md).

## License

See the [license](LICENSE.md), [commercial licensing terms](COMMERCIAL-LICENSE-TEMPLATE.md) and [third-party notices](THIRD-PARTY-NOTICES.md). Licensing questions: [contact.hexigrid@proton.me](mailto:contact.hexigrid@proton.me).
