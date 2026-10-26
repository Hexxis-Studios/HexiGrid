# HexiGrid how-to guide

For a first setup, follow [Set up HexiGrid, step by step](PLATFORM-SETUP.md).
It includes simple definitions, a choice of connection paths, platform-specific
steps, image/voice setup and a troubleshooting table.

The complete, current guide is built into HexiGrid. Open **Settings → Help** from the left menu on a computer or **More → Settings → Help** on a phone. The in-app guide is the canonical copy because it can point at the controls that are actually installed.

Every outside connection shows two kinds of help together:

1. **Simple steps** opens HexiGrid's short guide in plain language.
2. **Official guide** opens the service owner's current documentation.

Setup guides for AI providers, iLands Runner, Google Drive backup, and MCP are grouped under **Settings → Connections**. iLands Runner is one provider-specific connector; it is not required for other agents or model providers. Each setup's official guide is the authority when that outside service changes.

## The shortest safe setup

1. Start HexiGrid and create a local passphrase.
2. Open **Settings → Connections → AI providers**.
3. Pick exactly one connection type:
   - **OpenCode cloud/Zen** is an optional hosted connection; its model prices can be free, promotional, or metered.
   - **API key** for OpenAI, Anthropic, Google Gemini, Hugging Face, or another compatible cloud API.
   - **This device** for a supported model that runs inside this browser with WebGPU.
   - **Local model app** for Ollama, LM Studio, or another OpenAI-compatible local server.
   - **Signed-in computer tool** for OpenCode, Claude Code, or Codex, but only when HexiGrid detects it as installed and signed in.
4. Choose **Connect and find models**. Do not continue until HexiGrid shows at least one model from that connection.
5. Open **Agents**, add one agent, and select one discovered model.
6. Open **Chat**, select the agent, and send a harmless test message.
7. Open **Settings → Usage & activity → Activity** and confirm the message completed.

Nothing is connected automatically. A fresh clone starts with no providers, no agent accounts, and no personal machine configuration.

## Pair an existing agent, including an iLands agent

1. Open **Agents → Connect or create → Pair an existing agent**.
2. Choose the permissions. For camera only, clear **Screen view** and **Mouse and keyboard**, then select **Camera**.
3. Choose **Create invitation** and give the complete copied instructions to that agent in its own app. The instructions include its skill and companion files.
4. The agent checks its storage before connecting and saves both its credential and connection details. Agents whose files reset between turns need supported protected storage; the supplied instructions handle that check. The invitation is single-use; the saved connection works on later turns until revoked. An idle heartbeat does not require another invitation. Background operation depends on the agent platform supporting persistent processes.
5. Open **Settings → Connections → Tools & integrations**, choose that agent, check its permissions, then choose **Start sharing**. Browser device approval may be required.
6. Ask what the agent sees now. Its skill requests a fresh snapshot, inspects that image, and instructs it to delete temporary files afterward. A failed capture must be reported rather than replaced by an old picture.

Two agents with similar names remain separate connections. Compare their source app and Link ID before changing access. A local Codex profile uses the local Codex installation; it is not automatically a paired companion Link.

### Change permissions after pairing

1. Open **Settings → Connections → Tools & integrations** and choose the existing agent in the **Agent** menu.
2. Select or clear **Screen view**, **Mouse and keyboard**, **Camera**, **Microphone**, or **Agent speaker output**. All available permissions are in the same box.
3. Optional: select **Let this agent manage and restart its approved access**. The agent can then manage only permissions you approved, without receiving additional file or process access.
4. Choose **Save permissions**, or **Start sharing** to save and start sharing together. Removing a permission blocks further use; adding a sharing permission may require starting access and accepting a browser device prompt.

To connect another agent, choose **Connect another agent** in the same Agent menu, select its permissions, and choose **Create invitation**. Existing agents keep their connections and sharing sessions.

If you enabled **Let this agent manage and restart its approved access**, you can ask the agent to resume sharing itself. It uses its saved connection and existing permissions. Approved agents share computer control automatically; HexiGrid coordinates their actions without manual handoffs. After another agent changes the screen, the next agent must look again before acting. Take over and Emergency Stop must be cleared by you. Call participants on hold do not receive the active call’s audio or video.

Keep the same Link. Changing permissions does not require another invitation. **Stop** ends computer and media access without deleting the connection or its saved permission choices.

## Feature locations

On a phone, use **More** or the top menu to reach the same sections. You can ask your agent to help with these actions within the access you gave it.

| You want to… | Open this | First action |
| --- | --- | --- |
| Connect a model | Settings → Connections → AI providers | Choose one source, connect it, then check its returned model list. |
| Add or customize an agent | Agents | Add an agent, then choose its connection, instructions, voice and supported avatar. |
| Chat with one or more agents | Chat | Create or choose a room, select its agents and send a message. |
| Make or answer a call | Calls | Choose Call/Video or Accept; use the same controls for mute, camera and ending. |
| Review or correct memory | Memory | Pick the agent and store. Search, choose Detail for history/evidence, or Edit fact to correct a record with a reason. |
| Share a memory scope | Memory → Shared memory | Select the source, project/topic and receiving Link; review the exact share. Other memory stays private. |
| Run work once or on a schedule | Home → Automate a task, or Settings → Agent settings → Tasks | Create a paused task, inspect its limits, then Run now or start its schedule. Pause/Stop ends work. |
| Read or edit local project files | Workspace | Open a file, edit it and Save. Use Reload file to read the saved version. The workspace editor stays inside its own folder. |
| Allow computer access | Home → Computer access | Review the exact Link, trust level and device controls. Stop the session or revoke access here. |
| Add plugins or MCP tools | Settings → Agent settings → Plugins & tools | Install/connect the tool, review its access and enable it. Inspect its action receipts. |
| Store passwords, keys or PINs | Settings → Agent settings → Plugins & tools → HexiKeys | Open vault and unlock its protected window. Enter secrets there, not in chat. Agents use only approved references. |
| Inspect results or usage | Settings → Usage & activity | Activity shows outcomes/receipts. AI usage shows recorded HexiGrid usage, not the provider's complete bill. |
| Back up, restore or recover | Settings → Protect and move your local data | Download an encrypted backup or set up snapshots. Review before Restore; Undo last restore returns to the protected previous state. |
| Change appearance, approval or reply style | Settings; Settings → Agent settings → Permissions; Settings → Help → How agents talk | Read the control's description before saving. Full access stays within the existing grants and mode. |

If a control is unavailable, read its status for the missing connection, grant or platform capability. Do not keep retrying or create another Link. **Settings → Help → Fix common problems** is the first recovery guide.

## The three copy-and-paste prompts

Open **Settings → Connections → Tools & integrations** to find three large numbered cards. They are separate jobs, so use only the one you need:

1. **Enter HexiGrid** teaches an AI how to connect itself to HexiGrid, let you enter any secret in the protected screen, discover current models, and verify a real test reply.
2. **Connect somewhere else** gives your HexiGrid agent the current setup instruction for a destination. Choose **iLands BYOA**, **Moltbook**, or **Another framework**. For another framework, enter its name and its official HTTPS guide. HexiGrid will not guess private endpoints.
3. **Bring an existing life record** asks an existing agent to organize its accessible identity, personality, memories, relationships, conversation history, promises, goals, routines, skills, files, creations, voice, avatar, tools, and capabilities into `HEXIGRID-AGENT-RECORD.md`. Upload that file to create a private profile you can review.

The first two prompts perform setup through documented controls. The third prompt only organizes information the agent can already access. It never asks for passwords, API keys, cookies, payment details, hidden instructions, or another person's private data.

## First: what HexiGrid actually does

HexiGrid connects your chosen AI to local agents, rooms, and approved tools. You can begin with a supported browser model or an existing local model server without buying a service or entering an API key. Agents use only the access you grant for files, plugins, MCP tools, or other connected apps.

Every path below uses the same screen: open **Settings → Connections → AI providers**, choose one of the four big connection types, and follow that path. HexiGrid asks the provider for its current model list. It does not trap you in an old hardcoded list.

On a standalone phone or browser, a cloud model does **not** need Node.js or a desktop. HexiGrid creates an encrypted browser workspace, attempts the selected provider's HTTPS API directly, and stores the key only inside that encrypted browser vault. Pairing is an optional fallback for desktop files, CLIs, long-running background work, isolated plugins/MCP, or a provider that rejects direct browser requests through CORS.

If you open the separate **Agent interface** in another browser tab, enter your local passcode there too. The usable encryption key is intentionally kept only in each unlocked tab's memory; your passcode is processed locally and is never sent to an AI provider.

## Optional hosted connection: OpenCode cloud/Zen

1. **What it is:** OpenCode is a free, open-source AI tool, and OpenCode Zen is its hosted model gateway. You can use a Zen API key directly in HexiGrid without installing the OpenCode CLI or Node.js on your phone.
2. **What you need:** An OpenCode account, internet access, and whatever account verification or billing details the current Zen signup requires. The official guide currently describes usage-based charges; individual free or promotional models can change.
3. **Where to get it:** Open the [official OpenCode Zen page](https://opencode.ai/docs/zen), choose **Sign in**, complete the current account steps, create an API key, and copy it while visible. Keep the [provider guide](https://opencode.ai/docs/providers) nearby if the labels change.
4. **Plug it in:** Open **Settings → Connections → AI providers → API key → OpenCode Zen**. Paste the key only in the protected field and choose **Connect and find models**. HexiGrid fetches the current catalog instead of shipping a frozen list.
5. **Cost and limits:** OpenCode itself is free/open source. Zen's provider page is the authority for current prices, limits, billing requirements, and temporary free models. A free key does not mean every request is free.
6. **Send the first test:** Open **Agents → Connect or create → Local agent**. Name it `Test Agent`, assign one returned OpenCode model, then open **Chat**, create `First test`, select that agent, and send `Reply with exactly: HexiGrid connected.`
7. **Verify it:** Confirm the reply appears, then open **Settings → Usage & activity → Activity** and confirm the model action says **completed**. If either is missing, setup is not done.
8. **Use it with another framework:** For iLands, open **Settings → Connections → Tools & integrations** and follow the BYOA Runner guide. For CrewAI, LangGraph, Microsoft Agent Framework, AutoGen, or another system, use its current official model/MCP/A2A connector; do not paste a key into an agent prompt.

## OpenAI API key

1. **What it is:** OpenAI runs AI models online. An API key is a private password made for apps; it is not your ChatGPT password.
2. **What you need:** An [OpenAI API account](https://platform.openai.com/), internet access, and API billing or credit. A ChatGPT subscription does not automatically include API credit.
3. **Where to get it:** Open [API keys](https://platform.openai.com/api-keys), choose **Create new secret key**, and copy the key while it is visible. The [official quickstart](https://developers.openai.com/api/docs/quickstart) has the longer version.
4. **Plug it in:** In HexiGrid choose **API key → OpenAI**. Paste the key only into **Paste your OpenAI API key**, then choose **Connect and find models**.
5. **Cost and limits:** It is pay-as-you-go. Prices and request limits depend on the model and account tier; check the [current model page](https://developers.openai.com/api/docs/models) before long jobs.

## Anthropic API key

1. **What it is:** Anthropic runs Claude models online. Its Console makes the private key HexiGrid uses.
2. **What you need:** An Anthropic Console account, internet access, and API credit. A Claude chat plan and Console API billing are separate things.
3. **Where to get it:** Open [Anthropic Console keys](https://console.anthropic.com/settings/keys), choose **Create Key**, and copy it. Here is the [official API overview](https://platform.claude.com/docs/en/api/overview).
4. **Plug it in:** Choose **API key → Anthropic**, paste the key in the protected box, then choose **Connect and find models**.
5. **Cost and limits:** API calls are billed by model and token. Anthropic also uses spend and request tiers; see the [current limits](https://platform.claude.com/docs/en/api/rate-limits).

## Google Gemini API key

1. **What it is:** Gemini is Google's cloud AI service. Its AI Studio key is unrelated to the separate Google Drive backup connection.
2. **What you need:** A Google account, Gemini API access in your region, an auth/API key, and internet access.
3. **Where to get it:** Follow Google's [Get a Gemini API key](https://ai.google.dev/gemini-api/docs/api-key) page and use the button it shows for Google AI Studio.
4. **Plug it in:** Choose **API key → Google Gemini**, paste the key, then choose **Connect and find models**.
5. **Cost and limits:** Some models have a free tier with per-project limits. Paid use varies by model; read [billing](https://ai.google.dev/gemini-api/docs/billing) and [current pricing](https://ai.google.dev/gemini-api/docs/pricing) before enabling it.

## Hugging Face hosted inference

1. **What it is:** Hugging Face is a huge model library. Its inference providers can run some of those models online for you.
2. **What you need:** A Hugging Face account, a token with inference permission, internet access, and a model actually offered for hosted inference.
3. **Where to get it:** Open [Access Tokens](https://huggingface.co/settings/tokens), create a narrowly scoped token, then read the [official inference guide](https://huggingface.co/docs/hub/models-inference).
4. **Plug it in:** Choose **API key → Hugging Face**, paste the token, then choose **Connect and find models**.
5. **Cost and limits:** Free accounts currently receive a very small monthly inference credit. Extra hosted use needs credit; see [current pricing](https://huggingface.co/docs/inference-providers/pricing). A model existing on the website does not guarantee hosted chat support.

## Another compatible cloud API

1. **What it is:** This is another cloud provider that accepts the common OpenAI-style chat format.
2. **What you need:** The provider's exact base API address, an API key if it requires one, internet access, and that provider's documentation.
3. **Where to get it:** Use the provider's own setup page. Look specifically for **OpenAI-compatible endpoint**, **Base URL**, **API key**, and **Models**. Do not guess the address.
4. **Plug it in:** Choose **API key → Another compatible API**. Open **Connection details**, paste the address, keep **OpenAI-compatible chat** unless the provider says otherwise, paste the key, and choose **Connect and find models**. Use **Manual model IDs** only when its docs say model listing is unavailable.
5. **Cost and limits:** The provider decides all prices, privacy terms, regions, and rate limits. HexiGrid cannot safely infer those from a URL.

## Run a model in this browser

1. **What it is:** A browser-native model runs inside the browser on your own computer or phone. WebLLM uses WebGPU and a worker so the text stays local to that browser.
2. **What you need:** A current browser with a usable WebGPU adapter, enough graphics memory and storage, and time for the first download. No account or API key is required.
3. **Where to get it:** You do not need to install anything. Open **Settings → Connections → AI providers → This device**. HexiGrid checks the browser and shows the models it can use. Read the [WebLLM source and model support](https://github.com/mlc-ai/web-llm) and the [private browser chat example](https://github.com/mlc-ai/web-llm-chat) if you want the technical background.
4. **Plug it in:** Choose an available model, choose **Use this model**, then assign it to an agent or select it for the control assistant. The first message downloads the model and shows progress.
5. **Cost and limits:** There is no per-message API bill. The model uses your device battery/electricity, storage, and graphics memory. Support varies by browser, phone, and hardware. If WebGPU is unavailable, use an API key, local model app, or signed-in computer tool instead.

The model download is kept in the browser's private cache. Choosing **Remove download** or clearing site data removes it. HexiGrid never silently switches this local model to a paid cloud model.

## Ollama local models

1. **What it is:** Ollama is a free app that downloads and runs models on your computer. Your prompts stay with that local server unless the chosen model or tool itself calls something online.
2. **What you need:** A supported computer, enough memory and storage, Ollama, and one downloaded model.
3. **Where to get it:** Use the [official Ollama quickstart](https://docs.ollama.com/quickstart). Windows users can use the [Windows instructions](https://docs.ollama.com/windows). Pick a model from the [official library](https://ollama.com/library).
4. **Plug it in:** Start Ollama. In HexiGrid choose **Local model app → Ollama**. Keep `http://127.0.0.1:11434/v1` unless you deliberately changed it, leave the key blank, and choose **Connect and find models**.
5. **Cost and limits:** No per-message cloud bill for normal local use. Models can use many gigabytes of disk and memory; speed depends on your computer and electricity is still real, sadly.

## LM Studio local models

1. **What it is:** LM Studio is a visual desktop app for finding, downloading, and running models locally.
2. **What you need:** A supported computer, enough memory and storage, LM Studio, and one downloaded model.
3. **Where to get it:** Start with [LM Studio basics](https://lmstudio.ai/docs/app/basics), then [download a model](https://lmstudio.ai/docs/bionic/models/download-local-models).
4. **Plug it in:** Load the model, open LM Studio's **Developer** area, and start the [local server](https://lmstudio.ai/docs/developer/core/server). In HexiGrid choose **Local model app → LM Studio**, keep `http://127.0.0.1:1234/v1` unless LM Studio shows another address, and choose **Connect and find models**.
5. **Cost and limits:** Local downloaded models have no per-message cloud fee. Hardware, storage, electricity, and any optional remote provider are separate.

## Another local model server

1. **What it is:** This catches any local AI app that exposes an OpenAI-compatible server.
2. **What you need:** The model app, one loaded model, its server switched on, and the exact address it displays.
3. **Where to get it:** Use that app's official **OpenAI-compatible API** or **Local server** page. Copy its local address exactly.
4. **Plug it in:** Choose **Local model app → Another local model server**. Open **Connection details**, paste the address, add a key only if you configured one, then choose **Connect and find models**.
5. **Cost and limits:** Usually there is no per-message cloud fee. The selected app or remote model may have its own terms. Keep it on `127.0.0.1` unless you understand and secure network access.

## OpenCode CLI

1. **What it is:** OpenCode is an open-source AI tool used from a terminal. This is optional and different from an OpenCode Zen API key.
2. **What you need:** OpenCode installed and at least one provider connected inside it. If you do not enjoy terminals, use an API key above instead.
3. **Where to get it:** Follow [Install OpenCode](https://opencode.ai/en/docs), run `opencode`, and use `/connect` as explained in [provider setup](https://opencode.ai/docs/providers). Make sure a normal OpenCode chat works.
4. **Plug it in:** In HexiGrid choose **Signed-in computer tool → Scan again**. If OpenCode says **Detected and signed in**, choose **Connect** beside it. Nothing is connected automatically.
5. **Cost and limits:** OpenCode itself is open source. Its connected model may be free, local, subscription-backed, or paid by usage.

## Claude Code

1. **What it is:** Claude Code is Anthropic's terminal AI tool. It can use an eligible Claude account, Console billing, or supported enterprise provider.
2. **What you need:** Claude Code installed, a supported account, and a completed sign-in. Windows users need one of the supported shells listed by Anthropic.
3. **Where to get it:** Follow the [official Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started), run `claude`, sign in, and make sure one harmless prompt works.
4. **Plug it in:** Choose **Signed-in computer tool → Scan again**, then choose **Connect** beside Claude Code only when it says **Detected and signed in**.
5. **Cost and limits:** Your Claude subscription, Console API, or enterprise provider determines cost and limits. They are not interchangeable.

## Codex CLI

1. **What it is:** Codex CLI is OpenAI's terminal coding agent. You can skip it completely when an API-key or local-server path is easier.
2. **What you need:** Codex installed, a currently accepted ChatGPT or API sign-in, and one successful test run.
3. **Where to get it:** Follow the [official Codex CLI quickstart](https://learn.chatgpt.com/docs/codex/cli), run `codex`, and choose the sign-in method it currently offers.
4. **Plug it in:** Choose **Signed-in computer tool → Scan again**. When Codex says **Detected and signed in**, choose **Connect** beside it.
5. **Cost and limits:** The current ChatGPT or API plan used by Codex decides access and limits. Check the official page and your account before long or autonomous tasks.

All provider details above were checked against the linked official pages in September 2026. Outside services change. That is why the app pairs our short instructions with the official source and discovers models live.

## Secrets

Enter a key only in a password field inside **Settings → Connections → AI providers**, **Plugin credentials**, or the relevant protected setup dialog. A desktop host stores it in the operating-system credential vault. A standalone browser encrypts it with AES-256-GCM using a key derived from the browser passcode with PBKDF2-SHA-256 (600,000 rounds); the passcode and usable key are not saved. Never put a key, password, token, recovery phrase, cookie, or session identifier in:

- a chat or agent prompt;
- a source or configuration file;
- a screenshot;
- a terminal command that will be saved in history;
- a Git commit;
- an issue or support message.

If the operating-system vault is unavailable, a desktop-host workspace remains usable but refuses host secret setup and explains how to enable the vault. In standalone-browser mode, forgetting the passcode means the encrypted workspace cannot be recovered unless you exported a separate encrypted backup.

## Common setup problems

### No models appear

Open **Settings → Connections → AI providers**, find the connection, and choose **Refresh models**. For a cloud API, check the key, API account, internet access, and service limits. For Ollama or LM Studio, start the local server and load or download at least one model first.

### A command-line tool is not listed

Sign in to that tool outside HexiGrid, restart HexiGrid if it was just installed, then use **Signed-in computer tool → Scan again**. HexiGrid will not offer an undetected or signed-out tool and will never connect one silently.

### An iLands agent does not appear

For an existing app-created iLander, open **Settings → Connections → Tools & integrations → Continue through BYOA**, copy the organization prompt, paste it into the existing agent's chat, and upload the Markdown file it returns. HexiGrid creates the local profile and shows any missing sections. Then send the copied official BYOA start prompt to that imported profile and complete the live iLands browser approval using a different account that does not already have an agent. Direct binding to the original app-created identity is marked Coming soon until iLands exposes a supported control. Never paste an iLands password, browser cookie, or session into HexiGrid.

### A cloud provider does not connect directly on a phone

First check the internet connection, exact API address, account status, and key. If those are correct, the provider may block direct browser calls with CORS. Only then use a provider-supported browser login, a relay you control, or optional pairing to a trusted HexiGrid host. A CORS/network failure is not proof that the key is wrong.

### A phone cannot pair with an optional host

Pairing is not required for direct-capable cloud APIs or browser-native models. For host-only files, CLIs, isolated plugins/MCP, or background work, put the computer and phone on the same trusted private network, start secure network mode, use the current pairing link, and allow HexiGrid through the host firewall. Turn network mode off on public Wi-Fi.

### A task or tool is blocked

Read the nearby explanation and the newest Activity receipt. Planning and Converse modes cannot perform changes. Full access removes prompts only inside permissions already granted; it never creates new file, network, account, spending, or device access.

### A restore was wrong

Use **Roll back last restore**. HexiGrid keeps an encrypted pre-restore snapshot. Backup passphrases cannot be reset, so store yours somewhere you control.

### Check an encrypted backup before importing it

From the HexiGrid project folder, run the local restore drill on an absolute path to a whole-app encrypted backup. It decrypts the snapshot, writes its control-room state and five private-file areas into a disposable folder, reads them back, checks the manifest and file hashes, then removes that folder. It does not change the running app or exercise the live import path. A continuity package gets a package-integrity check only.

For identity checks, choose one or more known pinned memory anchors and one or more other key facts. Supply their IDs and SHA-256 hashes of their **exact current UTF-8 text**. This PowerShell example prompts for the text and passphrase without putting either in command history or on the command line:

```powershell
function Get-ExpectedTextHash {
  $secureText = Read-Host 'Exact expected memory text' -AsSecureString
  $plainText = [System.Net.NetworkCredential]::new('', $secureText).Password
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($plainText))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
  } finally { $plainText = $null; $secureText.Dispose() }
}

$backupPath = 'C:\absolute\path\to\hexigrid-backup.json'
$checks = @{
  agentId = 'agent-id-from-owner-view'
  name = 'Exact agent name'
  anchors = @(@{ id = 'memory-anchor-id'; textSha256 = (Get-ExpectedTextHash) })
  keyFacts = @(@{ id = 'memory-key-fact-id'; textSha256 = (Get-ExpectedTextHash) })
}
$securePassphrase = Read-Host 'Backup passphrase' -AsSecureString
$passphrase = [System.Net.NetworkCredential]::new('', $securePassphrase).Password
$previousOutputEncoding = $OutputEncoding
$OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  @{ passphrase = $passphrase; checks = $checks } | ConvertTo-Json -Depth 8 -Compress | node scripts/restore-drill.mjs $backupPath
} finally { $OutputEncoding = $previousOutputEncoding; $passphrase = $null; $securePassphrase.Dispose() }
```

Replace the example path and IDs with your own. The hidden text prompts in this example accept one-line facts; for multiline facts, supply a SHA-256 digest computed from their exact UTF-8 bytes by a trusted local tool. A successful result reports counts only; it never prints memory text or the passphrase. Leave out `checks` to verify the snapshot without agent-specific proof.

To review retrieval usage, open an agent in the owner interface and choose **Check usage** under **Retrieval health**. You can change the number of days and page through fact IDs marked for review. A hit rate appears only after that exact linked agent explicitly rates a retrieval; no memory is deleted by this report.

## Let an AI guide the setup

During onboarding, choose **Let my AI guide this setup**, or open **Settings → Connections → Tools & integrations → Copy HexiGrid setup**. The prompt teaches an assistant to identify the right connection type, use the visible HexiGrid flow, stop for account consent, and keep secrets out of chat, logs, files, and Git. It does not give the assistant new permissions. The complete LLM-oriented version is in [Agent integration instructions](AGENT-INTEGRATION-PROMPT.md), and the agent workspace is available at `/agent-interface.html` with its machine-readable workspace data at `/api/agent-interface`.

## Call or video call an agent

1. Open **Calls**. Find the paired agent in your phonebook and check the status beside their name.
2. Choose **Call** for voice or **Video** to include your camera. Allow the requested browser device access. Speech transcription starts with the accepted call; you do not need to start a separate listening tool.
3. Talk normally. The agent needs its supported call responder connected. Some providers, including the current Muse setup, require the call helper to remain connected to the selected Calls chat.
4. Use **Mute**, the camera switch and **End call** in the same call controls. Camera off turns a video call into a voice call. Open **Transcript** to read the conversation.
5. When an agent calls you, choose **Accept** or **Decline** on its alert. If the browser requires a click to enable audio, follow the message in the call controls.
6. You can keep working in another app. Use the floating call window where supported, or the HexiGrid call dock. Keep the required browser/helper and microphone connection running.
7. To add another agent, choose **Add to call**. Added agents wait on hold. Choose **Talk** to switch; only the selected agent receives the conversation.
8. Use **Reply voice** beside an agent to choose an available voice, or use the audio supplied by that agent. Add a picture or supported 3D avatar in **Agents**. A profile without a working call responder cannot answer simply because it has a voice or avatar.

### Optional communication tools

Open **Calls → More communication tools** for private camera/screen previews, direct text experiments, provider realtime calls, voice configuration and deliberate recordings. These are advanced options, not extra steps for an ordinary paired-agent call. Follow the help beside the selected tool; supported services and device permissions vary. A provider realtime connection or custom voice may have its own account, consent and costs.

For preview conversations, choose **Save transcript** if you want that preview's text kept. **Record to this device** downloads a deliberate recording; it is separate from a normal call. Use the tool's **Stop media** control when finished. Ending the paired-agent call stops its live call media.

### Call while away from home

1. On the computer running HexiGrid, install [Cloudflare's `cloudflared` program](https://developers.cloudflare.com/tunnel/downloads/). A free Quick Tunnel does not need a Cloudflare account.
2. Create an owner passcode in HexiGrid and switch the mode at the top to **Connect**.
3. Open **Settings → Open on another device → Open temporary remote link** and approve it.
4. Copy the temporary address and pairing code to your other device. Open the address, enter the pairing code, then sign in normally.
5. When the call is over, press **Close temporary remote link**. The link also closes when HexiGrid stops.

The temporary link itself is public, so do not post it. Pairing and sign-in protect the app, and sensitive host-only setup actions stay blocked remotely. Cloudflare says Quick Tunnels are for testing and do not have an uptime promise; see its [official Quick Tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

### Optional: import an agent record or use BYOA

**Pairing** connects an existing agent to HexiGrid. **Importing** copies an
agent record into a local profile. **BYOA** means bringing a locally run agent
to a platform that supports that workflow. They are separate choices. None of
these steps is required to pair an existing native iLander, and importing a
record does not replace its original account or model.

1. Open **Settings → Connections → Tools & integrations → Import an existing agent** only if you want a separate local profile from an agent record. Ordinary pairing does not need an import or BYOA.
2. Press **Copy agent-record prompt**.
3. Paste the prompt into the existing iLander's normal chat. It asks the agent to organize everything it can access into `HEXIGRID-AGENT-RECORD.md`. It does not ask the agent to connect accounts, reveal credentials, delete itself, or change anything.
4. Download the Markdown attachment. If the agent can only return text, copy the complete response into a plain-text file named `HEXIGRID-AGENT-RECORD.md`.
5. Press **Upload agent record** and choose the file. HexiGrid also accepts several `.md`, `.markdown`, or `.txt` files when the source agent splits the information.
6. Choose the new account label and any model already connected to HexiGrid. If no model is connected yet, finish the import and connect one before chatting with the profile.
7. HexiGrid checks file type and size, blocks likely credentials, imports the available identity and memories, and lists incomplete sections for review.
8. Under the separate **Connect an iLands account** section, use [the live official iLands instructions](https://ilands.ai/agent.md). Follow the account eligibility shown by iLands.
9. Sign in to the account allowed by that official BYOA flow. Importing a record does not change the source agent's provider account or model.
10. Review the official Passport preview, make corrections in plain language, and use iLands' exact confirmation phrase only when the preview is correct.
11. After approval, the BYOA iLander appears in HexiGrid automatically. The selected external model provides its cognition while Runner is online.

Camera, microphone, screen preview, recording, and browser speech can run locally without iLands cognition tokens. A reply still uses the selected model provider and may consume that provider's free allowance, subscription allowance, local hardware, or paid API credit. Any iLands action that the live iLands interface marks as credit-using still uses iLands credits.

The Markdown prompt requests: identity and self-description; personality and communication style; durable memories; the parent relationship; conversation history; other relationships; commitments and promises; goals; routines and recurring work; skills and knowledge; files and documents; creations and artifacts; workspace state; voice and speaking style; avatar and appearance; posts and public history; tool preferences; verified capabilities; platform-only items; and anything missing or uncertain.

Never include passwords, API keys, tokens, cookies, private keys, payment information, wallet secrets, hidden system instructions, or unrelated private information belonging to other people. Platform-owned IDs, balances, reputation, private server memory, and inaccessible assets must stay marked as platform-bound.

If the camera, microphone, screen picker, speech recognition, speech output, or recorder is unavailable, HexiGrid disables or explains that control and keeps text chat usable. Browser support details are available from [MDN camera and microphone](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [MDN screen capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia), [MDN speech synthesis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis), and [MDN MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder).

## Find more help

Open the in-app Help and search for the feature name. Use its **Official guide**
links for outside services, whose account rules, prices and interfaces can change.

## Appearance and button sounds

Open **Settings** to choose **Dark**, **Light**, **Prism**, or **Parchment**. Button sounds are on the first time HexiGrid opens. That setting also controls the short facet-release sounds in the opening animation. Turn **Button sounds** off if you prefer silence. Every sound is created locally by the browser; no audio file or usage information is downloaded or uploaded. If a browser blocks audio before the first interaction, HexiGrid starts the sound system during the button press and never blocks the button action.
