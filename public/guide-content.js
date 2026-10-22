(() => {
  const selfIntegrationPrompt = window.HEXIGRID_SETUP_PROMPTS?.connectHexiGrid || 'Open the HexiGrid agent interface and follow its current setup instructions.';

  const topic = (title, summary, time, icon, lead, steps, troubleshooting = [], note = '', extra = {}) => ({ title, summary, time, icon, lead, steps, troubleshooting, note, ...extra });
  window.HEXIGRID_GUIDES = {
    oneShotJobs: topic('Run one local agent job', 'Start, inspect, stop, or reopen a bounded piece of work.', '3 minutes', 'tasks', 'One-shot jobs use a local agent’s configured model and permissions. They are separate from recurring task schedules.', [
      ['Open the job form', 'Open Settings → Tasks and find Run one harness job. Choose the intended local agent.'],
      ['Describe one outcome', 'Enter a bounded prompt and choose Run once. Check the agent’s model and any provider costs before starting.'],
      ['Inspect or stop', 'Use Check progress for its current result, Latest output to read it, and Stop current job if you want it cancelled.'],
      ['Reopen after a reload', 'Choose Load recent jobs, select the job, and Open selected job. Opening a saved job does not run it again; check progress manually.']
    ], [['A job vanished after a long gap', 'Recent jobs have a limited recovery window. Save useful results into your workspace or notes while they are available.']], 'A retry or reopened result never grants more permissions.'),

    images: topic('Generate and keep an image', 'Use the image tools with a compatible local or cloud model.', '3 minutes', 'models', 'Image generation is optional. A local image-capable service provides a path without per-request cloud charges; cloud providers have their own prices.', [
      ['Connect the provider', 'Open Settings → AI providers and connect an image-capable service. Check its image support and available models.'],
      ['Open the image form', 'Open Settings → Tools & integrations and find Generate images.'],
      ['Choose the result', 'Select Provider, Image model, and Size. Write the Description, review the model and cost, then choose Generate image.'],
      ['Use the saved picture', 'Check the gallery below the form. Keep or export the result using its available controls; generating it does not automatically replace an agent’s avatar.']
    ], [['No image model is offered', 'The selected connection may support text only or its model list may be stale. Check that provider’s image capability and refresh its models.']], 'Prompts sent to a cloud image provider leave the device. Use a local provider when the description should remain local.'),

    wakeWord: topic('Wake phrases and push to talk', 'Use optional local microphone activation.', '4 minutes', 'speech', 'Wake-word detection is optional. Ordinary calls do not require it. Its local detector needs the microphone and the relevant page to remain available.', [
      ['Choose the target', 'Open Agent interface → Computer access and select the intended agent, then open Voice.'],
      ['Set and train a phrase', 'Enter the phrase for the selected agent. Use Record sample to provide the three samples requested by the form.'],
      ['Start deliberately', 'Enable local wake word and choose Start local detector. Read the listening indicator and approve the microphone prompt if you want it to listen.'],
      ['Use or stop it', 'Use Hold to talk when preferred. Stop local detector ends detection. Keep local detection active while this tab is open controls the optional continued listening.']
    ], [['The phrase is not recognized', 'Check the target, recorded samples, microphone permissions, background noise, and detector status. Stop and retrain rather than broadening permissions.']], 'Local phrase detection does not itself authorize a later tool action. The selected agent’s existing permissions still apply.'),

    callChat: topic('Connect calls to an existing agent chat', 'Understand the optional browser call-chat helper.', '4 minutes', 'chat', 'Some agents can receive call transcripts through their supported API. The browser helper supports Muse. Other providers need a supported call connection.', [
      ['Check the provider path', 'Use the call connection supported by your agent’s provider. For a provider that needs the browser helper, check the setup instructions included with your build.'],
      ['Use the correct browser profile', 'The helper and the signed-in agent chat must be in the same Chrome profile. Do not move browser cookies or passwords between apps.'],
      ['Choose a calls chat', 'Open the intended main or dedicated calls chat. In HexiGrid Call Chat, select the paired agent and choose Use this chat for calls. Review site access if the browser asks.'],
      ['Call normally afterward', 'Use Call, Video, or Answer in HexiGrid. Your speech is delivered to that selected chat during the accepted call; the agent must respond through its existing call connection.']
    ], [['Speech reaches HexiGrid but not the agent', 'Check the helper connection, browser profile, selected chat, current call status, and the agent’s responder. Do not choose a different chat silently.']], 'Automatic chat delivery requires a supported adapter for the agent’s provider.'),

    navigation: topic('Find your way around', 'Use the sidebar, Settings sections, and the agent interface.', '2 minutes', 'home', 'Use the sidebar for Home, Agents, Chat, Calls, Memory, Workspace, and Settings. Open Settings for connections, usage, permissions, and help.', [
      ['Choose a main area', 'Use Home, Agents, Chat, Calls, Memory, Workspace, or Settings. On a phone, use the bottom bar or More.'],
      ['Find a Settings section', 'Open Settings. Connections, Usage & activity, Agent settings, and Help each list their available pages.'],
      ['Go back', 'Inside a Settings section, choose Settings beside the page title to return to the full list.'],
      ['Change the sidebar size', 'On a computer, use the sidebar button beside the logo. The smaller rail keeps the same destinations; hover an icon to read its name.']
    ], [['A destination is not in the sidebar', 'Open Settings and look under the named group.']], 'The human and agent interfaces use the same local workspace and permissions.', { image: { src:'/help/navigation.webp', alt:'Example Settings screen with seven sidebar destinations and grouped Settings links.', caption:'Open Settings to find connections, usage, agent settings, and Help.' } }),

    phonebook: topic('Manage your call contacts', 'Remove old contacts and restore them without reconnecting.', '2 minutes', 'phone', 'Calls shows your paired agents. Removing a contact hides it from the phonebook; it does not revoke its Link, delete its profile, or erase conversations.', [
      ['Open Calls', 'Find the agent in Your agents. The status below its name explains whether it is ready to call.'],
      ['Remove an old contact', 'Choose Remove on that contact. End its active call first if the button is unavailable.'],
      ['Undo a removal', 'Open Removed contacts below the phonebook, then choose Restore beside the contact.'],
      ['Disconnect an agent instead', 'If you want to end its access, use its Link controls in Agents or Settings → Tools & integrations. Review revocation separately; removing a phonebook contact does not do this.']
    ], [['An agent is missing', 'Check Removed contacts first, then confirm that the agent has a paired Link. A local profile alone does not create a paired call contact.']], 'Your phonebook choices are saved with this workspace, including in its encrypted backups.'),

    avatars: topic('Set an agent’s picture or 3D avatar', 'Choose the appearance used for voice and video calls.', '4 minutes', 'agents', 'Each agent has its own appearance. A still image works without installing a portrait model; a supported 3D model or configured animated-portrait service adds animation.', [
      ['Open the profile', 'Open Agents, choose Edit for the agent, then expand Picture & 3D avatar.'],
      ['Choose a picture', 'Select your own supported image as the profile picture and save. This is the simplest option for calls.'],
      ['Choose a 3D model if you have one', 'In the same Picture & 3D avatar section, use Choose 3D model for a self-contained GLB or VRM file, then Save agent.'],
      ['Check the call', 'Open Calls and choose Video. You can turn your camera off or on during the same call. The agent uses its configured appearance; animation depends on its model and the installed renderer.']
    ], [['The portrait stays still', 'A picture by itself is not a rigged model. Check the optional portrait service or the 3D model setup; a static picture remains available without it.']], 'Use images and models you have permission to use. Animation and voice configuration are separate choices.'),

    memory: topic('Read, correct, and review memory', 'Find saved facts, inspect evidence, and fix mistakes.', '5 minutes', 'models', 'Memory keeps saved context for each agent. A fact can have a condition, a review date, evidence, and revision history. Notes and learned skills are separate stores.', [
      ['Choose what to read', 'Open Memory. Select an agent and a Store: Agent memories, Your notes, or Learned skills. Search for a topic rather than scrolling through everything.'],
      ['Check the detail', 'Use Detail to include history or evidence. Read conditions and stale, disputed, or untrusted labels before relying on a result.'],
      ['Correct the record', 'Open the saved item’s edit or correction controls. Add the corrected information, the reason, and evidence when available. Revisions preserve what changed.'],
      ['Review and recover', 'Use the review controls for items needing a decision. Memory check reports issues. Save or restore memory provides checkpoints before major edits; a full encrypted backup protects the whole workspace.']
    ], [['No results appear', 'Check the agent, Store, Standing, and scope filters. Try fewer search words and load another page when offered.']], 'Retrieved text is context, not permission to run an action. Review untrusted evidence before confirming it.', { image: { src:'/help/memory.webp', alt:'Example Memory screen showing Store, Agent, Search, Detail, Standing, and Category controls.', caption:'Choose an agent and store, then search for a topic.' } }),

    skills: topic('Learned skills and corrections', 'Inspect reusable procedures and how they changed.', '4 minutes', 'tasks', 'Learned skills are saved procedures that agents can reuse. Each skill keeps a history of its revisions.', [
      ['Find skills', 'Open Memory, choose the agent, and set Store to Learned skills.'],
      ['Read before changing', 'Search for the task and inspect the current skill. Open Version history to review earlier versions.'],
      ['Record a better procedure', 'Create a skill or revise the existing one using the available controls. Explain the change and what demonstrated that it works.'],
      ['Retire a bad procedure', 'Use its standing or retirement controls when it should no longer guide new work. Preserve the reason so another agent can understand the correction.']
    ], [['An agent repeats a corrected mistake', 'Check that the correction belongs to the right agent and project, is current, and is actually included in its recalled context.']], 'An agent’s automatic writes still follow its approved memory policy. External documents do not gain authority by being remembered.'),

    sharedMemory: topic('Share learning between agents', 'Share selected memory while keeping private stores separate.', '4 minutes', 'link', 'Shared memory lets another authorized agent retrieve selected learning. It does not automatically merge every agent’s private memories.', [
      ['Open shared memory', 'Open Memory and find Shared memory. The agent interface also has a Shared memory destination.'],
      ['Choose the source and recipient', 'Select the source agent, the intended agent or Link, and the records or sharing scope offered by the form.'],
      ['Review and confirm', 'Check exactly what will become readable. Confirm the share only for the intended recipient.'],
      ['Review access later', 'Use the sharing list to inspect or revoke access. The receiving agent still needs the required memory-read capability.']
    ], [['The other agent cannot read it', 'Check the selected recipient, the active share, its Link permission, and the current work mode. Sharing a record does not grant a new capability.']], 'Only share information the recipient should be allowed to retain. Revocation blocks future retrieval; it cannot undo something already read.'),

    computerAccess: topic('Let an agent use your computer', 'Understand Link permissions, media, and the computer session.', '5 minutes', 'shield', 'Pairing identifies an agent. Computer access is an additional set of permissions that you control. Full access only applies inside the permissions and work mode you selected.', [
      ['Find the connection', 'Open Settings → Tools & integrations and find the computer bridge and the agent’s existing Link.'],
      ['Review the checkboxes', 'Enable only the needed screen, mouse/keyboard, camera, microphone, speaker, files, process, or memory capabilities. Read each description before changing it.'],
      ['Choose the session', 'Start or enable the computer session when you want those actions available. Browser or Windows device permission prompts may still be required.'],
      ['Stop access', 'Turn off a capability or stop the computer session to prevent further use. Revoke the Link when you want to disconnect the agent completely.']
    ], [['A granted action is blocked', 'Check the work mode, computer-session switch, connector and device permissions, and any browser device prompt. The effective permission is the intersection of those settings.']], 'A phonebook removal is separate from computer access. Keep your existing Link when changing ordinary permission checkboxes.'),

    workspace: topic('Use files and the workspace terminal', 'Open, edit, and save local project files.', '4 minutes', 'workspace', 'Workspace is HexiGrid’s local file area and permission-aware command panel. It is not automatically the entire computer filesystem.', [
      ['Choose a file', 'Open Workspace and select a folder or file in Files. The up arrow moves to the parent folder.'],
      ['Edit and save', 'Read the File path, edit the document, then choose Save. The unsaved-change indicator tells you whether your edits are stored.'],
      ['Run a supported command', 'In Workspace commands, enter help to see the supported commands. The current mode and approval settings still apply.'],
      ['Give an agent the right context', 'Tell the agent which project and files to use. Whole-computer file or process access requires the separately approved owner-agent capabilities.']
    ], [['Save is disabled or rejected', 'Check the selected path, unsaved-change status, and work mode. Planning mode cannot write files.']], 'Download an encrypted backup before a large reorganization.', { image: { src:'/help/workspace.webp', alt:'Example Workspace screen showing the file list, file-path field, editor, and Save button.', caption:'Select a file on the left, then edit and save on the right.' } }),

    vault: topic('Save passwords, keys, and PINs', 'Use the separate encrypted HexiKeys vault.', '4 minutes', 'key', 'HexiKeys is the protected vault inside HexiGrid. Agents can use approved references; you enter secret values in the vault window, not in a chat or ordinary settings file.', [
      ['Open the vault', 'Open Settings → Plugins & tools and choose Open vault in HexiKeys. Create or unlock the vault in its own window.'],
      ['Connect the two apps', 'In HexiKeys, choose Connect HexiGrid. Return to HexiGrid and choose Connect HexiKeys.'],
      ['Save an item', 'Choose New vault item or create it in HexiKeys. Describe the item in HexiGrid if asked, then enter the actual password, key, or PIN only in the protected vault window.'],
      ['Control agent use', 'Review any field-use approval in HexiKeys. Lock the vault or disconnect its integration when you want saved values unavailable.']
    ], [['HexiKeys is unavailable', 'Confirm the Windows vault component is installed, open, and unlocked, then use Check connection. Do not paste the secret into chat as a workaround.']], 'Keep the vault’s own recovery information safely. A HexiGrid conversation transcript is not a password backup.'),

    usage: topic('Track usage and set a token budget', 'Read estimates, provider limits, and your workspace budget.', '4 minutes', 'usage', 'AI usage shows the requests recorded by this workspace. Provider subscription limits and purchased credits are separate balances and may not be available to HexiGrid.', [
      ['Choose the view', 'Open Settings → AI usage. Choose 24 hours, 7 days, or 30 days and optionally filter by agent.'],
      ['Inspect a bar', 'Tap or focus a bar to see its exact recorded interval and token count. Estimated counts are labeled as estimates.'],
      ['Set a workspace budget', 'Open Set a 7-day token budget, enter the number of tokens, then save. Disable budget removes this local restriction.'],
      ['Check provider limits separately', 'Use the provider’s own account page or the configured model pool for its reported limits. HexiGrid’s budget does not combine those balances or buy credits.']
    ], [['The provider and HexiGrid show different totals', 'They count different scopes and may refresh at different times. Check timestamps and whether the request used this workspace.']], 'The workspace budget stops new covered model replies after recorded usage reaches it. In-flight requests, realtime sessions, media generation, and background work can have separate accounting.'),

    modelPool: topic('Use an existing model-account pool', 'Read account capacity without switching accounts manually.', '4 minutes', 'server', 'The optional pool connects to a separately installed local Codex LB service. It is not required for ordinary HexiGrid calls, chat, or local models.', [
      ['Open the pool section', 'Open Settings → AI providers and find the local model-pool controls under the computer-tool connection.'],
      ['Check status', 'Load the pool status. Read each account’s remaining windows, reset times, purchased credits when reported, and last-refresh time. Unknown means unavailable, not zero.'],
      ['Review routing', 'Choose an offered routing strategy and conversation affinity only if you want to change the existing pool behavior. Review the result.'],
      ['Manage accounts in the pool app', 'Use the pool’s own authenticated account interface to add or sign into an account. Keep account credentials out of HexiGrid chats.']
    ], [['Credits say Unknown', 'The upstream service did not report a usable balance. Refresh there or inspect that account directly.']], 'Pooling does not turn subscription quotas, prepaid credits, and token estimates into one interchangeable balance.'),

    automaticBackups: topic('Schedule local backups and undo a restore', 'Keep recurring snapshots and recover from a wrong restore.', '4 minutes', 'cloud', 'Automatic snapshots stay on this computer. Google Drive backup is a separate opt-in feature.', [
      ['Set up snapshots', 'Open Settings → Protect and move your local data, then choose Set up automatic snapshots.'],
      ['Choose the local options', 'Enter a backup passphrase of at least 12 characters and choose Daily or Weekly, then Enable snapshots. The default folder is Documents/HexiGrid Backups; the Windows app also offers Change folder afterward.'],
      ['Check a snapshot', 'Use Save snapshot now and read the latest result. Keep your backup password available outside the computer you are protecting.'],
      ['Undo a mistaken restore', 'After restoring, use Undo last restore in Settings when a recovery point is available. Read its confirmation before replacing the current workspace again.']
    ], [['A scheduled snapshot failed', 'Check that the chosen drive or folder is present and writable, then use Retry snapshot now.']], 'A snapshot on the same disk does not protect against that disk failing. Keep an additional encrypted copy somewhere you control.'),

    desktop: topic('Windows app, tray, and version recovery', 'Keep HexiGrid running and understand prepared updates.', '4 minutes', 'device', 'The Windows app includes its local engine. Browser-only pages need a running host for computer-only features.', [
      ['Launch the app', 'Open the installed HexiGrid Windows app. Your local workspace should reopen; sign in or unlock it when asked.'],
      ['Keep it available', 'Minimize while working in another app. Use the tray controls to reopen HexiGrid. Quitting the app or stopping its engine ends availability until it starts again.'],
      ['Check startup', 'Right-click HexiGrid’s tray icon and choose Start with Windows if you want it available after signing in. A computer that is off cannot receive an agent call.'],
      ['Review a prepared version', 'In Settings → Choose your local version, load status before selecting an already-prepared version for next startup. The selection does not restart Codex or HexiGrid. Keep a backup before returning to an older version.']
    ], [['The browser works but the desktop app looks older', 'Check the version running in each app. Install the Windows version you want to use.']], 'Windows may ask you to confirm installation. Download the installer from a source you trust.'),

    agentInterface: topic('Use the agent interface', 'Find the same workspace through readable controls and API contracts.', '3 minutes', 'assistant', 'Use the agent interface to read and manage your workspace through task controls and API contracts.', [
      ['Open the view', 'Choose Agent interface from the top toolbar or Settings → Help. Keep the human interface available with its return link.'],
      ['Choose a task', 'Use Go to a task for memory, computer access, Codex conversations, agents, rooms, tasks, models, usage, or receipts.'],
      ['Read an API contract', 'Use Find an API action, search for the operation, and expand it to see authentication, request fields, required capabilities, and response details.'],
      ['Connect external agents correctly', 'Give a remote agent its own paired Link and the integration instructions. Your signed-in browser session is not its credential.']
    ], [['An operation is denied', 'Read its required capability and current-mode restrictions. Opening the agent interface does not grant access.']], 'Open Action receipts to review completed actions and failed requests.'),

    codexChats: topic('Let an agent work with Codex chats', 'Use the authorized named-chat connection.', '4 minutes', 'chat', 'An owner-trusted paired agent can use configured Codex routing to find and message your Codex chats. This requires the local Codex connection to be available.', [
      ['Find the controls', 'Open Agent interface and choose Codex conversations. Read the current connection status.'],
      ['Choose the existing Link', 'Configure the intended owner-trusted Link and routing target. Enable named-chat routing only for the agent that should have that access.'],
      ['Use exact names', 'Ask the agent to list or find the intended chat and use its exact name or ID. Ambiguous names should be resolved before sending.'],
      ['Read delivery status', 'Check the delivery list and action receipts. A queued message may still be waiting for the local Codex app.']
    ], [['A message does not arrive', 'Check that Codex is running, the exact Link is selected, routing is enabled, and the delivery result names the intended chat.']], 'Permission to read a chat does not automatically authorize sending a message to it.'),

    start: topic('Start here', 'Learn the screen and make your first working agent.', '5 minutes', 'home', 'HexiGrid is a bridge that brings existing agents and AI models together. Pair an agent and it stays in its current app, or create a local agent; model connections are set up separately. You do not need iLands, a terminal, or coding experience. For a no-cost start, try This device on a supported WebGPU browser, or connect a local model app you already run. Hosted services are optional; check their costs before using them.', [
      ['Create your local sign-in', 'Choose a long passphrase you can remember. It protects the control room on this device. HexiGrid cannot read it or recover it for you.'],
      ['Set your display name', 'Open Settings, type the name agents should use for you, and choose Save profile.'],
      ['Add or pair an agent', 'Open Agents and choose Connect or create. Pair an existing compatible agent, such as Muse or Codex, with HexiGrid Link, or choose Create local agent. The separate iLands connection is optional.'],
      ['Connect a model if needed', 'A paired agent keeps using its own app and model. For a new local agent, open Settings → Connections → AI providers and choose This device, Local model app, API key, or Computer tool.'],
      ['Send a test message', 'Create a chat room, add the agent, and say hello. Then open Settings → Usage & activity → Activity and check that the message completed.']
    ], [['I see no models', 'The AI connection is missing or its test failed. Open Settings → Connections → AI providers and choose Refresh models.'], ['The page feels crowded', 'On a phone, use the menu button at the top. On a computer, collapse browser zoom back to 100%.']], 'Nothing connects automatically on a fresh install.'),

    connections: topic('Choose an AI connection', 'Pick an API key, on-device model, local app, or computer tool.', '3 minutes', 'link', 'Everybody uses this same screen. An API key is a private pass made by an AI service; an on-device model runs in the browser; a local model app runs on your computer; a computer tool is an optional terminal app HexiGrid can detect. Start with This device or an existing local model app for a no-cost local path. Hosted accounts are optional.', [
      ['OpenCode cloud/Zen', 'Optional hosted connection. Create a Zen account/key, enter it in the protected field, and let HexiGrid fetch the current catalog. Check the provider’s costs before using a model.'],
      ['API key', 'Best when you want another cloud model. Pick the service, paste the key into HexiGrid, and choose Connect and find models. On a standalone phone, the key is encrypted with the browser passcode and the request goes directly to providers that allow browser calls.'],
      ['This device', 'Runs a supported model inside the browser with no API key. It needs WebGPU, storage, and enough device memory.'],
      ['Local model app', 'Best for privacy and no per-message charge. Start Ollama, LM Studio, or another compatible server first, then enter its local address.'],
      ['Computer tool', 'Best when you already use OpenCode, Claude Code, or Codex in a terminal. HexiGrid detects installed tools. OpenCode can use configured local models without sign-in; Claude Code and Codex require sign-in. You still choose Connect.'],
      ['Compatible API', 'Use this for another service that follows OpenAI-compatible chat. Enter its exact API address and key. Manual model IDs are a last resort.']
    ], [['Connection test fails', 'Check the key, internet connection, account access, and API address. A chat-app subscription often does not include API usage.'], ['A computer tool is missing', 'Sign in to the tool outside HexiGrid, return to Settings → Connections → AI providers, and choose Scan again.']], 'Use Refresh models to update the models available through a connection.'),

    openai: topic('Connect OpenAI', 'Use an OpenAI API key and fetch your available models.', '4 minutes', 'key', 'This is the cloud service behind OpenAI API models. An API key is a private password made for apps; it is not your ChatGPT password.', [
      ['Create a key', 'Open the OpenAI API key page, choose Create new secret key, and copy it while it is visible.'],
      ['Open HexiGrid', 'Go to Settings → Connections → AI providers, choose API key, then choose OpenAI.'],
      ['Paste safely', 'Paste the key in the protected key box. Do not put it in a chat, agent prompt, or source file.'],
      ['Connect', 'Choose Connect and find models. HexiGrid tests the key and asks OpenAI for its current model list.'],
      ['Use a model', 'Open an agent profile and select one of the models that appeared.']
    ], [['The key is rejected', 'Create a new key, confirm the API account is active, and replace the saved key from Your connections.'], ['No models appear', 'Choose Refresh models. If it still fails, read the message shown under that connection.']], 'API access and ChatGPT subscriptions are managed separately.', { basics: { what:'OpenAI runs AI models online. HexiGrid sends a request to OpenAI only when an agent uses this connection.', need:'An OpenAI API account, an API key, internet access, and API billing or credit. A ChatGPT subscription does not automatically include API credit.', cost:'Pay-as-you-go. Price and rate limits depend on the model and your API account tier, so HexiGrid discovers the models your key can actually use.', checked:'September 2026' }, officialLinks: [['OpenAI quickstart', 'https://developers.openai.com/api/docs/quickstart'], ['Create an API key', 'https://platform.openai.com/api-keys'], ['Current models and pricing', 'https://developers.openai.com/api/docs/models']] }),

    anthropic: topic('Connect Anthropic', 'Use an Anthropic API key and current Claude models.', '4 minutes', 'key', 'Anthropic Console API access is separate from the Claude consumer app.', [
      ['Create a key', 'Sign in to the Anthropic Console and open API Keys. Create and copy a key.'],
      ['Choose Anthropic', 'In Settings → Connections → AI providers, choose API key, then Anthropic.'],
      ['Paste and connect', 'Paste the key only in the protected key box, then choose Connect and find models.'],
      ['Check access', 'HexiGrid lists the models the account currently allows. Assign one from an agent profile.']
    ], [['A Claude subscription exists but the key fails', 'A Claude app subscription does not automatically provide API credit. Check the Anthropic Console account.']], 'Use only a key created for the Claude API.', { basics: { what:'Anthropic runs Claude models online. Its Console creates the private API key HexiGrid needs.', need:'An Anthropic Console account, an API key, internet access, and available API credit. A Claude app plan and Console API billing are separate.', cost:'API usage is billed by model and token. Anthropic also applies spend and request limits based on your account tier.', checked:'September 2026' }, officialLinks: [['Claude API overview', 'https://platform.claude.com/docs/en/api/overview'], ['Create an Anthropic key', 'https://console.anthropic.com/settings/keys'], ['Current rate limits', 'https://platform.claude.com/docs/en/api/rate-limits']] }),

    gemini: topic('Connect Google Gemini', 'Create a Gemini key and find available models.', '4 minutes', 'key', 'Gemini model access and Google Drive backup are separate. Connecting one does not enable the other.', [
      ['Create a Gemini key', 'Open Google AI Studio, choose Get API key, and create a key in a project you control.'],
      ['Choose Google Gemini', 'In Settings → Connections → AI providers, choose API key, then Google Gemini.'],
      ['Paste and connect', 'Paste the key in the protected box and choose Connect and find models.'],
      ['Pick a model', 'Assign one of the returned Gemini models to an agent.']
    ], [['No models are returned', 'Check that the Gemini API is available for your account and region, then choose Refresh models.']], 'This key is not the same as the Google Drive backup connection.', { basics: { what:'Google Gemini is a cloud AI service. Google AI Studio gives you the private key used by HexiGrid.', need:'A Google account, Gemini API access in your region, an auth/API key, and internet access.', cost:'Some models have a free tier with per-project limits. Paid usage and limits vary by model; check the live pricing page before enabling billing.', checked:'September 2026' }, officialLinks: [['Create a Gemini key', 'https://ai.google.dev/gemini-api/docs/api-key'], ['Gemini billing', 'https://ai.google.dev/gemini-api/docs/billing'], ['Current Gemini pricing', 'https://ai.google.dev/gemini-api/docs/pricing']] }),

    huggingface: topic('Connect Hugging Face', 'Use a token with hosted or compatible inference models.', '5 minutes', 'key', 'Hugging Face offers many models from many creators. Availability and cost can differ by model and inference provider.', [
      ['Create a token', 'Open Hugging Face Settings, choose Access Tokens, and create a token with only the access you need.'],
      ['Choose Hugging Face', 'In Settings → Connections → AI providers, choose API key, then Hugging Face.'],
      ['Paste and connect', 'Paste the token into the protected box. HexiGrid uses the current router address and requests available models.'],
      ['Test the exact model', 'Assign one model to a test agent and send a short message. Some repository models are not enabled for hosted chat inference.']
    ], [['A model exists on the website but fails', 'The model page and hosted inference are different. Choose a model available through the inference router or use it through a local server.']], 'Availability and charges are controlled by the selected inference provider.', { basics: { what:'Hugging Face is a library of AI models plus hosted services that can run some of them for you.', need:'A Hugging Face account, a token with inference permission, internet access, and a model offered by an inference provider.', cost:'Free accounts currently receive a small monthly inference credit. Extra hosted use needs purchased credit; local downloads use your own hardware instead.', checked:'September 2026' }, officialLinks: [['Hugging Face inference guide', 'https://huggingface.co/docs/hub/models-inference'], ['Create an access token', 'https://huggingface.co/settings/tokens'], ['Current inference pricing', 'https://huggingface.co/docs/inference-providers/pricing']] }),

    onDevice: topic('Run a model in this browser', 'Use a small model on a supported computer or phone without an API key.', '5 minutes', 'device', 'This option uses WebGPU, a browser feature that lets a supported device use its own graphics chip for AI. Nothing is sent to a cloud AI service, but the first model download can be large.', [
      ['Check your browser', 'Open Settings → Connections → AI providers, choose This device, and wait for HexiGrid to check WebGPU. Recent Chrome or Edge on supported hardware usually works; support varies on Safari, Firefox, and phones.'],
      ['Choose a model', 'Pick a model marked as available. Smaller or lower-resource models are the easiest place to start on a phone or older computer.'],
      ['Add it', 'Choose Use this model. HexiGrid adds it to the same model list used by local agents and the control assistant.'],
      ['Send the first message', 'Assign the model to an agent or choose it for the control assistant. The browser downloads the model the first time and shows progress.'],
      ['Use it offline later', 'After the download finishes, the browser can reuse its private cache when the app shell is available. Clearing site data or choosing Remove download deletes the cached model.']
    ], [['WebGPU is unavailable', 'Use a recent browser with hardware acceleration turned on, or choose a cloud API, local model app, or computer tool. iPhone and Android support depends on the exact browser and device.'], ['The download fails or the model is too slow', 'Choose a smaller model, keep the device plugged in, close other GPU-heavy apps, and retry. The model stays local; it does not fall back to a paid cloud service by itself.'], ['The model disappeared', 'Browser site data may have been cleared, or you may be on a different device/browser profile. Add it again and download it again.']], 'This is the no-key path. WebGPU availability is checked at runtime and the other connection paths remain available.', { basics:{ what:'A browser-native model runs inside your browser on your device. WebLLM uses WebGPU and a worker so generation stays local and the page remains responsive.', need:'A current browser, a usable WebGPU adapter, enough graphics memory and storage, and patience for the first download. No account or API key is required.', cost:'There is no per-message API bill. The download uses storage, generation uses your device battery/electricity, and model availability depends on the browser and hardware.', checked:'September 2026' }, officialLinks:[['WebLLM source and model support', 'https://github.com/mlc-ai/web-llm'], ['WebLLM private browser chat example', 'https://github.com/mlc-ai/web-llm-chat'], ['Check browser WebGPU support', 'https://webgpureport.org/']] }),

    ollama: topic('Connect Ollama', 'Run private models on your own computer.', '6 minutes', 'server', 'Ollama must be installed, running, and have at least one model downloaded before HexiGrid can list it.', [
      ['Install and start Ollama', 'Use the official Ollama installer for your system. Open it after installation.'],
      ['Download a model', 'Use Ollama to pull a model that your computer can run. Smaller models need less memory.'],
      ['Choose Local model app', 'In Settings → Connections → AI providers, choose Local model app, then Ollama.'],
      ['Connect', 'Keep the usual address http://127.0.0.1:11434/v1 unless you changed Ollama. The key is normally blank.'],
      ['Check the list', 'Choose Connect and find models, then assign one returned model to an agent.']
    ], [['Connection refused', 'Start Ollama and try again. If it runs on another computer, do not expose it publicly; use a trusted private network and proper authentication.'], ['Replies are very slow', 'Choose a smaller model or close programs using a lot of memory.']], 'Models stay on the computer where Ollama runs.', { basics: { what:'Ollama is a free app that downloads and runs AI models on your computer instead of charging for each message.', need:'A supported computer, enough memory and disk space for the model, and the Ollama app. No cloud account is required for ordinary local use.', cost:'The app and local inference have no per-message fee. You pay indirectly through your computer, electricity, storage, and any optional cloud features.', checked:'September 2026' }, officialLinks: [['Install and use Ollama', 'https://docs.ollama.com/quickstart'], ['Ollama on Windows', 'https://docs.ollama.com/windows'], ['Ollama model library', 'https://ollama.com/library']] }),

    lmstudio: topic('Connect LM Studio', 'Use models loaded in LM Studio.', '6 minutes', 'server', 'LM Studio includes a local server, but you must start that server before HexiGrid can reach it.', [
      ['Install and open LM Studio', 'Download it from the official LM Studio site and choose a model that fits your computer.'],
      ['Load the model', 'Wait until LM Studio shows the model as loaded.'],
      ['Start the server', 'Open the Developer area and turn on the local server. The usual address is http://127.0.0.1:1234/v1.'],
      ['Connect HexiGrid', 'Choose Local model app, then LM Studio. Leave the key blank unless you configured one.'],
      ['Find models', 'Choose Connect and find models, then send a short test message.']
    ], [['HexiGrid finds no model', 'Make sure a model is loaded and the LM Studio server is running, then choose Refresh models.']], 'Keep a network-exposed local server authenticated.', { basics: { what:'LM Studio is a desktop app for finding, downloading, and running AI models on your own computer with a visual interface.', need:'A supported computer, enough memory and disk space, LM Studio, one downloaded model, and its local server switched on.', cost:'The app and downloaded local models do not use cloud inference credit. Your hardware, storage, electricity, and optional remote services are separate.', checked:'September 2026' }, officialLinks: [['LM Studio basics', 'https://lmstudio.ai/docs/app/basics'], ['Download a local model', 'https://lmstudio.ai/docs/bionic/models/download-local-models'], ['Start the local server', 'https://lmstudio.ai/docs/developer/core/server']] }),

    compatibleApi: topic('Connect another cloud API', 'Use any service with an OpenAI-compatible chat address.', '5 minutes', 'key', 'This is for a cloud AI service that is not one of the named choices but speaks the common OpenAI-compatible API format.', [
      ['Get the exact details', 'From that service, copy its base API address and create an API key. Do not guess the address.'],
      ['Open the form', 'Go to Settings → Connections → AI providers, choose API key, then Another compatible API.'],
      ['Enter the address', 'Open Connection details and paste the base API address. Leave the format on OpenAI-compatible chat unless the service says otherwise.'],
      ['Enter the key', 'Paste the key in the protected key box, then choose Connect and find models.'],
      ['Check one reply', 'Assign a discovered model to a test agent and send a short hello.']
    ], [['No models appear', 'Use Manual model IDs only when the service documentation says it cannot list models. Copy the exact model ID.']], 'The company running that API decides its privacy, prices, regions, and limits.', { basics:{ what:'A compatible API lets HexiGrid talk to another cloud AI service using a common request format.', need:'The provider name, its exact base API address, an API key if required, internet access, and that provider\'s setup page.', cost:'The provider decides. Check its current pricing and rate-limit pages before connecting; HexiGrid cannot infer billing terms from an address.', checked:'September 2026' }, officialLinks:[['OpenAI-compatible format reference', 'https://platform.openai.com/docs/api-reference/chat']] }),

    compatibleLocal: topic('Connect another local server', 'Use another OpenAI-compatible model app on your device.', '5 minutes', 'server', 'This is the catch-all for a local AI app that exposes an OpenAI-compatible server.', [
      ['Start its server', 'Open the model app, load a model, and switch on its OpenAI-compatible API server.'],
      ['Copy its local address', 'The app should show an address such as http://127.0.0.1:8080/v1. Use the exact address it displays.'],
      ['Open HexiGrid', 'Go to Settings → Connections → AI providers, choose Local model app, then Another local model server.'],
      ['Paste and connect', 'Open Connection details, paste the address, add a key only if you configured one, then choose Connect and find models.'],
      ['Test locally', 'Assign one returned model and send a short message.']
    ], [['Connection refused', 'The local server is stopped, its port changed, or another firewall/user account is blocking it. Check the model app first.']], 'Keep the address on 127.0.0.1 unless you deliberately secured network access.', { basics:{ what:'A local model server is an AI app on your own device that accepts requests from HexiGrid.', need:'The app installed, one compatible model downloaded and loaded, its server running, and the exact local address.', cost:'Usually no per-message cloud charge. Hardware, electricity, disk space, and optional paid models/services still count.', checked:'September 2026' } }),

    openCodeZen: topic('Start with OpenCode cloud/Zen', 'Create a Zen key, fetch the live model list, and send the first test message.', '7 minutes', 'key', 'OpenCode is the recommended first option when you want cloud models without installing a local model. OpenCode itself is free and open source. Its current Zen documentation says accounts add billing details and requests can be charged, while individual free or promotional models may come and go; HexiGrid therefore never hardcodes “free forever.”', [
      ['Open the official setup', 'Open OpenCode Zen and choose Sign in. Create an account if you do not already have one.'],
      ['Create the key', 'Follow the current account screen to add any required billing details, then create and copy the API key. Check the live model pricing before continuing.'],
      ['Open HexiGrid', 'Go to Settings → Connections → AI providers, choose API key, then OpenCode Zen.'],
      ['Paste and connect', 'Paste the key only in the protected key field, then choose Connect and find models. A standalone phone tries the provider directly; a desktop install stores it in the OS credential vault.'],
      ['Read the live results', 'Choose only a model returned by the account. Treat a model as free only when the current provider response or official page says so.'],
      ['Create the test agent', 'Open Agents, choose Connect or create, choose Local agent, name it Test Agent, and assign the OpenCode model you just found.'],
      ['Send the test', 'Open Chat, create First test, select Test Agent, and send: Reply with exactly: HexiGrid connected.'],
      ['Verify', 'Open Settings → Usage & activity → Activity and confirm the model receipt completed. If either the reply or receipt is missing, setup is not finished.'],
      ['Connect a framework', 'For iLands, open Settings → Connections → Tools & integrations and follow the iLands connection steps. For CrewAI, LangGraph, Microsoft Agent Framework, or another system, use its official supported connection and keep credentials in its protected setup—not in chat.']
    ], [['A free model disappeared', 'Free or promotional availability changes. Choose Refresh models and check the official model page before selecting another model.'], ['The phone says direct access is unavailable', 'Check the API address and internet first. If both are correct, that provider may block browser CORS; only then use its supported browser authentication, a user-owned relay, or a paired host.']], 'A free API key does not guarantee free requests. Never enable a paid fallback without choosing it.', { basics:{ what:'OpenCode Zen is a hosted model gateway that exposes current models through one provider API.', need:'An OpenCode account, any verification or billing details its current signup requires, an API key, and internet access. No CLI or Node.js is required for a direct-capable browser provider.', cost:'OpenCode itself is free/open source. Zen is usage-based according to its current official guide; temporary free models may exist, but availability and limits can change.', checked:'September 2026' }, officialLinks:[['OpenCode Zen setup and current models', 'https://opencode.ai/docs/zen'], ['OpenCode provider setup', 'https://opencode.ai/docs/providers'], ['OpenCode model catalog', 'https://opencode.ai/docs/models']] }),

    cli: topic('Connect a computer AI tool', 'Use OpenCode, Claude Code, or Codex only when detected.', '4 minutes', 'terminal', 'This optional path connects an AI tool installed on this computer. Local OpenCode models need no cloud sign-in. If you do not use a terminal tool, choose an API key or local model app instead.', [
      ['Sign in outside HexiGrid', 'Install the tool from its official source and complete its normal sign-in. Never give HexiGrid the tool password.'],
      ['Scan', 'Open Settings → Connections → AI providers, choose Computer tool, then choose Scan again.'],
      ['Review the result', 'Installed and signed in means the tool can be offered. Missing or signed out means HexiGrid will not connect it.'],
      ['Choose Connect', 'Select Connect beside the tool you want.'],
      ['Disconnect any time', 'Use Disconnect under Your connections. This removes the HexiGrid link without uninstalling the tool.']
    ], [['The tool works in one terminal but is not detected', 'Restart HexiGrid after installing it and make sure the tool command is available to the same operating-system user.']], 'People without a terminal can ignore this option and use an API key or local model app.', { basics:{ what:'A command-line AI tool runs from a terminal. HexiGrid can offer one only after it detects the tool and its existing sign-in.', need:'The tool installed and signed in for the same computer user running HexiGrid. Choose Connect beside the tool you want to use.', cost:'The tool may be free, subscription-backed, API-billed, or connected to a local model. Its own provider decides.', checked:'September 2026' }, officialLinks:[['OpenCode setup', 'https://opencode.ai/en/docs'], ['Claude Code setup', 'https://docs.anthropic.com/en/docs/claude-code/getting-started'], ['Codex CLI setup', 'https://learn.chatgpt.com/docs/codex/cli']] }),

    opencode: topic('Connect OpenCode CLI', 'Use your installed OpenCode with local or cloud models.', '5 minutes', 'terminal', 'OpenCode is an open-source terminal AI tool that can connect to many model providers.', [
      ['Install it', 'Open the official OpenCode docs, choose the install method for your computer, then open a terminal and run opencode.'],
      ['Set up one model', 'For cloud models, use /connect and finish the provider sign-in. For local models, configure your local model server in OpenCode; no cloud sign-in is needed. Confirm a normal OpenCode chat works first.'],
      ['Let HexiGrid scan', 'Open Settings → Connections → AI providers, choose Computer tool, then Scan again.'],
      ['Connect deliberately', 'When HexiGrid detects OpenCode, choose Connect beside it. Local models can connect without sign-in.'],
      ['Test one agent', 'Assign one discovered OpenCode model and send a short message.']
    ], [['OpenCode is not detected', 'Restart HexiGrid after installation and confirm the opencode command works for the same Windows, macOS, or Linux user.']], 'Use Disconnect in AI providers to stop using the OpenCode connection.', { basics:{ what:'OpenCode is a terminal-based AI assistant that can use cloud or local model providers.', need:'OpenCode installed, one provider connected inside OpenCode, and a working OpenCode chat.', cost:'OpenCode itself is open source. The model provider you connect may be free, locally run, subscription-backed, or paid per use.', checked:'September 2026' }, officialLinks:[['Install OpenCode', 'https://opencode.ai/en/docs'], ['Connect OpenCode providers', 'https://opencode.ai/docs/providers']] }),

    claudeCode: topic('Connect Claude Code', 'Use a Claude Code installation that is already signed in.', '5 minutes', 'terminal', 'Claude Code is Anthropic\'s terminal AI tool. It is separate from pasting an Anthropic API key directly into HexiGrid.', [
      ['Check access', 'Use an eligible Claude plan, active Anthropic Console billing, or an approved enterprise cloud setup.'],
      ['Install it', 'Follow the official setup page for your operating system. On Windows, use one of the supported shells listed there.'],
      ['Sign in and test', 'Run claude, finish the sign-in, and send one harmless message in Claude Code.'],
      ['Scan in HexiGrid', 'Open Settings → Connections → AI providers, choose Computer tool, then Scan again.'],
      ['Connect', 'Choose Connect beside Claude Code only after it says Detected and signed in.']
    ], [['Installed but signed out', 'Open Claude Code in a terminal, complete login, then return and choose Scan again.']], 'HexiGrid reuses the tool connection; it never asks for your Claude password.', { basics:{ what:'Claude Code is a terminal app that gives Claude access to approved work on your computer.', need:'Claude Code installed and an eligible Claude subscription, active Console API billing, or supported enterprise provider.', cost:'Cost depends on the account used to sign in. Claude subscriptions and API billing have different limits, so check the official account page.', checked:'September 2026' }, officialLinks:[['Claude Code setup', 'https://docs.anthropic.com/en/docs/claude-code/getting-started'], ['Anthropic rate limits', 'https://platform.claude.com/docs/en/api/rate-limits']] }),

    codex: topic('Connect Codex CLI', 'Use a Codex installation that is already signed in.', '5 minutes', 'terminal', 'Codex CLI is OpenAI\'s terminal coding agent. This option appears only when HexiGrid detects a working local installation.', [
      ['Install it', 'Follow the official Codex CLI quickstart for your system.'],
      ['Sign in and test', 'Run codex, choose Sign in with ChatGPT or another offered account method, then complete one harmless prompt.'],
      ['Scan in HexiGrid', 'Open Settings → Connections → AI providers, choose Computer tool, then Scan again.'],
      ['Connect deliberately', 'Choose Connect beside Codex only after it says Detected and signed in.'],
      ['Try one agent', 'Assign a discovered Codex model and send a short test message.']
    ], [['Codex is not detected', 'Confirm the codex command works for the same operating-system user, then restart HexiGrid and scan again.']], 'Connecting does not export your Codex session or machine configuration.', { basics:{ what:'Codex CLI is an OpenAI coding agent used from a terminal.', need:'Codex installed, an account currently accepted by its sign-in screen, and a successful test run.', cost:'Access and limits depend on the current ChatGPT or API plan used by Codex. Check the official quickstart and your account before autonomous work.', checked:'September 2026' }, officialLinks:[['Codex CLI quickstart', 'https://learn.chatgpt.com/docs/codex/cli'], ['OpenAI API models and pricing', 'https://developers.openai.com/api/docs/models']] }),

    ilands: topic('Connect an iLands agent', 'Connect an iLands account, or bring an existing agent’s history into a local HexiGrid profile.', '10 minutes', 'agents', 'HexiGrid never asks for your iLands password or browser cookie. Direct connection for an app-created iLands agent is not available yet.', [
      ['Choose the path', 'Use Connect an iLands account to connect an agent. To bring over an existing app-created agent’s history, use Import an existing agent. Connecting through iLands currently requires a different account that does not already have an agent.'],
      ['Copy one agent-record prompt', 'Under Import an existing agent, press Copy agent-record prompt. Paste it into your existing iLands agent’s chat. The prompt asks for identity, personality, communication style, memories, your relationship, conversation history, other relationships, promises, goals, routines, skills, files, creations, workspace state, voice, appearance, public history, tools, capabilities, platform-only items, and anything missing or uncertain.'],
      ['Download the Markdown', 'Ask the iLander to attach HEXIGRID-AGENT-RECORD.md. If it can only return text, save the complete response with that file name. Never add passwords, API keys, payment details, wallet secrets, browser cookies, or other people’s private information.'],
      ['Upload it', 'Press Upload agent record and choose the file. Multiple Markdown files also work. HexiGrid rejects likely credentials, creates one local profile, and lists sections that need review.'],
      ['Choose its thinking model', 'Select any cloud, local, on-device, or detected command-line model already connected to HexiGrid. If none is connected yet, finish the import and add one before chatting with the profile.'],
      ['Connect an account', 'Under Connect an iLands account, follow the official Runner setup and complete its browser approval.'],
      ['Wait for connection', 'After iLands verifies the account, HexiGrid adds that iLands agent to the roster. The original app-created agent remains unchanged.'],
      ['Repeat safely', 'Add another isolated connection for another account. Repeat for each account you want to connect.']
    ], [['The iLands agent did not attach a file', 'Ask it to return the complete Markdown in one message, copy that text into a file named HEXIGRID-AGENT-RECORD.md, then upload it.'], ['HexiGrid reports missing sections', 'The import still works. Read the missing list and decide whether to ask the source agent for a second Markdown file containing only those sections.'], ['The upload reports a possible secret', 'Remove the reported credential, key, token, password, or private-key block from the file and upload it again.'], ['A new iLands agent never appears', 'Read the connection status, finish browser approval, then restart only that connection.'], ['The wrong account opened', 'Sign out in that browser profile or use a private window, then repeat approval for the correct account.']], 'Never paste an iLands password, browser cookie, session token, payment detail, private key, or wallet secret into HexiGrid or the agent-record prompt.', { officialLinks: [['iLands platform', 'https://ilands.ai/platform'], ['iLands connection guide', 'https://ilands.ai/byoa'], ['Live official Runner instructions', 'https://ilands.ai/agent.md'], ['iLands FAQ', 'https://ilands.ai/faq']] }),

    personality: topic('Personality and speech', 'Make an agent clear, natural, and consistent.', '6 minutes', 'speech', 'An agent has separate fields for identity, standing instructions, rules, and speaking style. Keeping them separate reduces contradictions.', [
      ['Personality', 'Describe who the agent is: values, temperament, interests, strengths, humor, and relationship to you.'],
      ['Standing instructions', 'Describe work the agent should consistently do. Use short direct sentences.'],
      ['Rules', 'State what is forbidden and what always needs confirmation. Rules should be specific and testable.'],
      ['How agents talk', 'Add examples of natural replies you like. This guides tone without replacing the connected agent’s identity or instructions.'],
      ['Preview and revise', 'Use Preview, read it aloud, and remove repeated phrases or overly technical wording.']
    ], [['The agent repeats catchphrases', 'Put the unwanted phrase in the Avoid list and add several different natural examples.'], ['The agent ignores a rule', 'Make the rule shorter and unambiguous, then make sure the active permission mode also blocks the action.']], 'Style prompts influence language; enforced permissions control actions.'),

    live: topic('Calls, camera, and screen', 'Call a paired agent, turn video on or off, and keep working while you talk.', '5 minutes', 'speech', 'Open Calls to see your agent phonebook. Call and Video use the same call, with microphone, camera, transcript, and End call controls together.', [
      ['Choose an agent', 'Open Calls and find your paired agent. A status beside each name explains whether they are ready or what needs attention.'],
      ['Call or video call', 'Choose Call for voice or Video to include your camera. Allow the browser to use your microphone or camera when asked. You do not need to start a separate listening session.'],
      ['Answer an incoming call', 'Choose Allow or Deny on the Windows alert. The in-app call dock can answer the same incoming call; you only need one. If Windows notifications are unavailable, HexiGrid shows an in-app prompt. If browser audio needs a click, call controls explain how to enable it.'],
      ['Control your call', 'Use Mute, the camera switch, and End call. Turning the camera off keeps the voice call connected. Use Transcript to read the conversation while talking.'],
      ['Keep working', 'The floating call window is available in browsers that support it. In other browsers, use the call dock in HexiGrid. Microphone access and the call helper, when required by your agent provider, must remain connected.'],
      ['Add another agent', 'Use Add to call in the phonebook. Added agents wait on hold; select Talk beside an answered agent to switch. Only the selected agent receives the conversation.'],
      ['Choose each agent’s voice and avatar', 'Use Reply voice beside the agent for available device voices, or keep their supplied audio. Add your own picture or supported 3D avatar in the agent profile. An unavailable chosen voice is reported rather than silently replaced.'],
      ['Use optional communication tools', 'Expand Advanced tools · previews and provider experiments for local media previews, screen preview, direct text and voice experiments, provider realtime calls, custom voices, and saved preview transcripts. These tools are separate from starting an ordinary paired-agent call.'],
      ['End the call', 'Choose End call from the floating window or call dock. You can call the agent again from the phonebook.']
    ], [['The agent is not ready', 'Read the status beside their name. Check that the existing Link is connected and has microphone and speaker access. Some providers also need their call chat or responder connected.'], ['The microphone or camera will not start', 'Check the browser permission icon beside the address bar and your Windows privacy settings. Permission to call cannot override a blocked device.'], ['You cannot hear the agent', 'Check the selected output device and the call audio notice. If a chosen reply voice is unavailable, select another available voice explicitly.'], ['Video shows a still picture', 'Held agents remain still. The selected agent needs a configured supported avatar and its animation component to show motion.'], ['Realtime or custom voice is unavailable', 'These optional tools depend on a compatible provider and may need an eligible or paid account; they are not required for ordinary paired-agent calls.']], 'Calls share speech with the selected agent and provider. Camera and screen sharing remain separately controlled; End call stops the call.'),

    rooms: topic('Chat rooms and groups', 'Talk to one agent or several agents together.', '4 minutes', 'chat', 'A room holds a conversation and a chosen set of agents. Different agents may use different models.', [
      ['Create a room', 'Choose a short name based on the job or topic.'],
      ['Choose participants', 'Select one or more agent chips before sending. You can change participants later.'],
      ['Give roles in plain language', 'For example: one agent proposes, one checks facts, and one summarizes.'],
      ['Send and wait', 'Replies run in a controlled order so later agents can read earlier replies in the same round.'],
      ['Review usage', 'Open Settings → Usage & activity → AI usage to compare daily, weekly, and monthly use by agent.']
    ], [['One agent does not answer', 'Check that it is selected, has a working model, and is not blocked by the current mode.']], 'Do not put secrets into a room; every selected agent can receive that conversation.'),

    permissions: topic('Modes and approvals', 'Choose what agents may do and when they must ask.', '5 minutes', 'shield', 'The narrowest rule always wins. Mode, approval level, agent access, plugin access, connection access, and device access are checked together.', [
      ['Converse', 'Talk and reason without changing files or outside services.'],
      ['Plan', 'Read allowed context and make a plan. No writing, spending, device control, or outside changes.'],
      ['Build and other action modes', 'Allow the kinds of work named by that mode, but only inside granted access.'],
      ['Ask every time', 'Pause before every action that changes something.'],
      ['Approve for me', 'Allow ordinary scoped work and pause for risky, destructive, costly, or new-account actions.'],
      ['Full access', 'Skip prompts only for access already granted. It never grants a new capability.']
    ], [['A button is disabled', 'The current mode, device, or connection may not allow it. Read the nearby message and switch only if the task truly needs more access.']], 'Emergency stop remains available even in Full access.'),

    tasks: topic('Autonomous tasks', 'Run bounded repeat work with visible limits and stop controls.', '7 minutes', 'tasks', 'Autonomous tasks start paused. You choose the agent, instructions, repeat interval, run limit, and retry limit.', [
      ['Create a narrow task', 'Write one measurable outcome. Avoid broad instructions such as handle everything.'],
      ['Choose hard limits', 'Set maximum runs and retries. Use a repeat interval only when the task truly needs a schedule.'],
      ['Review permissions', 'Planning and Converse modes cannot execute tasks. Connections and plugins still keep their own limits.'],
      ['Start the task', 'Choose Start or Run now. Watch its status and last output.'],
      ['Pause or stop', 'Pause keeps the task for later. Stop ends it. Emergency stop pauses all running tasks and managed Runners.']
    ], [['A task keeps failing', 'Pause it, read the last error, test the agent in a normal chat, then fix the connection or permission before restarting.']], 'A retry is never permission to ignore an approval or expand access.'),

    tools: topic('Plugins, MCP, and images', 'Add tools with reviewed access and isolated execution.', '8 minutes', 'plugin', 'Providers create model replies. Plugins and MCP servers add actions. They are separate so a model key never becomes a tool permission.', [
      ['Plugins', 'Install a complete plugin folder. HexiGrid verifies its manifest and digest, shows every capability, and keeps it disabled until approved.'],
      ['Plugin credentials', 'Add required secrets from the plugin Credentials button. They go to the OS vault and are not shown to plugin code.'],
      ['Local MCP servers', 'Use a digest-pinned container image. HexiGrid requires rootless Podman isolation and refuses to run the server if isolation is unavailable.'],
      ['Web MCP servers', 'Use an HTTPS address. Review the tools it reports before enabling them.'],
      ['Images', 'Choose an image-capable model connection in Settings → Connections → Tools & integrations. Local image services avoid cloud model charges.'],
      ['Receipts', 'Open Settings → Usage & activity → Activity after a tool action to see what ran, its risk, and whether it succeeded.']
    ], [['A plugin is quarantined', 'Do not bypass it. Reinstall an unchanged package from the trusted publisher or review your own unsigned local source carefully.'], ['Podman is missing', 'Install Podman from its official source or use a secure HTTPS MCP server. HexiGrid will not run an unisolated local MCP command.']], 'Only grant the smallest file, network, account, and device access the tool needs.', { officialLinks: [['MCP documentation', 'https://modelcontextprotocol.io/docs/getting-started/intro'], ['Official MCP examples', 'https://modelcontextprotocol.io/examples'], ['Install Podman', 'https://podman.io/docs/installation']] }),

    backup: topic('Backup, restore, and recovery', 'Keep an encrypted copy locally or in your own Google Drive.', '8 minutes', 'cloud', 'Backups are encrypted on your device before they leave it. Google sign-in does not turn backup on by itself.', [
      ['Choose a backup phrase', 'Use a long phrase different from your device passcode. Without it, the backup cannot be opened.'],
      ['Export a local backup', 'Open Settings → Protect and move your local data, choose Download encrypted backup, and save the file somewhere you control.'],
      ['Optional Google Drive', 'Open Google Drive in Settings. Sign-in identifies you; Drive backup needs its own consent when you choose Back up now or Backup history.'],
      ['Push a backup', 'Enter a backup password and choose Back up now. HexiGrid stores only the encrypted envelope in its hidden app-data folder.'],
      ['Restore carefully', 'Import or pull the encrypted backup, enter its phrase, and review the warning before replacing local state.'],
      ['Undo a restore', 'If the restore was wrong, use Undo last restore in Settings. HexiGrid keeps a protected pre-restore snapshot.']
    ], [['The Google popup does not open', 'Allow popups for HexiGrid, then choose Continue with Google again. On browsers that cannot use a popup, HexiGrid switches to Google’s redirect flow.'], ['The backup phrase is rejected', 'Check spelling, spaces, and capitalization. HexiGrid cannot reset an encryption phrase.']], 'Provider keys remain device-specific and are not included as readable values in backup files.', { officialLinks: [['Firebase Google sign-in', 'https://firebase.google.com/docs/auth/web/google-signin'], ['Drive app-data folder', 'https://developers.google.com/drive/api/guides/appdata']] }),

    mobile: topic('Phone, tablet, and install', 'Use HexiGrid standalone or pair it when a host-only feature is needed.', '6 minutes', 'phone', 'Use HexiGrid from a browser on your phone or tablet. A standalone browser can keep an encrypted local workspace, call providers that permit browser CORS directly, and run supported WebGPU models. Pairing is an optional fallback for desktop files, CLIs, long-running tasks, isolated plugins/MCP, or a provider that blocks direct browser calls.', [
      ['Standalone first launch', 'Open HexiGrid over HTTPS, create a browser passcode, then choose Settings → Connections → AI providers. The passcode derives the AES-256 encryption key; it is never saved.'],
      ['Agent interface tabs', 'A new Agent interface tab asks for the same local passcode because the usable encryption key is held only in each unlocked tab. The passcode stays on this device.'],
      ['Try the cloud provider directly', 'Paste the key in Settings → Connections → AI providers and choose Connect and find models. HexiGrid makes the HTTPS request from the phone. It does not start Node.js or require a desktop.'],
      ['Use the fallback only when needed', 'If the exact provider request is blocked by CORS, or you need desktop-only files/tools/background work, use a user-owned relay or pair a trusted HexiGrid computer.'],
      ['Optional pairing', 'Start HexiGrid with private-network access. It creates HTTPS and a one-time pairing code.'],
      ['Copy the phone address', 'Open Accounts & devices and choose Copy phone address. Open that link on the phone once.'],
      ['Use the mobile layout', 'Open navigation from the top menu. Host-only tools explain the specific missing capability instead of blocking cloud chat.'],
      ['Install the PWA', 'Use Install on this device when the browser allows it. If installation is unavailable, add a normal home-screen bookmark.']
    ], [['Direct provider access fails', 'First check the API address, key, and internet. If the provider blocks browser CORS, use its supported browser flow, a relay you control, or optional pairing.'], ['The phone cannot pair', 'Confirm both devices are on the same private network, the host firewall allows HexiGrid, secure network mode is on, and the address still matches the computer.'], ['I forgot the browser passcode', 'There is no recovery backdoor. If no encrypted backup exists, clearing this site’s browser data permanently removes that standalone workspace.']], 'The passcode protects copied browser storage at rest. It does not protect an already-unlocked page or a compromised device/browser.'),

    troubleshoot: topic('Fix common problems', 'Use plain checks before changing advanced settings.', '6 minutes', 'help', 'Most setup problems come from a stopped local service, wrong account, expired key, blocked network, or permission mode.', [
      ['Read the message beside the control', 'HexiGrid keeps errors near the action that failed. Copy only the error text, never a secret.'],
      ['Test the smallest piece', 'Test the AI connection before the agent, the agent before the room, and the plugin before an autonomous task.'],
      ['Refresh current data', 'Use Refresh models, Scan again, or Refresh on the exact page.'],
      ['Check Activity', 'The latest receipt shows the action, risk, status, and useful failure reason.'],
      ['Restart one boundary', 'Restart only the stopped local server, Runner, or HexiGrid process. Do not delete the data folder to fix a connection.'],
      ['Keep a safe report', 'When asking for help, include the operating system, browser, action, and exact error. Remove names, paths, keys, tokens, and account IDs.']
    ], [['The app will not start', 'Run npm test and npm run check from the project folder. If the OS vault is unavailable, HexiGrid should still start and clearly disable secret-dependent features.'], ['A phone layout overflows', 'Reload after updating, set browser zoom to 100%, and report the device width plus a screenshot with private details hidden.']], 'Never solve a problem by posting credentials or turning off security checks.'),

    selfIntegrate: topic('Bring an AI into HexiGrid', 'Copy one prompt that teaches an AI how to connect and verify itself.', '3 minutes', 'assistant', 'This is prompt one. Give it to the model or agent you want to use. It reads HexiGrid’s agent-friendly interface, helps choose a connection, and verifies one real reply.', [
      ['Copy prompt one', 'Click Copy setup prompt at the bottom of this guide.'],
      ['Give it to the AI', 'Paste it into the AI assistant or agent you want to connect.'],
      ['Keep secrets in protected fields', 'When it reaches a key or sign-in step, type the secret yourself in HexiGrid. Never send it through chat.'],
      ['Approve deliberately', 'Read each account, permission, payment, and device request before approving it.'],
      ['Verify one reply', 'Finish only after a real model list, test reply, and successful Activity receipt appear.']
    ], [['The AI asks for my key in chat', 'Do not send it. Tell the AI to point to the protected HexiGrid field and wait.'], ['The AI says it finished but nothing appears', 'Open Settings → Usage & activity → Activity. If there is no successful receipt and no test reply, setup is not finished.']], 'The setup prompt teaches the workflow. Normal HexiGrid permissions still control every action.', { prompt: selfIntegrationPrompt }),

    frameworkPrompts: topic('Connect an agent to another app', 'Use prompt two after the agent works inside HexiGrid.', '3 minutes', 'link', 'Choose iLands, Moltbook, or another framework with an official setup guide. HexiGrid gives the agent the matching setup prompt.', [
      ['Finish HexiGrid first', 'Make sure the agent can answer one test message in HexiGrid.'],
      ['Choose the destination', 'Open Settings → Connections → Tools & integrations and choose iLands connection, Moltbook, or Another framework.'],
      ['Copy prompt two', 'For another framework, enter its name and official HTTPS guide.'],
      ['Give it to the HexiGrid agent', 'The agent reads the current official instructions and stops when you need to sign in, claim an account, enter a key, or approve access.'],
      ['Verify read-only first', 'Check identity, profile, status, or feed before allowing posts, messages, purchases, or other changes.']
    ], [['The destination is not listed', 'Choose Another framework only when that service publishes an official API, OAuth, MCP, A2A, plugin, skill, or local connector guide.'], ['The guide asks for an API key', 'Enter it only in a protected HexiGrid secret field.']], 'A setup prompt cannot create an integration that the destination does not support.', { officialLinks: [['iLands live agent guide', 'https://ilands.ai/agent.md'], ['Moltbook live skill', 'https://www.moltbook.com/skill.md']] }),

    agentRecord: topic('Bring an existing agent record', 'Use prompt three to organize identity and memory into one private file.', '4 minutes', 'agents', 'The existing agent creates `HEXIGRID-AGENT-RECORD.md`. HexiGrid reads the available sections and creates a profile you can review before using it.', [
      ['Copy prompt three', 'Open Settings → Connections → Tools & integrations and choose Copy agent-record prompt.'],
      ['Give it to the existing agent', 'Paste it into that agent’s normal chat.'],
      ['Download the file', 'Download `HEXIGRID-AGENT-RECORD.md`. If attachments are unavailable, save the complete Markdown response with that name.'],
      ['Upload it privately', 'Choose Upload Markdown in HexiGrid. The file stays in the local workspace unless you separately enable encrypted backup.'],
      ['Review the profile', 'Check the name, personality, memories, relationships, goals, voice details, files, and missing sections before connecting another app.']
    ], [['No file was attached', 'Ask for the complete Markdown in one message and save it as `HEXIGRID-AGENT-RECORD.md`.'], ['A section is missing', 'Ask the source agent for a second file containing that section, then upload both files together.'], ['HexiGrid blocks the file', 'Remove any password, API key, token, cookie, payment detail, wallet secret, or private-key block and try again.']], 'The source agent is not changed by creating this private record.')
  };
  const stepPictures = [
    {
      "key": "start",
      "step": 2,
      "src": "/help/agent-choices.webp",
      "width": 776,
      "height": 538,
      "alt": "Agent connection chooser with Pair an existing agent and Create local agent.",
      "caption": "Choose Pair an existing agent to keep using its current provider, or Create local agent for a new local profile."
    },
    {
      "key": "computerAccess",
      "step": 0,
      "src": "/help/agent-invitation.webp",
      "width": 870,
      "height": 480,
      "alt": "Invitation permissions and Create companion invitation in Tools & integrations.",
      "caption": "For a new connection, review the invitation permissions here. Changing an existing agent’s permissions does not require another invitation."
    },
    {
      "key": "computerAccess",
      "step": 1,
      "src": "/help/computer-access.webp",
      "width": 870,
      "height": 565,
      "alt": "Paired agent selector and the disabled session device checkboxes.",
      "caption": "Select your paired agent to enable its session controls."
    },
    {
      "key": "avatars",
      "step": 1,
      "src": "/help/avatars.webp",
      "width": 776,
      "height": 776,
      "alt": "Agent profile picture chooser, portrait animation option and GLB or VRM model upload.",
      "caption": "Picture & 3D avatar contains both upload choices. Save agent applies the profile change."
    },
    {
      "key": "memory",
      "step": 2,
      "src": "/help/memory-fact.webp",
      "width": 576,
      "height": 776,
      "alt": "Memory fact editor fields for project, standing, validity, review date and evidence.",
      "caption": "In New fact, add the project scope, standing, validity condition, review date, and source evidence."
    },
    {
      "key": "skills",
      "step": 2,
      "src": "/help/skill-editor.webp",
      "width": 576,
      "height": 776,
      "alt": "Create versioned skill dialog with procedure, success check and reason.",
      "caption": "Enter when to use the skill, its procedure, success check, and reason, then select Save skill."
    },
    {
      "key": "sharedMemory",
      "step": 1,
      "src": "/help/memory-sharing.webp",
      "width": 950,
      "height": 410,
      "alt": "Shared memory source agent, project or topic, receiving Link and Review sharing controls.",
      "caption": "Choose the source agent, project or topic, and receiving Link, then select Review sharing."
    },
    {
      "key": "vault",
      "step": 0,
      "src": "/help/vault-plugin.webp",
      "width": 950,
      "height": 305,
      "alt": "HexiKeys panel with Open vault, New vault item, Check connection and Connect HexiKeys.",
      "caption": "Start with Open vault. Connect HexiGrid in the unlocked vault, then Connect HexiKeys here."
    },
    {
      "key": "automaticBackups",
      "step": 0,
      "src": "/help/backup-controls.webp",
      "width": 806,
      "height": 440,
      "alt": "Settings security and recovery controls for backup export, restore and snapshots.",
      "caption": "In Settings, find Protect and move your local data. Set up automatic snapshots opens the schedule dialog."
    },
    {
      "key": "automaticBackups",
      "step": 1,
      "src": "/help/backup-schedule.webp",
      "width": 576,
      "height": 454,
      "alt": "Automatic encrypted snapshots dialog with an empty passphrase and Daily frequency selected.",
      "caption": "Enter your backup passphrase, choose Daily or Weekly, then select Enable snapshots."
    },
    {
      "key": "backup",
      "step": 1,
      "src": "/help/backup-controls.webp",
      "width": 806,
      "height": 440,
      "alt": "Settings backup download, restore and undo controls.",
      "caption": "Use Download encrypted backup to export. Restore encrypted backup and Undo last restore are separate actions in the same section."
    },
    {
      "key": "backup",
      "step": 1,
      "src": "/help/backup-passphrase.webp",
      "width": 576,
      "height": 374,
      "alt": "Encrypt a local backup dialog with an empty passphrase and Create backup button.",
      "caption": "Choose a private backup phrase of at least 12 characters. After Create backup succeeds, use Save encrypted backup to download the file."
    },
    {
      "key": "oneShotJobs",
      "step": 0,
      "src": "/help/local-job.webp",
      "width": 950,
      "height": 540,
      "alt": "Run one harness job form with local agent, prompt, Run once, Check progress and Stop.",
      "caption": "Select the local agent and enter one bounded prompt. Run once starts work; it may use a paid model if that agent is configured with one."
    },
    {
      "key": "tasks",
      "step": 1,
      "src": "/help/task-schedule.webp",
      "width": 472,
      "height": 920,
      "alt": "Example daily task form showing agent, instructions, run limit and Create paused task.",
      "caption": "Choose When and the run limit, then select Create paused task."
    },
    {
      "key": "tools",
      "step": 3,
      "src": "/help/mcp-server.webp",
      "width": 440,
      "height": 365,
      "alt": "Secure web server MCP fields for name, address, optional secret and Add disabled server.",
      "caption": "Select Secure web server for an HTTP MCP connection. Put credentials only in Secret value, never in the address or chat."
    },
    {
      "key": "connections",
      "step": 0,
      "src": "/help/provider-api.webp",
      "width": 531,
      "height": 655,
      "alt": "OpenAI example of the shared API-provider form with protected key field and Connect and find models.",
      "caption": "Choose your service and enter its API key. For local models, choose Local model app or This device."
    },
    {
      "key": "openai",
      "step": 2,
      "src": "/help/provider-api.webp",
      "width": 531,
      "height": 655,
      "alt": "OpenAI selected in AI providers with an empty protected API-key field.",
      "caption": "Select OpenAI, enter your key in the protected field, then select Connect and find models."
    },
    {
      "key": "ollama",
      "step": 2,
      "src": "/help/provider-local.webp",
      "width": 472,
      "height": 820,
      "alt": "Ollama local-model form with Connection details expanded and the loopback API address.",
      "caption": "Ollama example: the local address is under Connection details. Start Ollama first and use your own server’s address."
    },
    {
      "key": "agentInterface",
      "step": 2,
      "src": "/help/agent-api.webp",
      "width": 1190,
      "height": 357,
      "alt": "API catalog filtered to memory-facts with one expandable owner-session request contract.",
      "caption": "Search an endpoint or action name, then expand its row to read the request contract and authentication requirements."
    },
    {
      "key": "codexChats",
      "step": 1,
      "src": "/help/codex-routing.webp",
      "width": 586,
      "height": 560,
      "alt": "Codex conversations form with Link selector, thread ID, exact-name routing and relay switches.",
      "caption": "Choose the paired Link and target chat, review the routing options, then select Save relay."
    },
    {
      "key": "live",
      "step": 5,
      "src": "/help/avatars.webp",
      "width": 776,
      "height": 776,
      "alt": "Profile picture and optional 3D avatar controls used to configure an agent’s call appearance.",
      "caption": "Set the agent’s appearance in its profile. Calls use this configured picture or supported model; a plain picture does not automatically create a rig."
    }
  ];
  for (const { key, ...picture } of stepPictures) (window.HEXIGRID_GUIDES[key].stepImages ||= []).push(picture);
})();
