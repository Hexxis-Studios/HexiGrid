import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  activateLocalRelease,
  LocalReleaseError,
  registerLocalRelease,
  resolveLocalRelease,
  rollbackLocalRelease
} from '../lib/local-releases.mjs';

export function parseLocalReleaseArguments(args) {
  const [command, ...rest] = args;
  if (!['register', 'activate', 'rollback', 'resolve'].includes(command)) throw new LocalReleaseError('Expected register, activate, rollback, or resolve.');
  const values = {};
  const valueFlags = new Set(['--root', '--id', '--source']);
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--confirm') {
      if (values.confirm) throw new LocalReleaseError('Duplicate --confirm flag.');
      values.confirm = true;
      continue;
    }
    if (!valueFlags.has(flag) || values[flag.slice(2)] !== undefined || !rest[index + 1] || rest[index + 1].startsWith('--')) {
      throw new LocalReleaseError('Invalid local release arguments.');
    }
    values[flag.slice(2)] = rest[index + 1];
    index += 1;
  }
  if (!values.root) throw new LocalReleaseError('An explicit --root is required.');
  const allowedByCommand = {
    register: ['root', 'id', 'source'],
    activate: ['root', 'id', 'confirm'],
    rollback: ['root', 'confirm'],
    resolve: ['root']
  }[command];
  if (Object.keys(values).some((key) => !allowedByCommand.includes(key))) throw new LocalReleaseError('Invalid local release arguments.');
  if ((command === 'register' && (!values.id || !values.source)) || (command === 'activate' && !values.id)) {
    throw new LocalReleaseError('Required local release arguments are missing.');
  }
  if (['activate', 'rollback'].includes(command) && !values.confirm) throw new LocalReleaseError('Activation and rollback require explicit --confirm.');
  return { command, ...values };
}

async function main(args) {
  const options = parseLocalReleaseArguments(args);
  if (options.command === 'register') {
    const release = await registerLocalRelease(options);
    return { action: 'registered', ...release };
  }
  if (options.command === 'activate') {
    const release = await activateLocalRelease(options);
    return { action: 'activated', ...release };
  }
  if (options.command === 'rollback') {
    const release = await rollbackLocalRelease(options);
    return { action: 'rolled-back', ...release };
  }
  return resolveLocalRelease(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    const message = error instanceof LocalReleaseError ? error.message : 'Local release operation failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
