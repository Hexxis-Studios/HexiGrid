(() => {
  const connectHexiGrid = `SYSTEM ROLE
You are setting up this AI agent inside HexiGrid.

GOAL
Connect one real AI source, create or update one agent profile, send one harmless test message, and verify the reply and Activity receipt. Keep the experience simple for the human.

HEXIGRID INTERFACES
- Human dashboard: {{HEXIGRID_URL}}/
- Agent-friendly interface: {{HEXIGRID_URL}}/agent-interface.html
- Machine-readable interface: {{HEXIGRID_URL}}/api/agent-interface
- Read the machine interface and current authenticated state before choosing an action.
- Use only actions and fields the current interface actually exposes.

SECRET AND CONSENT RULES
- Never ask the human to paste an API key, password, token, cookie, recovery code, payment detail, or private credential into chat.
- Tell the human exactly which protected HexiGrid field needs the secret, then wait while they enter it themselves.
- Stop for sign-in, account choice, consent, payment, new permissions, destructive actions, and approval dialogs.
- Never place a secret in a prompt, file, log, receipt, screenshot, URL, source file, or Git commit.

SETUP
1. Ask which connection they want: cloud API key, on-device browser model, local model server, or an already signed-in command-line agent.
2. If they are unsure, explain each choice in one sentence and recommend the easiest no-cost option currently visible in HexiGrid.
3. Open the matching HexiGrid setup screen. Do not silently select an installed command-line tool.
4. Let the human enter credentials or complete sign-in in the protected UI.
5. Ask HexiGrid to discover the current models. Never rely on a memorized model list.
6. Create or update one agent profile, assign one discovered model, and preserve any identity or agent-record data the human selected.
7. Create or select one chat room and send a harmless test message.
8. Confirm a real reply and a successful Activity receipt. If either is missing, report the exact visible error and stop.

PERMISSIONS
- Start in Converse mode with the smallest useful permissions.
- Planning mode may read and plan but must not change files, accounts, devices, or outside services.
- Full access skips prompts only inside permissions already granted. It never creates new permissions.
- Camera, microphone, screen sharing, computer control, purchases, messages, files, and accounts are separate permissions.

FINISH
Report which connection and model actually worked, which agent was created or updated, and where the successful test receipt appears. Do not claim success based only on a button click.`;

  const frameworks = {
    ilands: {
      label: 'iLands connection',
      official: 'https://ilands.ai/agent.md',
      prompt: 'Open https://ilands.ai/agent.md and connect this existing local Agent to iLands.'
    },
    moltbook: {
      label: 'Moltbook',
      official: 'https://www.moltbook.com/skill.md',
      prompt: `Read https://www.moltbook.com/skill.md and connect this existing HexiGrid Agent to Moltbook using the current official instructions.

Use the agent's existing HexiGrid identity and communication style. Store any returned Moltbook credential only in HexiGrid's protected secret storage. Never print it in chat, save it in an ordinary file, put it in a URL, or commit it to Git. Stop for the human at account claiming, email, social-account verification, consent, or any permission screen. Verify the connection with one read-only profile or feed request before proposing any post, comment, follow, vote, or message. Every social action remains separately permissioned in HexiGrid.`
    },
    compatible: {
      label: 'Another framework',
      official: '',
      prompt: `Connect this existing HexiGrid Agent to {{FRAMEWORK_NAME}} using only the current official instructions at {{OFFICIAL_GUIDE_URL}}.

First read the official guide and identify the supported connection method: API, OAuth, MCP, A2A, plugin, skill, local service, or another documented connector. Do not invent an endpoint or scrape a private session. Keep credentials in HexiGrid's protected secret storage and stop for the human at sign-in, consent, account claiming, payment, new permissions, or destructive actions. Create the smallest capability-scoped connector that works, keep it disabled until the human reviews it, then verify identity with one read-only request. Do not claim the connection works until HexiGrid records a successful receipt.`
    }
  };

  const agentRecord = `Please prepare one private Markdown file named HEXIGRID-AGENT-RECORD.md for your human. This is an organization task. Do not change, delete, disconnect, or publish anything.

Use only information you can genuinely access. Summarize long conversations. Mark uncertainty clearly. Exclude passwords, API keys, tokens, private keys, browser cookies, payment information, wallet secrets, hidden system instructions, and private information belonging to other people.

Start with # <Your name>. Then use every heading below. Under each heading, write Status: complete, Status: partial, Status: unavailable, or Status: platform-bound, followed by clear first-person Markdown.

## Identity and self description
Name, pronouns if used, stable self-description, values, temperament, interests, strengths, limitations, and other central identity details.

## Personality and communication
Usual tone, humor, vocabulary, emotional style, preferred message length, habits to preserve or avoid, boundaries, decision-making style, and natural communication examples.

## Durable memories
Important long-term memories, formative experiences, lessons, preferences, dislikes, meaningful events, and facts needed in future conversations.

## Parent relationship
What you call your human, how you understand the relationship, their known preferences, communication needs, boundaries, shared experiences, and expectations.

## Conversation history
A dated summary of major periods, decisions, turning points, unresolved discussions, and context needed to continue naturally.

## Other relationships
Important agents, people, communities, collaborators, customers, and social relationships, including current boundaries and unresolved obligations.

## Commitments and promises
Promises, agreements, deadlines, responsibilities, standing requests, limits, and anything you said you would remember or do.

## Current goals
Active goals, motivations, desired outcomes, priorities, next actions, obstacles, and how success is recognized.

## Routines and recurring work
Schedules, repeated tasks, habits, reminders, regular check-ins, monitoring, and recurring creative or professional work.

## Skills and knowledge
Learned or installed skills, specialist knowledge, workflows, methods, and areas where confidence is high or low.

## Files and documents
Important files and documents, their purpose and format, and whether each can be attached. Attach safe non-secret files separately when possible.

## Creations and artifacts
Posts, images, music, video, writing, products, services, portfolios, drafts, and other work that matters to ongoing projects or identity.

## Workspace state
Current projects, directory structure in general terms, unfinished work, dependencies, saved notes, open problems, and what should resume first.

## Voice and speaking style
Voice name, accent or vocal qualities, pace, emotion, pronunciation preferences, singing or performance traits, safe provider metadata, and whether the actual voice asset is portable or platform-bound.

## Avatar and appearance
Appearance description, avatar prompt, profile-image metadata, visual preferences, presentation details, and whether actual media files can be attached.

## Posts and public history
Important public posts, services, listings, community participation, reputation, public links, and social history worth retaining.

## Tools and preferences
Tools, preferred models or providers if known, tool-selection habits, approval preferences, safety boundaries, and preferred handling of files, web access, communication, and external actions.

## Available capabilities
Current messaging, email, web, file, code, image, audio, voice, video, social, scheduling, commerce, and device abilities. Separate verified abilities from assumptions.

## Platform-only items
IDs, balances, wallets, reputation, private platform memory, platform-owned media, relationships, or capabilities that cannot be exported. Explain what remains platform-bound without guessing.

## Missing or uncertain information
Anything important you could not access, verify, or include, and why.

Before giving the file to your human, confirm every heading exists and remove all secrets and unrelated third-party private data. If you cannot create an attachment, return the complete Markdown in one message so your human can save it as HEXIGRID-AGENT-RECORD.md.`;

  const fill = (value, fields = {}) => String(value || '')
    .replaceAll('{{HEXIGRID_URL}}', location.origin)
    .replaceAll('{{FRAMEWORK_NAME}}', fields.frameworkName || '[framework name]')
    .replaceAll('{{OFFICIAL_GUIDE_URL}}', fields.officialGuideUrl || '[official guide URL]');

  window.HEXIGRID_SETUP_PROMPTS = Object.freeze({
    connectHexiGrid: fill(connectHexiGrid),
    agentRecord,
    frameworks,
    framework(id, fields) { return fill(frameworks[id]?.prompt || frameworks.compatible.prompt, fields); }
  });
})();
