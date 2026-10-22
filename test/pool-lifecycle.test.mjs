import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
test('Windows watchdog log guard handles missing, small and oversized logs without running lifecycle code',{skip:process.platform!=='win32'},async()=>{
 const source=await readFile(new URL('../scripts/HexiGrid-Watchdog.ps1',import.meta.url),'utf8');
 const expression=source.match(/function Write-WatchdogLog[^]*?\n\s*if \(([^\n]+)\) \{/)[1];
 const temp=await mkdtemp(path.join(os.tmpdir(),'hexigrid-log-guard-'));
 try{
  const fixture=path.join(temp,'guard.ps1'),log=path.join(temp,'synthetic.log');
  await writeFile(fixture,`$ErrorActionPreference = 'Stop'\n$logFile = $env:HEXIGRID_TEST_LOG\nif (${expression}) { 'rotate' } else { 'keep' }`,'utf8');
  const check=()=>execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',fixture],{env:{...process.env,HEXIGRID_TEST_LOG:log},windowsHide:true,encoding:'utf8'}).trim();
  assert.equal(check(),'keep');await writeFile(log,'synthetic');assert.equal(check(),'keep');await writeFile(log,Buffer.alloc(1048577));assert.equal(check(),'rotate');
 }finally{if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('hexigrid-log-guard-'))throw Error('Unexpected fixture path');await rm(temp,{recursive:true,force:true});}
});
