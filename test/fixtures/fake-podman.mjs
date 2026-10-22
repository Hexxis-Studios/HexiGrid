const args = process.argv.slice(2);
if (args[0] === 'info') {
  process.stdout.write(JSON.stringify({ host: { security: { rootless: true } } }));
  process.exit(0);
}
if (args[0] === 'image' && args[1] === 'inspect') {
  process.stdout.write(JSON.stringify([{ RepoDigests: [args[2]] }]));
  process.exit(0);
}
if (args.includes('run')) {
  const required = ['--rm', '--interactive', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65532:65532'];
  if (required.some((option) => !args.includes(option))) { process.stderr.write('Unsafe container launch.'); process.exit(2); }
  await import('./mcp-server.mjs');
}
else { process.stderr.write('Unsupported fake Podman operation.'); process.exit(2); }
