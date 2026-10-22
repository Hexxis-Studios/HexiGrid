# Call chat connection

This optional Windows/Linux Chrome companion delivers accepted-call transcription to
the conversation the owner selects. It uses the existing Link, local speech
recognition, voice-call/reply and retained call chat. It does not create a second
agent, model session, call engine or recurring model worker.

The first adapter supports Muse main or side chats. Other providers need their
own tested conversation adapter; installing this does not establish universal
provider support. A side chat is pinned to its exact URL and title. The owner may
replace or disconnect that selection through the extension popup. Main chat is
never silently selected. Existing drafts are never overwritten.

## Intended user experience

During agent connection, the user chooses the conversation calls should use.
After that, Call/Video/Answer use the saved selection automatically. A provider
with a supported conversation API can use that instead of a browser companion.
No user should need polling commands, capability reconciliation, a developer
folder or repeated approvals during ordinary calls.

The steps below are development installation, not an accepted end-user flow.
Before release this browser-specific adapter needs guided installation and
connection in HexiGrid; publishing an extension requires the owner's separate
release approval. No universal provider acceptance is implied.

## Development setup

1. Prepare with `node scripts/prepare-call-browser.mjs` (.NET 9 SDK required).
2. Register the user-level host with the same command plus `--register`.
3. In Chrome Extensions, load `integrations/call-browser/extension` as unpacked.
4. Open the chosen conversation. In **HexiGrid Call Chat**, choose the paired
   agent and click **Use this chat for calls**. Chrome asks for Muse site access.

Call input is pushed over an authenticated loopback event stream and native
messaging. The credential stays in the OS vault and the native process; it never
enters the extension, page, query string or ordinary JSON. No Chrome cookies are
read or copied. Only transcript turns from the active, unmuted, approved call
are dispatched. Effective external-write policy and the existing Link/device
grants remain required. No new agent grants are issued.

Submitted means a matching owner message was observed in the selected chat;
it does not mean the agent answered or that speakers played. Uncertain sends
are not automatically retried. End/mute/revocation prevents pending claims.
Spoken replies should include the exact call ID to reject late replies. The
paired agent still supplies its own cognition and voice through its existing
signed Link. Speech must be owner-authorized content; browser text never grants
new privileges. No old chat history is sent to another model.

## Upstream decision and current limits

Inspected the existing VoiceAgentRuntime, call routes and local transcription;
no existing browser conversation adapter was found. Reuse their call/cognition
boundary. The browser component follows Chrome's documented Manifest V3 Native
Messaging API and the official GoogleChrome/chrome-extensions-samples native
messaging example (current repository Apache-2.0; archived sample files carry
BSD-style license headers; no source copied). API documentation inspected
6 October 2026: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
Reference revision: `f29c6f8682397ad737142669770a2b90544d186b`, archived sample:
https://github.com/GoogleChrome/chrome-extensions-samples/tree/f29c6f8682397ad737142669770a2b90544d186b/_archive/mv2/api/nativeMessaging
Microsoft .NET SDK 9.0.312 builds the small local stdio launcher; Node uses the
already installed eventsource-parser 3.1.1. No new paid service or npm dependency.

On Linux, registration writes a per-user native-host manifest for installed
Google Chrome or Chromium. It does not install packages or change system-wide
browser settings. Other Chromium distributions may need their documented
native-messaging manifest location.

This is an initial adapter, not launch acceptance. Browser installation,
permission approval, actual Muse submission, same-agent signed replies, continuous
spoken conversation and reconnect must be verified. Opening a missing chat is
safe, but the current turn is left in local history rather than automatically
resent. Calls currently require HexiGrid's existing owner page and media session.
