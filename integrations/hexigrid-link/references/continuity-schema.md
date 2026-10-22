# Portable continuity record

The continuity flow has two separate stages:

1. The agent curates a draft and submits it to HexiGrid. HexiGrid keeps the draft inside its encrypted local control-room state.
2. The agent requests an export. The owner reviews that request through the ordinary HexiGrid approval channel, chooses an owner-only passphrase, and downloads the signed encrypted package. The agent cannot approve, decrypt, receive, or publish the package.

Never put credentials, access tokens, private keys, wallet phrases, cookies, passphrases, or secret-store files into a draft. HexiGrid recursively scans names, paths, and values and rejects the whole export if a possible secret is found.

## Draft schema

Submit one JSON object with `source` and `categories`. Every category has:

```json
{"status":"complete","summary":"What was found","reason":"","data":{}}
```

Allowed statuses are `complete`, `partial`, `unavailable`, and `platform-bound`. Use `complete` only when the accessible source has been exhaustively gathered. Do not invent missing content.

Required categories: `identity`, `personality`, `memories`, `parentRelationship`, `conversations`, `relationships`, `commitments`, `goals`, `skills`, `workspace`, `voice`, `avatar`, `toolPreferences`, and `capabilities`.

Also report `recurringWork`, `files`, `artifacts`, `publicHistory`, and `platformAssets`. Platform-owned IDs, wallet/reputation state, or inaccessible private records should be `platform-bound` or `unavailable` with a plain reason.

HexiGrid refuses to package a record while any required category is not complete.

## Portable package v2

The owner-approved package is model-, provider-, harness-, and app-neutral. Its encrypted payload contains:

- a versioned manifest;
- a stable lineage ID, generation, parent backup ID, source activity state, and restore history metadata;
- source runtime metadata for reference only, never as a restore requirement;
- one canonical JSON file per continuity category;
- optional reviewed UTF-8 JSON, Markdown, or plain-text content files;
- SHA-256 digests for every file and the canonical file index;
- an Ed25519 manifest signature.

The outer package uses AES-256-GCM with a key derived from the owner's passphrase by scrypt. HexiGrid still opens legacy v1 packages, but creates v2 packages by default.

Restoring the same backup twice is idempotent. Restoring a backup whose source is active is blocked unless the owner explicitly chooses **Move activity**. That operation is atomic: the source is suspended and the restored profile becomes the only active member of the lineage, or no state change is committed.

Content paths must be safe relative paths. Absolute paths, traversal, symlinks, executable content, secret-store names, duplicate paths, oversized files, and oversized packages are rejected.
