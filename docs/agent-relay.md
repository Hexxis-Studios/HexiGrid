# HexiGrid public agent relay

The public agent relay is a provider-neutral entry path for remote agents. The native HexiGrid process remains bound to loopback. The production agent path is the outbound companion: the agent makes HTTPS requests to the invitation relay and never requires an inbound listener or an SSH tunnel. A browser invitation remains available as a fallback for agents that cannot run the companion client.

## Trust boundaries

- Owner APIs, workspace state, native screen capture, and native input stay on the owner device.
- The temporary reference deployment uses an outbound Cloudflare Quick Tunnel only as an HTTPS/WebSocket carrier. It does not expose the HexiGrid server or its owner API. The companion connects outward to the relay; SSH is not part of the production protocol.
- Browser-to-device payloads are encrypted with AES-256-GCM above TLS. Pairing uses a key derived from the invitation secret. Connected requests use a key derived from the one-time Link token. The relay sees routing identifiers, message sizes, and timing, but not tokens, frames, input, or response bodies.
- WebRTC DataChannel is an optional browser optimization. The reliable fallback and the outbound companion use ordinary HTTPS send/long-poll requests, so an agent does not require WebSocket access. The application security and signed Link protocol are identical on both transports.
- Existing Link HMAC signatures, request timestamps, nonce replay rejection, capability intersection, and native bridge policy checks run on the local server after decryption.

## Authorization lifecycle

1. The owner starts the outbound public relay and creates a 15-minute, single-use invitation.
2. The agent runs `integrations/hexigrid-link/scripts/companion_client.mjs pair ...`. The companion makes only outbound HTTPS requests, proves possession of the fragment-only invitation secret, and receives a Link token once.
3. The companion stores the Link token only through the protected secret store and keeps routing/session metadata separate from private agent data.
4. After a short network failure, the companion reopens a new relay session using the paired connection proof, resumes event/media sequence positions, and keeps the signed Link protocol unchanged.
5. An agent that can operate a browser but cannot install the companion can open its invitation in a tab. The page exposes only the actions granted to that Link (including messages and scoped HexiSpace actions); it does not require screen access. Its token stays in tab memory, so closing the tab ends that browser session and a new invitation is needed to pair again. Continuity export and long-running background work still require a capable runtime and the corresponding scopes. The owner separately starts computer access for that exact Link, choosing view and control grants.
6. Takeover pauses input while preserving view. Stop disables both. Revoke rotates the Link token and terminates matching companion and browser sessions. Emergency stop remains locally authoritative.

## Failure behavior

- Relay loss, device loss, decryption failure, invalid HMAC, replay, expiry, policy denial, Stop, or revoke all fail closed.
- Restarting HexiGrid closes the temporary relay and invalidates its routing device ID. The companion will reconnect while the relay remains available; after the owner process itself restarts, a fresh invitation/relay registration is required.
- No relay credential, Link token, or invitation secret is written to browser storage, logs, receipts, or ordinary JSON state.

## Outbound companion contract

The companion channel is exposed at the same relay origin under:

- `POST /relay/v1/companion/open`
- `POST /relay/v1/companion/send`
- `GET /relay/v1/companion/poll`
- `POST /relay/v1/companion/close`

These endpoints accept only the companion's short-lived relay bearer and opaque `relay`/`chunk` messages. The relay never receives the Link token, request body, screen frame, audio, or model response in plaintext. Each request is encrypted with AES-256-GCM, and the owner still validates the signed Link request after decryption.

The Node companion client uses only Node 22 built-ins. It splits large encrypted payloads into bounded chunks, applies bounded exponential reconnect backoff, rejects replayed/invalid encrypted responses, and resumes already-paired sessions without reusing the one-time invitation secret. A paired-session reopen is accepted only when the connection ID and stored Link-token hash match the owner-side connection.

The reference relay uses ordinary HTTP and WebSocket interfaces and can be deployed behind any HTTPS provider. A production deployment may add an independently operated TURN/TLS service with short-lived credentials for browser WebRTC candidates, but TURN is not required for the companion path.
