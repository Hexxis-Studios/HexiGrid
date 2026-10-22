# Public KTX2 acceptance textures

Tiny Three.js sample textures, downloaded 1 October 2026 from the official repository:

- https://github.com/mrdoob/three.js/blob/dev/examples/textures/ktx2/2d_etc1s.ktx2
  SHA256 e56ddcc757fc73ff06bb0dac2a3533ce79c1e196ad895a3ff7dcc4d9de6b9d5d
- https://github.com/mrdoob/three.js/blob/dev/examples/textures/ktx2/2d_uastc.ktx2
  SHA256 21b6912cae1f074ae3eda1b751f43c36eafc7eb83f3af71f85bba2ccbafce125

See LICENSE for the Three.js MIT license. These are public test fixtures, not user files.
Run `node scripts/accept-avatar-decoders.mjs 44678 etc1s` or use `uastc`.
The script embeds the texture in a required Basis/Draco self-contained GLB and
serves it locally with the current viewer and production security headers.
