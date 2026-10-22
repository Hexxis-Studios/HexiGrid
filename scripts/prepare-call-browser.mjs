#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const dataDir = process.env.HEXIGRID_DATA_DIR ? path.resolve(process.env.HEXIGRID_DATA_DIR) : path.join(root,'data');
const output = path.join(dataDir,'call-browser');
const manifest = JSON.parse(await fs.readFile(path.join(root,'integrations/call-browser/extension/manifest.json'),'utf8'));
const id = [...crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest().subarray(0,16)]
  .flatMap(b=>[b>>4,b&15]).map(n=>String.fromCharCode(97+n)).join('');
const native = path.join(root,'integrations/call-browser/native');
await fs.mkdir(output,{recursive:true});
const hostFile = process.platform === 'win32' ? 'HexiGridCallChatHost.exe' : process.platform === 'linux' ? 'HexiGridCallChatHost' : null;
if (!hostFile) throw new Error('The call companion currently supports Windows and Linux.');
const packagedHost = path.join(root,'integrations/call-browser/native-host',hostFile);
const hasPackagedHost = await fs.stat(packagedHost).then(file => file.isFile()).catch(() => false);
if (hasPackagedHost) await fs.copyFile(packagedHost,path.join(output,hostFile));
else {
const built = spawnSync('dotnet',['publish',path.join(native,'CallChatHost.csproj'),'-c','Release',...(process.platform === 'linux' ? ['-r','linux-x64','--self-contained','true'] : []),'-o',output,
  `-p:BaseIntermediateOutputPath=${path.join(output,'obj')}${path.sep}`],{encoding:'utf8',windowsHide:true});
if (built.status !== 0) throw new Error('The local browser companion could not be built. Install the .NET 9 SDK and try again.');
}
if (process.platform === 'linux') await fs.chmod(path.join(output,hostFile),0o755);
const runtime = await fs.readFile(path.join(dataDir,'.runtime.json'),'utf8').then(JSON.parse).catch(() => null);
const port = Number(process.env.HEXIGRID_PORT || (runtime?.product === 'hexigrid' ? runtime.port : 4318));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('The local workspace port is invalid.');
await fs.writeFile(path.join(output,'host-config.json'),JSON.stringify({node:process.execPath,
  script:path.join(root,'scripts/call-browser-host.mjs'),origin:`chrome-extension://${id}/`,port,dataDir:path.dirname(output)},null,2));
const hostManifest = path.join(output,'native-host.json');
await fs.writeFile(hostManifest,JSON.stringify({name:'com.hexigrid.call_chat',description:'HexiGrid call chat companion',
  path:path.join(output,hostFile),type:'stdio',allowed_origins:[`chrome-extension://${id}/`]},null,2));
if (process.argv.includes('--register')) {
  if (process.platform === 'win32') {
    const registered = spawnSync('reg.exe',['add','HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.hexigrid.call_chat',
      '/ve','/t','REG_SZ','/d',hostManifest,'/f'],{encoding:'utf8',windowsHide:true});
    if (registered.status !== 0) throw new Error('The browser companion could not be registered for this Windows user.');
  } else {
    const home = process.env.HOME;
    if (!home) throw new Error('The browser companion could not find this user’s home folder.');
    const browsers = [
      { command:'google-chrome', config:path.join(home,'.config/google-chrome/NativeMessagingHosts') },
      { command:'chromium', config:path.join(home,'.config/chromium/NativeMessagingHosts') },
      { command:'chromium-browser', config:path.join(home,'.config/chromium/NativeMessagingHosts') }
    ];
    const available = browsers.filter(browser => spawnSync('which',[browser.command],{encoding:'utf8'}).status === 0);
    if (!available.length) throw new Error('Install Chrome or Chromium before registering the call companion.');
    for (const directory of new Set(available.map(browser => browser.config))) {
      await fs.mkdir(directory,{recursive:true});
      await fs.copyFile(hostManifest,path.join(directory,'com.hexigrid.call_chat.json'));
      await fs.chmod(path.join(directory,'com.hexigrid.call_chat.json'),0o600);
    }
  }
}
console.log(JSON.stringify({prepared:true,registered:process.argv.includes('--register'),extension:path.join(root,'integrations/call-browser/extension'),extensionId:id}));
