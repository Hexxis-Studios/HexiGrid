# Set up local speech on Windows

Use this only if a call reports that its local speech engine, model or FFmpeg
is missing. An already working call does not need these steps again.

**Transcription** turns your microphone audio into words for the agent. It is
different from the voice that reads the agent's answer. Local transcription
runs on your PC; it does not need a paid speech account. The first setup needs
internet access to download software and a model.

## Choose your installation

### Windows desktop app

1. Find HexiGrid in the Start menu. Right-click it and choose **Open file
   location**. If this opens a shortcut, right-click the shortcut and choose
   **Open file location** again.
2. Open **resources**, then **engine**. This is the app's support-files folder.
   Do not move, delete or edit its files.
3. Click File Explorer's address bar, type `powershell`, then press Enter.
4. In that PowerShell window, run:

   ```powershell
   $env:HEXIGRID_DATA_DIR = Join-Path $env:APPDATA 'HexiGrid\workspace'
   ```

   This selects the standard desktop workspace. If you deliberately use a custom
   app-data folder, use its `workspace` folder instead. Do not point this at a
   different installation's data.

### Running from source

1. Open your HexiGrid source folder in File Explorer.
2. Click its address bar, type `powershell`, then press Enter.
3. The default workspace is that folder's `data` directory. If you start the
   server with a custom `HEXIGRID_DATA_DIR`, use that same value here.

## Install the speech tools

1. Run this command in the PowerShell window you opened above:

   ```powershell
   powershell.exe -NoProfile -File .\scripts\Install-Local-Transcription.ps1 -Model tiny
   ```

2. Wait for the downloads and hash checks to finish. `tiny` is the smaller model.
   For a larger model, use `-Model base` and select that installed model in
   HexiGrid's transcription settings. Larger does not guarantee perfect words.
3. If it reports **FFmpeg is required**, get a Windows build through the
   [FFmpeg download page](https://ffmpeg.org/download.html). FFmpeg prepares the
   recorded sound for recognition. Follow the build supplier's verification
   instructions; do not use a download from an advertisement.
4. Extract the Windows build. Copy `ffmpeg.exe` from its `bin` folder into
   `transcription\engine` inside the workspace selected above. Use a static
   build, or include the companion DLLs required by a shared build. Do not
   put it in a chat, a browser upload field or Windows' system folders.
5. Run the setup command again. It should report **Local transcription is ready**.
   The script checks downloaded engine/model hashes and reuses valid files.
   Do not bypass a failed hash check or change Windows' security settings.

The setup script uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp).
The speech detector may download its additional model when first used. Downloads
use disk space; transcription also uses your CPU while you speak.

## Check the whole conversation

1. Return to **Calls**, call a connected agent and allow microphone access.
2. Say one short sentence. Check **Transcript** for your actual words.
3. Check that the same agent receives the sentence and answers aloud.
4. Minimize HexiGrid and repeat while another app is in front.

If your sentence is visible but no answer arrives, speech recognition is working;
check the agent's responder or chat helper using the [platform guide](PLATFORM-SETUP.md).
Do not replace its Link or grant unrelated permissions.

If Windows blocks the script, stop and keep the exact error for support. Do not
turn off antivirus, change execution policy or paste commands from an unknown
helper. Redact private paths or conversations from a bug report. This alpha's
separate speech setup is not needed for text chat.
