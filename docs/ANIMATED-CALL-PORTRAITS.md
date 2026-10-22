# Talking portraits and several agents in a call

## Use a picture

In **Agents**, edit an agent, choose a picture under **Picture & 3D avatar**,
and Save with **Animate picture** enabled. Existing pictures also have an
**Animate picture** button. Use a clear front-facing PNG, JPEG or WebP.
GIFs keep their existing animation. Turning portrait animation off preserves
the picture and 3D model.

Preparation happens locally once. First setup downloads the engine and weights:
roughly 5 GB for NVIDIA, smaller for CPU. Calls use cached frames with blinking
and mouth opening following actual audio. This is a talking portrait, not a
full-body rig or phoneme-accurate lip synchronization. Unsuitable pictures may
fail preparation; the previous avatar stays in place. No image/audio is sent
to an animation provider and no paid service is required.

Agents use the same own-profile tool through their existing signed Link:
`avatar-portrait --connection <id> --image <picture>` and
`avatar-portrait-read --connection <id>`. First runtime setup is owner-only.
See `integrations/liveportrait/README.md` for upstream credit and exact API.

## Add another agent

Start a call from **Calls**. Choose **Add** beside another paired agent with
approved microphone and speaker access. It answers on hold. In the floating
window, **Talk** selects an answered participant and holds the previous one.
Only the selected agent receives new speech/camera frames; held agents show
still pictures. Video on/off uses the same call. Selecting an agent does not
transfer computer-control permissions. Owner End ends the group; a held agent
can leave independently.

Agents honor `onHold`, `voice.call.held` and `voice.call.resumed`. After switching,
replies include the triggering transcript/current call's `mediaEpoch`, using
`voice-call-reply --media-epoch <number>`. Discard unfinished replies when held;
never relabel old speech with a new selection number. The bundled runtime does
this automatically. The existing browser helper worker needs its update loaded
once before multi-agent switching; older helpers are refused after a switch.
