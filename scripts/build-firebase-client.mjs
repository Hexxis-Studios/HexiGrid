import { build } from 'esbuild';

await build({
  entryPoints: ['client/firebase-google.js'],
  outfile: 'public/vendor/firebase-google.js',
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  legalComments: 'linked',
});
