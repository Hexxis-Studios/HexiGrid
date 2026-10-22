# Local data and optional Google Drive backup

## Default

Agent profiles, memories, chats, files, iLands metadata, model credentials, browser sessions, task runs, plugin records, receipts, and detailed audit history stay on the device. The local service binds to 127.0.0.1 unless the owner explicitly enables LAN mode.

When the operating-system credential vault is unavailable (for example a headless Linux container without Secret Service), HexiGrid still starts with authenticated local-state encryption using a locked local state key file. API keys, OAuth credentials, plugin secrets, and MCP secrets are disabled until the OS vault is restored; they are never written to ordinary application JSON. Existing encrypted state whose OS-vault key cannot be recovered is preserved and opened read-only so it cannot be overwritten accidentally.

## Sign-in and secrets

The local passcode protects the HexiGrid workspace and never leaves the device. Session cookies are HttpOnly, SameSite=Strict, and expire; Google OAuth uses a short-lived state cookie plus PKCE. Provider/API keys and OAuth refresh tokens are stored through the operating system credential vault; they are not written to prompts, logs, exports, analytics, or ordinary JSON state.

LAN mode requires an explicit pairing code, throttles failed pairing attempts, and issues a short-lived HttpOnly device cookie. It is intended for a trusted private network; the host keeps API-key entry on the computer rather than sending keys through a plain-HTTP phone page.

## Standalone browser vault

The standalone PWA does not require a desktop or Node.js process for direct-capable cloud APIs. The user creates a passcode of at least ten characters. Web Crypto derives a non-exportable 256-bit AES-GCM key from that passcode with PBKDF2-SHA-256, 600,000 rounds, and a unique 128-bit random salt. The encrypted state uses a new random 96-bit IV on every save and is stored in IndexedDB; the passcode and usable key exist only in memory while unlocked.

This protects provider keys, chats, profiles, and settings if someone copies the browser's stored files without the passcode. It does not protect an unlocked page, malware, a compromised browser/extension, screen or keyboard capture, a provider receiving the request, or a weak/forgotten passcode. There is no recovery backdoor. Downloaded encrypted backups exclude provider keys so a restored device asks for them again.

Direct provider requests use HTTPS, `credentials: omit`, no referrer, no cache, and no redirects. A failed network/CORS request does not cause a silent relay or expose the key elsewhere; the UI explains the provider-supported login, user-owned relay, or paired-host options only after that attempt fails.

## Encrypted backup

Local export and Google Drive backup encrypt the whole-app snapshot with an authenticated AES-256-GCM envelope derived from a user passphrase with scrypt. The versioned manifest binds the sanitized control-room state and every included private file by SHA-256. The snapshot includes profiles, rooms, chats, tasks, plugin metadata, settings, usage, activity, workspace files, user media, installed plugin files, canonical dated memory, and the reconstructible local RAG index. OS-held provider keys, model artifacts, sync staging, temporary transcription files, runtime locks, sessions, and ephemeral audio/video are deliberately excluded, so a restored device asks the owner to enter or pair secrets again.

Optional scheduled local snapshots are off by default. When enabled by the owner, the passphrase is kept only in the operating-system credential vault and encrypted files are written atomically with owner-only access to the owner's Documents backup folder. Restore requires explicit owner confirmation and complete manifest verification before live state is changed.

Google receives only the encrypted envelope in its private `drive.appdata` area. Firebase keeps the Google sign-in session in the browser; the short-lived Drive access token remains in memory and is never written to HexiGrid state. The backup password is not uploaded or saved by HexiGrid. Losing it makes the ciphertext unrecoverable; that is the cost of keeping cloud storage unable to decrypt the backup.

## Optional agent email

The Live page can use a separately approved Google Mail connection to message an agent at the working email saved in that agent's local profile. HexiGrid requests only Gmail read and send scopes after the user presses an email action. Its short-lived Mail token remains in page memory, is kept separate from the Drive token, and is cleared on disconnect or authorization failure.

Reply checks ask Gmail only for recent messages from the selected agent's exact address. Message text enters the temporary live transcript; it is persisted only when the user chooses **Save transcript**. Email receipts record the agent, action, result, and time but never the message body, OAuth token, or pairing code. The agent's own password is never requested or stored.

## Storage and cost boundary

The Google Drive file belongs to the user’s Google account and uses that account’s storage/quota. HexiGrid does not buy storage, upload readable data, or use a central private database. If Google is unavailable, local operation continues.
