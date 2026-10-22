# Local animated call portraits

HexiGrid adapts the MIT LivePortrait human portrait engine from
https://github.com/KlingAIResearch/LivePortrait at the exact commit in
`source-manifest.json`. MIT human weights are fetched from the pinned official
KlingTeam model revision with SHA-256 verification. Upstream receives credit;
we do not claim to have invented its animation model.

The integration does not install InsightFace or download its research-only
detector weights. It uses OpenCV's bundled frontal-face Haar detector and the
LivePortrait landmark model. Upstream's LICENSE remains with the downloaded
source. OpenCV 4.10 is Apache-2.0; its bundled cascade retains its Intel notice.

## Product flow

Agents → edit profile → Picture & 3D avatar → Choose picture → Save.
New pictures default to animation. Existing pictures have an Animate picture
button. Users may turn animation off and keep their still picture and 3D model.
Portrait preparation runs locally once; calls play a cached 18-pose WebP atlas,
with blinking and mouth opening driven by the actual speaker waveform.
This is amplitude-driven mouth movement, not a full-body Live2D rig or phoneme
accurate speech animation. No image/audio is sent to an external provider.

The first preparation sets up an isolated Python 3.12 environment and model
weights; it needs internet for these public downloads, disk space (roughly
5 GB for the NVIDIA runtime; CPU setup is smaller), and Node/git/Python tooling.
On Windows with the Python install manager, Python 3.12 can be installed by the
setup action if missing. On other platforms Python 3.12 must already exist.
Setup never installs GPU drivers or changes global Python packages. Later
preparations and all portrait playback work offline without a paid service.

## Same tool for the paired agent

`avatar-portrait --connection <existing connection> --image <local PNG/JPEG/WebP>`
changes only that Link's own avatar and prepares it. Omit `--image` to animate
the existing picture. `avatar-portrait-read` returns its preparation status.
`avatar-portrait --still true` switches back to the still picture.

Signed GET/POST `/agent-link/v1/avatar/portrait` uses the existing `messages`
scope and conversation policy; it cannot select another agent. POST takes
`{imageData?: "data:image/...;base64,...", animate?: boolean}`. It returns 202
with a job; GET returns `{job,ready,portrait,image}`. Revocation, policy changes
and newer avatar edits invalidate an unfinished commit. Runtime setup remains
an owner action; an agent can use the already prepared local engine.

For developers: `node scripts/install-portrait-runtime.mjs`, then
`python integrations/liveportrait/prepare_portrait.py --root <app> --source <image> --destination <atlas.webp>`.
Do not accept user motion pickle files or arbitrary model checkpoints.
