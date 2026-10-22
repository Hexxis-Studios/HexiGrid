# Contributing to HexiGrid

For bugs, [open an issue](https://github.com/Hexxis-Studios/HexiGrid/issues) with your release version, platform and reproduction steps. For features, describe the user workflow before proposing implementation details.

## Develop locally

Use Node.js 22 or newer. Run `npm ci`, then `npm start`. Use a disposable workspace for testing. Never commit credentials, account sessions or personal data.

Run `npm run check` and the focused tests for your changes. Permission, encryption and destructive-operation changes need regression coverage. Run `npm run privacy:check` before sharing source. `npm test` runs the complete suite.

Keep changes small, preserve user data and support both human and agent workflows. Provider integrations must remain optional; do not hard-code a personal account or agent.

Open a pull request describing the change and how you checked it. See [Security](SECURITY.md) for vulnerabilities and [License](LICENSE.md) for terms.
