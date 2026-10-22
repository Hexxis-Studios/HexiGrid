# Plugin package format and security model

HexiGrid plugins use manifest schema version 2. Legacy JavaScript bundles are quarantined and cannot be enabled. A plugin package is installed as an immutable, content-addressed directory. HexiGrid verifies the manifest and every file before enablement and before every run.

## Minimal package

Place `plugin.json` beside every file used by the plugin:

```json
{
  "schemaVersion": 2,
  "id": "notes-helper",
  "name": "Notes helper",
  "version": "1.0.0",
  "entry": "plugin.mjs",
  "capabilities": [
    {
      "id": "summarize-note",
      "label": "Summarize a note",
      "risk": "low",
      "inputSchema": {
        "type": "object",
        "properties": { "path": { "type": "string", "maxLength": 180 } },
        "required": ["path"],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "properties": { "summary": { "type": "string", "maxLength": 12000 } },
        "required": ["summary"],
        "additionalProperties": false
      },
      "permissions": {
        "files": { "readRoots": ["notes"], "writeRoots": [] },
        "network": []
      },
      "limits": {
        "timeoutMs": 10000,
        "memoryMb": 64,
        "outputBytes": 65536,
        "requestBytes": 262144,
        "brokerRequests": 20,
        "concurrency": 1
      }
    }
  ]
}
```

```js
export const capabilities = {
  "summarize-note": async ({ path }, { hexigrid }) => {
    const note = await hexigrid.files.readText(path);
    return { summary: note.slice(0, 500) };
  }
};
```

File roots are workspace-relative directory boundaries. Network rules declare an exact HTTPS origin, allowed methods, and path boundary. Direct filesystem, networking, child-process, worker, native-addon, environment, inspector, and dynamic package access is denied. All permitted file and network operations use the `hexigrid` broker and create receipts.

## Broker APIs

- `hexigrid.files.readText("declared-root/file.txt")`
- `hexigrid.files.writeText("declared-root/file.txt", "content")`
- `hexigrid.network.request({ url, method, headers, body })`

Plugins cannot set credential-bearing headers such as `Authorization`, `Cookie`, or `X-API-Key`. Declare credentials at the top level and map them into a network rule. The owner enters values through Plugins & tools; HexiGrid stores them in the operating-system vault and inserts them only into the outbound broker request.

```json
{
  "secrets": [{ "id": "api-token", "label": "API token", "required": true }],
  "permissions": {
    "files": { "readRoots": [], "writeRoots": [] },
    "network": [{
      "origin": "https://api.example.com",
      "methods": ["POST"],
      "pathPrefix": "/v1/jobs",
      "secretHeaders": [{ "header": "authorization", "secret": "api-token", "prefix": "Bearer " }]
    }]
  }
}
```

## Signing and publisher trust

Unsigned packages are supported for local development only after the owner explicitly confirms that they created or reviewed the files. Distributed packages should use an Ed25519 publisher signature.

1. Add `"publisher": { "id": "publisher-id", "name": "Publisher name" }` to the source manifest.
2. Keep the Ed25519 private key outside the repository. `.pem` and `.key` files are ignored by this repository.
3. Build a new signed output directory:

```powershell
npm run plugin:package -- C:\path\to\plugin C:\private\publisher-key.pem C:\output\notes-helper-1.0.0
```

The packager creates a canonical SHA-256 inventory, content digest, public key, and Ed25519 signature. On first install, HexiGrid shows the publisher fingerprint. Trust is pinned in the OS-backed vault and can be revoked from the plugin card; revocation quarantines every installed package signed by that publisher.

## Quarantine and recovery

A plugin is disabled and quarantined when its manifest, inventory, file bytes, install path, symlink state, signature, or trusted publisher key changes. Quarantined code never starts. Reinstall a known-good package to recover; do not edit installed files. Restoring a backup also disables plugins until the owner reviews and re-enables them.
