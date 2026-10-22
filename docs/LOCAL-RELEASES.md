# Local release recovery

HexiGrid's stable Windows launcher can select an already-prepared local release and return to the preceding selected release. Selection applies on the next engine startup. It does not stop a running engine, restart Codex, download a release or change the signed Door's permissions.

## Folder layout

The existing application folder stays the manager root. Its Start Menu shortcut and scheduled watchdog continue to use `Start-Control-Room.ps1` there. Prepared releases live below `releases/<id>`. Private state stays in the manager's `data` folder, or the owner's existing `HEXIGRID_DATA_DIR`; release selection never moves it.

`release-selection.json` contains only registered release IDs, versions and source digests, plus the active and previous IDs. Release folders and selection metadata are excluded from Git. The local owner can inspect the selected release without executing it:

```powershell
node scripts/manage-local-releases.mjs resolve --root .
```

## Prepare trusted local source

From the reviewed source folder, prepare a new, unused release ID:

```powershell
node scripts/prepare-local-release.mjs --root . --id reviewed-a --install-dependencies
```

This uses the installed npm pack tool and OS tar tool, includes the package lock, and installs production dependencies with lifecycle scripts disabled. Dependency installation may download from the package registry; no paid service is required. npm runs with separate empty user/global configuration and an isolated cache, without account credentials. Omitting `--install-dependencies` produces source only and reports `prepared: false`; that folder cannot yet be selected. The operation never registers, activates or starts a release. It refuses existing destinations and cleans only its own staging directory on failure.

Review the prepared folder before registration. Preparation accepts trusted local source, not downloaded or arbitrary archives. Private data, credentials, environment files and the source's node_modules are excluded.

## Select a prepared release

Use an owner-reviewed source folder with dependencies already installed. The source must be exactly the managed release folder. Registering it checks package identity, Node requirements, required files, private-data exclusion and the current source digest. It does not copy or run the source.

```powershell
node scripts/manage-local-releases.mjs register --root . --id reviewed-a --source ./releases/reviewed-a
node scripts/manage-local-releases.mjs activate --root . --id reviewed-a --confirm
```

Keep a registered baseline release before selecting an update. Once a second release is selected, the preceding selected release is available for rollback:

```powershell
node scripts/manage-local-releases.mjs rollback --root . --confirm
```

A missing, modified or unsafe release fails validation without changing selection. There is no automatic fallback to unreviewed code. If selection changes while an engine is running, that engine continues; the stable launcher refuses to mistake the old process for the newly selected source. Coordinate a normal HexiGrid-only shutdown before the next startup. Neither the selector nor launcher closes Codex or other applications.

## Settings controls

On the local computer, open **Settings → Choose your local version → Load version status**. Choose a registered version and confirm **Use on next startup**, or confirm **Return to previous selection**. **Add a prepared version** registers the exact reviewed folder ID. Changes require Build mode and the same owner policy as other local code changes. This interface never changes the work mode or starts/stops software for you.

Machine callers with the local owner session can read `GET /api/local-releases` and use `POST /api/local-releases/register`, `/activate`, or `/rollback`. Register/activate accept `{id, confirm:true, approved:true}`; rollback accepts `{confirm:true, approved:true}`. Reads return `{activeId,previousId,releases:[{id,version,digest}],appliesOn:"next-startup"}`; changes return `{result,status}`. The server derives every managed path and rejects path/root overrides. Browser CSRF and loopback owner checks apply. These are owner APIs, not public Link APIs; an owner-authorized agent with local system access can use the existing CLI within its grants.

## Component choice and limits

### Offline migration data recovery

Run from the reviewed HexiGrid installation as the owner:

```powershell
node scripts/recover-local-migration.mjs status --data-dir .\data
```

Status reads metadata only and works while HexiGrid is running. It reports the current/checkpoint versions, availability, whether an engine must be stopped, and whether a writer lock is present. Existing version2 workspaces do not acquire a historical version1 checkpoint retroactively.

To recover data, first stop HexiGrid and its independent watchdog through the normal owner controls. The command never stops processes, changes startup settings, switches source versions, or steals a writer lock. If a stale lock remains after a crash, verify its process is gone and review that exact data-folder lock before retrying; recovery deliberately leaves it intact.

```powershell
node scripts/recover-local-migration.mjs restore --data-dir .\data --confirm
node scripts/recover-local-migration.mjs undo --data-dir .\data --confirm
```

Use one operation at a time. Restore replaces the whole local state with the exact pre-migration snapshot, including its earlier settings; it first saves the displaced state to a separate encrypted `.migration-undo-point`. Undo restores that displaced state even after ordinary saves. The backup `.restore-point` and pre-migration point remain separate. Both operations require the existing local-state key, reject unsupported/corrupt snapshots, and refuse an active writer. Select compatible reviewed source separately before restarting. No automatic data rollback or universal historical-release compatibility is implied. An agent may use the existing authorized machine/terminal path within its granted policy; no public signed recovery endpoint or additional grant is created.

Startup refuses malformed or future application-state versions before normalization or migration. Before the existing legacy version1-to2 migration, it writes the exact original payload to `data/control-room.json.migration-point`, encrypted with the existing local-state key. Routine saves and backup import/undo use separate files and leave this point intact. It is not a portable export or automatic source rollback; preserve the OS vault and stop the engine before any owner-approved data recovery. A later actual legacy migration replaces the point with its own original payload. This does not certify every historical release's data compatibility.

This small selection layer reuses the repository's launcher and runtime fingerprint, and Node's existing filesystem primitives. The upstream runtime is Node.js, distributed under its MIT license and bundled third-party notices; inspected local runtime is reported by `node --version`. The design uses exclusive file creation, a flushed temporary file and replacement rename as documented in the [Node filesystem API](https://nodejs.org/docs/latest-v24.x/api/fs.html). No external updater or archive parser is added to selection.

The digest detects changes in the existing runtime fingerprint's file set; it is not a publisher signature or verification of every dependency byte. Releases are owner-reviewed local code. An interrupted operation may leave its exclusive lock: inspect whether a release command is still running before manually removing that exact lock. No time-based lock stealing occurs. This component does not prove power-loss durability, automatic migration rollback, Windows reboot acceptance or a packaged installer. Persistent data migrations must retain their own compatibility and recovery guarantees before selecting older code.
