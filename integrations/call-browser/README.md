# Connect Muse calls to a Chrome chat

Use this optional helper when your paired Muse agent needs a chat message to
receive your speech and answer. Choose the conversation calls should use once;
after that, use HexiGrid's normal **Call**, **Video** and **Accept** controls.
Your agent stays the same agent, with its own Link and available voice.

This alpha supports the tested Muse chat adapter. Installing it does not make
other websites compatible. It is not needed if your agent already has a working
call responder. Use only one delivery method to avoid duplicate messages.

## Before you start

- Pair the agent with HexiGrid and verify an ordinary Link request.
- Install Google Chrome and sign into Muse in the Chrome profile you want to use.
- Keep HexiGrid running on this PC. Set up [local transcription](../../docs/WINDOWS-SPEECH-SETUP.md)
  if it reports missing speech tools.
- This alpha uses a manually loaded extension; it is not a Chrome Web Store
  download. Use only the helper included with your verified HexiGrid release.

A **Chrome profile** is a separate browser identity with its own sign-ins and
extensions. The helper and Muse must be in the same profile. Signing into Muse
in a different profile will not connect them.

## 1. Prepare the connection on Windows

### Installed desktop app

1. In the Start menu, right-click HexiGrid and choose **Open file location**.
   If you see a shortcut, right-click it and choose **Open file location** again.
2. Open **resources**, then **engine**.
3. Click File Explorer's address bar, type `powershell`, and press Enter.
4. For the standard desktop workspace, run:

   ```powershell
   $env:HEXIGRID_DATA_DIR = Join-Path $env:APPDATA 'HexiGrid\workspace'
   & '..\runtime\node.exe' '.\scripts\prepare-call-browser.mjs' --register
   ```

   If you deliberately use a custom app-data folder, select its `workspace`
   folder instead. Do not select another installation's workspace.
5. Keep this folder open. The command reports the extension folder and
   `registered:true`. The desktop download includes the helper runtime; a
   separate .NET installation is not needed for this path.

### Source installation

1. Open PowerShell in your HexiGrid source folder.
2. Install the [.NET 9 SDK](https://dotnet.microsoft.com/en-us/download/dotnet/9.0)
   if it is not already installed. This builds the helper locally.
3. Run `node scripts/prepare-call-browser.mjs --register`.
   If your server uses a custom `HEXIGRID_DATA_DIR`, use that same value here.
4. Confirm the result says `registered:true` and keep the reported extension
   folder path. Do not paste private workspace files into chat for help.

Registration connects Chrome to the small helper on your PC for your Windows
user. It does not sign into Muse or give an agent new permissions. If it fails,
keep the safe error instead of repeatedly creating agent invitations.

## 2. Add the Chrome extension once

1. In the Chrome profile containing your Muse sign-in, open **Extensions →
   Manage extensions**.
2. Turn on **Developer mode**. This allows loading the local extension folder;
   it does not require disabling browser security.
3. Choose **Load unpacked** and select `integrations\call-browser\extension`
   inside the app's `resources\engine` folder, or inside your source folder.
   Select the folder containing `manifest.json`, not an individual file.
4. Find **HexiGrid Call Chat** in Chrome's Extensions menu. Pin it if you want
   an easy-to-find button.

Do not load a replacement sent by a stranger or disable certificate checks.
After an app update, reload the extension if Chrome reports its files changed.

## 3. Choose the conversation

1. Open the Muse conversation you want calls to use. A dedicated Calls chat or
   the main conversation can be selected; choose deliberately.
2. Open **HexiGrid Call Chat** from Chrome's Extensions menu.
3. Choose the matching paired **Agent**. Set a recognizable **Call chat name**.
4. Choose **Use this chat for calls**. Approve Muse site access if you want to
   connect this conversation.
5. Confirm it says **Connected**. Keep that chat available during calls.

To change the chat, repeat these steps on the new conversation. To stop this
route, use **Disconnect call chat** in the helper. Removing the Chrome extension
also stops its delivery. Revoking the agent's Link stops its signed access.

## 4. Test one sentence

1. Start or accept a call in HexiGrid.
2. Say a short sentence. Check it appears in the selected Muse conversation.
3. Wait for the agent's answer and confirm you hear it.
4. Minimize Chrome and repeat while another app is in front.

If speech appears in HexiGrid's transcript but not in Muse, check the helper,
Chrome profile and selected chat. If it reaches Muse but no answer arrives,
check the agent's call responder. If an answer arrives without sound, check
volume, output device and the call's playback notice. Do not replace the Link
to fix an audio-device problem.

## Privacy and delivery limits

Your spoken text is sent to the selected Muse conversation. Treat it like a
message you typed there. Microphone access and effective agent permissions
still apply. Credentials remain in the OS vault/native helper, not the web page
or extension. Browser cookies are not copied.

The helper does not overwrite an existing draft. If it cannot tell whether a
message was sent, it does not automatically send it again. Check the transcript
before retrying. A submitted message does not prove the agent answered or that
sound played. End, mute and revocation prevent pending call turns from being sent.

## Technical references and attribution

The helper uses Chrome Manifest V3 Native Messaging, .NET 9 and the existing
local call/transcription paths. No new paid service is required.

- [Chrome Native Messaging documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Google's native messaging example](https://github.com/GoogleChrome/chrome-extensions-samples/tree/f29c6f8682397ad737142669770a2b90544d186b/_archive/mv2/api/nativeMessaging),
  revision `f29c6f8682397ad737142669770a2b90544d186b`. Repository Apache-2.0;
  archived sample files have BSD-style headers. Used as a reference; no source copied.
