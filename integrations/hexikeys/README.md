# HexiKeys — built-in private vault addon

HexiKeys stores passwords, keys, PINs and recovery information in a local encrypted vault. HexiGrid keeps OS-protected pairing material and selected references; it does not duplicate the saved values.

1. Open **Plugins & tools → HexiKeys → Open vault** and unlock the protected window.
2. Choose **Connect HexiGrid** in that window, then **Connect HexiKeys** in HexiGrid. Pair once on this computer.
3. For an installed plugin, choose **Use HexiKeys**, select its declared operation and the owner or exact owner-agent Link, and copy the nonsecret scope recipe.
4. Select a saved item in HexiKeys → **Share one field with HexiGrid**. Paste the recipe, review its destination and limits, then copy the generated reference ID back into HexiGrid.
5. Review and enable the plugin. Subsequent runs use the approved reference while the vault is unlocked. Agents receive only operation outcome metadata, never the saved value.

**Manage HexiGrid references** in the vault lists uses, expiry and revocation. Lock/close, revoke, Stop, expired limits and policy changes prevent further authorized use. An interrupted attempt may consume a use even when its remote outcome is unknown; it is not automatically retried.

Existing SimpleVault data stays in its original folder. New vaults use `%APPDATA%\HexiKeys`. A master password remains necessary to unlock the encrypted data. Keep an encrypted backup; a forgotten master password cannot be recovered.

## Agent-assisted saving

An authorized owner-agent can request a new-item form through `POST /agent-link/v1/addons/hexikeys/request-capture` with only `title`, `category` and `fieldLabel`. The equivalent local owner route is `/api/addons/hexikeys/request-capture`. Categories match the native editor: Password, API key, Token, Recovery phrase, Backup codes, License key, Secure note, Screenshot OCR, Other.

HexiKeys must already be paired and unlocked. The host supplies the requester identity and a short expiry. The existing native editor opens with one empty private field; the owner enters and saves the value there. `{opened:true}` means only that the form opened, not that an item was saved or an agent received a grant. Active drafts, lock, cancellation and unavailable vaults fail safely. This route never accepts a password/key value, screenshot, clipboard contents, path or caller identity. Sharing the saved item remains a separate exact field grant.

## Local build

`build.ps1` builds the Windows executable using the pinned no-cost Python dependencies. It writes `dist/HexiKeys.exe`; no vault data is included. Development can use `launch.ps1` after installing `requirements.txt` in a local Python environment. The parent repository's `scripts/vendor-hexikeys.mjs` updates this explicit source snapshot from the standalone app, excluding user data and build environments.

This integration is under acceptance. It currently supports declared HTTPS plugin credential headers (`Authorization` and `X-…`), not arbitrary login automation or bulk credential export. The standalone vault continues to store other secret types for the human. Secure automatic capture from issuers remains a separate unchecked gate.
