import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { readFile,writeFile } from 'node:fs/promises';
import { createApp } from '../server.mjs';
import { Store, directoryIdentity } from '../src/store.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

export async function probe(url,{fetchImpl=fetch}={}) {
  try {
    const response=await fetchImpl(url,{signal:AbortSignal.timeout(2500),redirect:'error'});
    const body=await response.json().catch(()=>null);
    return {reachable:true,status:response.status,body};
  } catch(error) {return error.name==='TimeoutError'?{reachable:true,status:0}:{reachable:false};}
}

export async function freePort(port) {
  const server=net.createServer();
  return new Promise(resolve=>{
    server.once('error',()=>resolve(false));
    server.listen(port,'127.0.0.1',()=>server.close(()=>resolve(true)));
  });
}

export async function selectPort({requested,defaultPort=8001,dataDirectoryId,probeImpl=probe,freePortImpl=freePort}={}) {
  const first=Number(requested??defaultPort);
  if(!Number.isInteger(first)||first<1||first>65535)throw new Error('PORT must be an integer between 1 and 65535.');
  for(let port=first;port<=Math.min(65535,first+(requested===undefined?9:0));port++) {
    const result=await probeImpl(`http://127.0.0.1:${port}/api/bootstrap`);
    if(result.status===200&&dataDirectoryId&&result.body?.instance?.dataDirectoryId===dataDirectoryId&&Number.isInteger(result.body.instance.pid)&&Array.isArray(result.body.stories)&&result.body.settings?.chatModel&&result.body.version)return {port,existing:true};
    if(await freePortImpl(port))return {port,existing:false};
  }
  throw new Error(`No free Hearth port was found. Try PORT=${Math.min(first+10,65535)} hearth.`);
}

export function run(command,args,{cwd=ROOT,shell=false}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,stdio:'inherit',shell,windowsHide:true});
    child.once('error',reject);
    child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`${command} stopped (${signal??code}).`)));
  });
}

export async function ensureProxy(settings,{probeImpl=probe,runImpl=run,log=console.log}={}) {
  const url=new URL(settings.proxyBaseUrl);
  const existing=await probeImpl(`${settings.proxyBaseUrl}/models`);
  if(existing.reachable) {
    if(existing.status===0)throw new Error('The configured proxy is responding too slowly. Check it and retry; Hearth has not started another proxy.');
    if(existing.status!==200)throw new Error(`Your proxy is running but returned HTTP ${existing.status}. Reconnect its ChatGPT login if needed; Hearth has not started another proxy.`);
    log('Using your running subscription proxy.');return;
  }
  if(!['127.0.0.1','localhost'].includes(url.hostname)||url.protocol!=='http:'||url.pathname!=='/v1')throw new Error('Start your configured proxy first, then run hearth again. Automatic startup supports a local http://127.0.0.1:PORT/v1 proxy.');
  log('Starting openai-oauth using your existing ChatGPT login. Complete browser sign-in if requested.');
  try {
    await runImpl(process.platform==='win32'?'npx.cmd':'npx',['--yes','openai-oauth','--detach','--host','127.0.0.1','--port',String(url.port||80)],{shell:process.platform==='win32'});
  } catch(error) {throw new Error(`Could not start the subscription proxy: ${error.message} Run npx openai-oauth login, then hearth again.`);}
  for(let attempt=0;attempt<10;attempt++) {
    const ready=await probeImpl(`${settings.proxyBaseUrl}/models`);
    if(ready.status===200)return;
    if(ready.reachable&&ready.status!==0)break;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error('The subscription proxy is not ready. Run npx openai-oauth login, then npx openai-oauth --detach, and run hearth again.');
}

export async function runningInstance(directory,dataDirectoryId) {
  try {
    const record=JSON.parse(await readFile(path.join(directory,'.launcher.json'),'utf8'));
    if(!Number.isInteger(record.port)||record.port<1||record.port>65535||!Number.isInteger(record.pid)||record.pid<1)return null;
    const result=await probe(`http://127.0.0.1:${record.port}/api/bootstrap`);
    if(result.status===200&&result.body?.instance?.pid===record.pid&&result.body.instance.dataDirectoryId===dataDirectoryId&&Array.isArray(result.body.stories)&&result.body.settings?.chatModel)return record;
  }catch{}
  return null;
}

function openBrowser(url,env=process.env) {
  if(env.HEARTH_NO_BROWSER==='1')return;
  const opener=spawn('termux-open-url',[url],{stdio:'ignore',windowsHide:true});
  opener.on('error',()=>{});
}

export async function launch({args=process.argv.slice(2),env=process.env,log=console.log,ensureProxyImpl=ensureProxy}={}) {
  if(Number(process.versions.node.split('.')[0])<22)throw new Error('Hearth requires Node 22+. In Termux run: pkg install nodejs-lts');
  if(args[0]==='--help'||args[0]==='help') {
    log('hearth          Start Hearth, reuse/start the local subscription proxy, and open the browser.\nhearth update   Pull the latest main branch, preserve data/, and start.\nPORT=8002 hearth   Use another port.\nHEARTH_NO_BROWSER=1 hearth   Start without opening a browser.');return;
  }
  if(args.length>1||(args[0]&&args[0]!=='update'))throw new Error('Use hearth, hearth update, or hearth --help.');
  const directory=path.resolve(env.HEARTH_DATA_DIR||path.join(ROOT,'data'));
  const store=new Store(directory);await store.init();
  const dataDirectoryId=await directoryIdentity(directory);
  const running=await runningInstance(directory,dataDirectoryId);
  if(running) {
    if(args[0]==='update')throw new Error('Hearth is already running. Stop it with Ctrl+C in its Termux session, then run hearth update.');
    const address=`http://127.0.0.1:${running.port}`;log(`Hearth is already running at ${address}`);openBrowser(address,env);return;
  }
  if(args[0]==='update') {
    const existing=await selectPort({requested:env.PORT??env.HEARTH_PORT,dataDirectoryId});
    if(existing.existing)throw new Error('Hearth is already running. Stop it with Ctrl+C in its Termux session, then run hearth update.');
    await run('git',['pull','--ff-only']);
    // Start a fresh interpreter so the updated server code is loaded too.
    await run(process.execPath,[fileURLToPath(import.meta.url)]);return;
  }
  const settings=await store.settings();
  await ensureProxyImpl(settings);
  // A newly started proxy can occupy the preferred app port. Choose only once
  // the proxy is ready so it is treated as an occupied, unrelated listener.
  const choice=await selectPort({requested:env.PORT??env.HEARTH_PORT,dataDirectoryId});
  const address=`http://127.0.0.1:${choice.port}`;
  if(choice.existing){log(`Hearth is already running at ${address}`);openBrowser(address,env);return;}
  if(env.HEARTH_WAKE_LOCK!=='0') {
    const wake=spawn('termux-wake-lock',[],{stdio:'ignore',windowsHide:true});wake.on('error',()=>{});
  }
  const app=await createApp({dataDir:directory});
  try {await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(choice.port,'127.0.0.1',resolve);});}
  catch(error){await app.close();throw error;}
  await writeFile(path.join(directory,'.launcher.json'),JSON.stringify({pid:process.pid,port:choice.port}),{mode:0o600});
  log(`\nHearth is ready at ${address}\nKeep this Termux session running. Ctrl+C stops Hearth; your shared proxy stays available.\nNext time: hearth\nUpdate: hearth update\n`);
  openBrowser(address,env);
  const stop=()=>{void app.close().then(()=>process.exit(0));};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  app.server.once('close',()=>{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);});
  return app;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  launch().catch(error=>{console.error(`Hearth: ${error.message}`);process.exitCode=1;});
}
