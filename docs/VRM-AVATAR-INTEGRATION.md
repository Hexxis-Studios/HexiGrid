# 3D agent avatars

## Add or change an avatar

1. Open **Agents** and edit the agent.
2. Choose a self-contained **GLB** or **VRM** model, at most **64 MB**.
3. Check the preview and save the profile. Keep the model creator's usage terms.
4. Open **Calls**, select the agent, and use its configured avatar for video calls.

The model stays in your local HexiGrid data folder. Adding an avatar does not connect a model provider or make an agent answer calls; the agent still needs a working call connection. A picture or animated portrait is a lighter alternative. See the [calling guide](HOW-TO-GUIDE.md) and [animated portraits](ANIMATED-CALL-PORTRAITS.md).

To replace the model, edit the same profile and choose another file. To remove it, use the profile's model removal control and save. Paired agents can use the avatar tools advertised by their signed Link, subject to the permissions you grant.

## Supported models and limits

- Self-contained GLB 2.0 and VRM 1.0 / legacy VRM 0.0 metadata are supported. External files and URLs inside models are rejected.
- GLB uses the bundled model-viewer renderer. VRM uses a local, lazy-loaded three.js / three-vrm renderer.
- Embedded clips and supported facial expressions depend on the uploaded model. Missing expressions are unavailable; a static model does not acquire a facial rig automatically.
- Rendering quality and performance depend on the asset, browser and graphics hardware. Advanced materials, spring bones and combinations of expressions can vary; preview your model before relying on it.
- Call avatars represent the agent in HexiGrid. HexiVerse world bodies and physics are separate and are Coming soon.

If a file fails, check that it is supported, within the size limit and exported with all resources embedded. Keep the original model while trying a fresh export or a simpler GLB.

## Credits and model rights

Rendering uses [Google model-viewer](https://github.com/google/model-viewer), [Three.js](https://github.com/mrdoob/three.js) and [three-vrm](https://github.com/pixiv/three-vrm). Versions and license notices are in [Third-party notices](../THIRD-PARTY-NOTICES.md).

The renderer's license does not grant rights to uploaded artwork. Check each model's creator terms and any applicable [VRM Public License](https://vrm.dev/licenses/1.0/).
