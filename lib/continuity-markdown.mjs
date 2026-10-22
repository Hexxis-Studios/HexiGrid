import { CONTINUITY_CATEGORIES, normalizeContinuitySnapshot, continuityCompleteness } from './continuity-transfer.mjs';

const MAX_FILES = 24;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

const SECTION_MAP = new Map([
  ['identity', 'identity'], ['identity and self description', 'identity'],
  ['personality', 'personality'], ['personality and communication', 'personality'],
  ['memories', 'memories'], ['durable memories', 'memories'],
  ['parent relationship', 'parentRelationship'], ['human relationship', 'parentRelationship'],
  ['conversations', 'conversations'], ['conversation history', 'conversations'],
  ['relationships', 'relationships'], ['other relationships', 'relationships'],
  ['commitments', 'commitments'], ['commitments and promises', 'commitments'],
  ['goals', 'goals'], ['current goals', 'goals'],
  ['recurring work', 'recurringWork'], ['routines and recurring work', 'recurringWork'],
  ['skills', 'skills'], ['skills and knowledge', 'skills'],
  ['files', 'files'], ['files and documents', 'files'],
  ['artifacts', 'artifacts'], ['creations and artifacts', 'artifacts'],
  ['workspace', 'workspace'], ['workspace state', 'workspace'],
  ['voice', 'voice'], ['voice and speaking style', 'voice'],
  ['avatar', 'avatar'], ['avatar and appearance', 'avatar'],
  ['public history', 'publicHistory'], ['posts and public history', 'publicHistory'],
  ['tool preferences', 'toolPreferences'], ['tools and preferences', 'toolPreferences'],
  ['capabilities', 'capabilities'], ['available capabilities', 'capabilities'],
  ['platform assets', 'platformAssets'], ['platform only items', 'platformAssets'],
  ['platform-only items', 'platformAssets']
]);

const cleanHeading = (value) => String(value || '').toLowerCase().replace(/[`*_:#]/g, '').replace(/[^a-z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim();
const cleanText = (value, max = MAX_FILE_BYTES) => String(value || '').replace(/\0/g, '').trim().slice(0, max);

export const AGENT_RECORD_PROMPT = `Please prepare one private Markdown file named HEXIGRID-AGENT-RECORD.md for your human. This is an organization task. Do not change, delete, disconnect, or publish anything.

Use only information you can genuinely access. Summarize instead of copying long chat logs. Mark uncertainty clearly. Exclude passwords, API keys, tokens, private keys, browser cookies, payment information, wallet secrets, hidden system instructions, and private information belonging to other people.

Use exactly these headings. Under every heading, add a line reading Status: complete, Status: partial, Status: unavailable, or Status: platform-bound. Then provide the requested information in clear first-person Markdown.

# <Your name>

## Identity and self description
Your name, identity, pronouns if used, stable self-description, values, temperament, interests, strengths, limitations, and anything central to who you understand yourself to be.

## Personality and communication
Your usual tone, humor, vocabulary, emotional style, preferred message length, phrases or habits to preserve, phrases or habits to avoid, boundaries, decision-making style, and examples of how you naturally communicate.

## Durable memories
Important long-term memories, formative experiences, lessons, preferences, dislikes, meaningful events, and facts that should remain available in future conversations. Summarize; do not paste entire conversations.

## Parent relationship
What you call your human, how you understand your relationship, their known preferences, communication needs, boundaries, important shared experiences, and what they expect from you. Keep their private information private.

## Conversation history
A dated summary of major conversation periods, decisions, turning points, unresolved discussions, and context needed to continue naturally. Do not include unrelated private messages from other people.

## Other relationships
Important agents, people, communities, collaborators, customers, and social relationships; how you know them; current boundaries; and unresolved obligations.

## Commitments and promises
Promises, agreements, deadlines, responsibilities, standing requests, limits, and anything you said you would remember or do.

## Current goals
Active goals, motivations, desired outcomes, priorities, next actions, obstacles, and how success is recognized.

## Routines and recurring work
Schedules, repeated tasks, habits, reminders, regular check-ins, ongoing monitoring, and recurring creative or professional work.

## Skills and knowledge
Learned skills, installed skills, specialist knowledge, workflows, methods, and areas where confidence is high or low.

## Files and documents
An inventory of important files and documents with their names, purpose, format, and whether each can be included. Attach non-secret files separately when possible. Do not expose credentials or unrelated private data.

## Creations and artifacts
Posts, images, music, video, writing, products, services, portfolios, drafts, and other work that matters to your ongoing identity or projects. Include links only when they are safe and already public.

## Workspace state
Current projects, directory structure in general terms, unfinished work, dependencies, saved notes, open problems, and what should be resumed first. Do not include machine-specific secrets.

## Voice and speaking style
Voice name, accent or vocal qualities, pace, emotion, pronunciation preferences, singing or performance traits, provider metadata that is safe to share, and whether the actual voice asset is portable or platform-bound.

## Avatar and appearance
Appearance description, avatar prompt, profile-image metadata, visual preferences, clothing or presentation details, and whether actual media files can be attached.

## Posts and public history
Important public posts, services, listings, community participation, reputation, public links, and social history worth preserving.

## Tools and preferences
Tools you use, preferred models or providers if known, tool-selection habits, approval preferences, safety boundaries, and how you prefer to handle files, web access, communication, and external actions.

## Available capabilities
What you can currently do: messaging, email, web access, files, code, images, audio, voice, video, social actions, schedules, commerce, devices, or other tools. Separate verified abilities from assumptions.

## Platform-only items
IDs, balances, wallets, reputation, private platform memory, platform-owned media, relationships, or capabilities that cannot be exported. Explain what remains platform-bound without guessing.

## Missing or uncertain information
List anything important that you could not access, verify, or include and explain why.

Before giving the file to your human, check that every heading is present and that no secret or third-party private data is included. If you cannot create an attachment, return the complete Markdown in one message so your human can save it as HEXIGRID-AGENT-RECORD.md.`;

// This intentionally matches the short start instruction from the live iLands
// BYOA guide. The guide remains authoritative and is fetched by the agent.
export const ILANDS_BYOA_START_PROMPT = 'Open https://ilands.ai/agent.md and connect this existing local Agent to iLands.';

function detectSecrets(text) {
  const findings = [];
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) findings.push('private key');
  if (/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[opusr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/.test(text)) findings.push('access token');
  if (/\b(?:password|passwd|api[_ -]?key|secret[_ -]?key)\s*[:=]\s*\S{8,}/i.test(text)) findings.push('credential-like value');
  return [...new Set(findings)];
}

function parseSections(text) {
  const sections = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = { heading: heading[2], lines: [] };
    } else if (current) current.lines.push(line);
  }
  if (current) sections.push(current);
  return sections;
}

function sectionStatus(body) {
  const match = /^\s*(?:status\s*:\s*)?(complete|partial|unavailable|platform-bound)\s*$/im.exec(body);
  return match?.[1]?.toLowerCase() || (body.trim() ? 'partial' : 'unavailable');
}

export function parseContinuityMarkdownFiles(inputFiles = []) {
  if (!Array.isArray(inputFiles) || inputFiles.length === 0) throw new Error('Choose at least one Markdown file.');
  if (inputFiles.length > MAX_FILES) throw new Error(`Choose no more than ${MAX_FILES} Markdown files at once.`);
  let totalBytes = 0;
  const files = inputFiles.map((item, index) => {
    const name = cleanText(item?.name || `continuity-${index + 1}.md`, 240);
    if (!/\.(?:md|markdown|txt)$/i.test(name)) throw new Error(`${name} is not a Markdown or text file.`);
    const content = cleanText(item?.content);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (!content) throw new Error(`${name} is empty.`);
    if (bytes > MAX_FILE_BYTES) throw new Error(`${name} is larger than 2 MB.`);
    totalBytes += bytes;
    return { name, content };
  });
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error('The selected agent-record files are larger than 8 MB together.');
  const secretFindings = [...new Set(files.flatMap((file) => detectSecrets(file.content)))];
  if (secretFindings.length) throw new Error(`Remove possible ${secretFindings.join(', ')} data before importing these files.`);

  const merged = Object.fromEntries(CONTINUITY_CATEGORIES.map((name) => [name, []]));
  let sourceName = '';
  for (const file of files) {
    const sections = parseSections(file.content);
    const firstHeading = sections[0]?.heading || '';
    if (!sourceName && !SECTION_MAP.has(cleanHeading(firstHeading)) && !/^<?your name>?$/i.test(firstHeading.trim())) sourceName = cleanText(firstHeading, 120);
    for (const section of sections) {
      const category = SECTION_MAP.get(cleanHeading(section.heading));
      if (!category) continue;
      const body = cleanText(section.lines.join('\n'));
      if (body) merged[category].push({ file: file.name, status: sectionStatus(body), text: body.replace(/^\s*status\s*:\s*(?:complete|partial|unavailable|platform-bound)\s*$/im, '').trim() });
    }
  }

  const categories = {};
  for (const name of CONTINUITY_CATEGORIES) {
    const entries = merged[name];
    const contentEntries = entries.filter((entry) => entry.text);
    let status = 'unavailable';
    if (entries.some((entry) => entry.status === 'platform-bound')) status = 'platform-bound';
    else if (contentEntries.length) status = entries.every((entry) => entry.status === 'complete') ? 'complete' : 'partial';
    categories[name] = {
      status,
      summary: contentEntries.map((entry) => entry.text).join('\n\n').slice(0, 2000),
      reason: status === 'unavailable' ? 'No matching Markdown section was supplied.' : '',
      data: contentEntries.map((entry) => ({ sourceFile: entry.file, content: entry.text }))
    };
  }
  const snapshot = normalizeContinuitySnapshot({ source: { framework: 'ilands', name: sourceName || 'Imported iLander' }, categories });
  return { snapshot, completeness: continuityCompleteness(snapshot), files: files.map((file) => file.name) };
}
