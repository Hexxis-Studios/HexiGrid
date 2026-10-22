# Google sign-in and encrypted Drive backup

Google is optional. HexiGrid works locally without a Google account.

## Connect

1. Open **Accounts & devices** or **Settings**.
2. Choose **Continue with Google**.
3. Pick your Google account in the popup.
4. Approve access to HexiGrid's private app-data folder.

That is the entire connection setup. Users do not create an OAuth client, paste a client ID, configure Firebase, or open Google Cloud Console.

## Back up

1. Enter a backup password of at least 12 characters.
2. Choose **Back up now**.
3. Keep the password somewhere safe. Google and HexiGrid cannot recover it.

HexiGrid encrypts the backup on the device before uploading it. The Drive permission is limited to HexiGrid's hidden app-data folder. It cannot browse ordinary Drive files. API keys and OS-vault credentials are excluded.

## Restore

Choose **Backup history**, select a version, enter its backup password, and approve the restore. Imported automation is paused for review and the previous local state remains available for rollback.

## Sign-in versus backup

Google proves which account is opening the local workspace. Backup is a separate, optional action. Signing in never uploads chats, memories, files, or settings by itself.

Official references: [Firebase Google sign-in](https://firebase.google.com/docs/auth/web/google-signin) and [Google Drive app-data folders](https://developers.google.com/drive/api/guides/appdata).
