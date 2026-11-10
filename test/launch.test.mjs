import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp,writeFile,readFile,rm,mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectPort,ensureProxy,runningInstance,launch,freePort,ensureDependencies } from '../scripts/launch.mjs';
import { directoryIdentity } from '../src/store.mjs';
import { DEFAULT_SETTINGS } from '../src/settings.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('launcher installs pinned tokenizer dependencies only when missing or changed, without install scripts',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'hearth-dependencies-'));
  try{
    const packages={'node_modules/js-tiktoken':{version:'1.0.21'},'node_modules/base64-js':{version:'1.5.1'}};
    await writeFile(path.join(directory,'package-lock.json'),JSON.stringify({packages}));
    let calls=0;
    const runImpl=async(_command,args,{cwd})=>{
      calls++;assert.equal(cwd,directory);assert.deepEqual(args,['ci','--ignore-scripts','--no-audit','--no-fund']);
      for(const [name,entry] of Object.entries(packages)){await mkdir(path.join(directory,name),{recursive:true});await writeFile(path.join(directory,name,'package.json'),JSON.stringify(entry));}
    };
    await ensureDependencies({root:directory,runImpl});assert.equal(calls,1);
    await ensureDependencies({root:directory,runImpl});assert.equal(calls,1);
    await writeFile(path.join(directory,'node_modules/js-tiktoken/package.json'),'{"version":"old"}');
    await ensureDependencies({root:directory,runImpl});assert.equal(calls,2);
  }finally{if(path.dirname(directory)!==os.tmpdir())throw new Error('Unexpected test directory');await rm(directory,{recursive:true,force:true});}
});
test('launcher chooses a free adjacent port, reuses Hearth, and respects explicit port conflicts',async()=>{
  const busy=async()=>({reachable:true,status:200,body:{other:true}}),available=async port=>port===8002;
  assert.deepEqual(await selectPort({probeImpl:busy,freePortImpl:available}),{port:8002,existing:false});
  await assert.rejects(()=>selectPort({requested:8001,probeImpl:busy,freePortImpl:available}),/No free Hearth port/);
  const hearth=async()=>({status:200,body:{stories:[],settings:{chatModel:'sol'},version:'1',instance:{pid:123,dataDirectoryId:'my-library'}}});
  assert.deepEqual(await selectPort({dataDirectoryId:'my-library',probeImpl:hearth,freePortImpl:async()=>false}),{port:8001,existing:true});
  assert.deepEqual(await selectPort({dataDirectoryId:'other-library',probeImpl:hearth,freePortImpl:available}),{port:8002,existing:false});
  await assert.rejects(()=>selectPort({requested:'bad'}),/PORT must/);
});
test('launcher reuses a running proxy and never starts another on auth errors or timeouts',async()=>{
  let starts=0;const runImpl=async()=>{starts++;};
  await ensureProxy(DEFAULT_SETTINGS,{probeImpl:async()=>({reachable:true,status:200}),runImpl,log(){}});
  assert.equal(starts,0);
  await assert.rejects(()=>ensureProxy(DEFAULT_SETTINGS,{probeImpl:async()=>({reachable:true,status:403}),runImpl,log(){}}),/HTTP 403/);
  await assert.rejects(()=>ensureProxy(DEFAULT_SETTINGS,{probeImpl:async()=>({reachable:true,status:0}),runImpl,log(){}}),/too slowly/);
  assert.equal(starts,0);
});
test('launcher starts a missing loopback proxy with the existing OAuth tool and no API key',async()=>{
  let probes=0,command;
  await ensureProxy(DEFAULT_SETTINGS,{probeImpl:async()=>++probes===1?{reachable:false}:{reachable:true,status:200},runImpl:async(...args)=>{command=args;},log(){}});
  assert.match(command[0],/^npx/);assert.ok(command[1].includes('openai-oauth'));assert.ok(command[1].includes('--detach'));assert.ok(command[1].includes('10531'));assert.ok(!command[1].some(value=>/api.key/i.test(value)));
});
function start(args,env) {
  const child=spawn(process.execPath,['scripts/launch.mjs',...args],{cwd:root,env:{...process.env,...env},windowsHide:true});
  const output={stdout:'',stderr:''};child.stdout.on('data',chunk=>{output.stdout+=chunk;});child.stderr.on('data',chunk=>{output.stderr+=chunk;});
  const exited=new Promise((resolve,reject)=>{child.once('exit',code=>resolve(code));child.once('error',reject);});
  return {child,output,exited};
}
test('one-command launcher starts the real app, reopens its instance, and blocks updates while running',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'hearth-launch-'));
  const proxy=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'gpt-6.1-sol'}]}));});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  await writeFile(path.join(directory,'settings.json'),JSON.stringify({...DEFAULT_SETTINGS,autoIllustrate:false,proxyBaseUrl:`http://127.0.0.1:${proxy.address().port}/v1`}));
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const env={HEARTH_DATA_DIR:directory,PORT:String(port),HEARTH_NO_BROWSER:'1',HEARTH_WAKE_LOCK:'0'};
  const main=start([],env);
  t.after(async()=>{main.child.kill();await main.exited;await new Promise(resolve=>proxy.close(resolve));if(path.dirname(directory)!==os.tmpdir())throw new Error('Unexpected test directory');await rm(directory,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Launcher failed to start: '+main.output.stderr)),10000);const inspect=()=>{if(main.output.stdout.includes('Hearth is ready')){clearTimeout(timeout);resolve();}};main.child.stdout.on('data',inspect);inspect();main.exited.then(code=>{clearTimeout(timeout);reject(new Error('Launcher exited early: '+code+' '+main.output.stderr));});});
  const response=await fetch(`http://127.0.0.1:${port}/api/bootstrap`);assert.equal(response.status,200);assert.deepEqual((await response.json()).stories,[]);
  // A remembered instance is reused even when a caller supplies another port.
  const again=start([],{...env,PORT:String(port===65535?65534:port+1)});assert.equal(await again.exited,0);assert.match(again.output.stdout,/already running/);assert.match(again.output.stdout,new RegExp(':'+port));
  const update=start(['update'],env);assert.equal(await update.exited,1);assert.match(update.output.stderr,/Stop it with Ctrl\+C/);
  const registry=await readFile(path.join(directory,'.launcher.json'),'utf8');
  await writeFile(path.join(directory,'.launcher.json'),JSON.stringify({pid:main.child.pid+1000000,port}));
  assert.equal(await runningInstance(directory,await directoryIdentity(directory)),null);
  await writeFile(path.join(directory,'.launcher.json'),registry);
  const other=path.join(directory,'other-library');await mkdir(other);
  await writeFile(path.join(other,'settings.json'),await readFile(path.join(directory,'settings.json')));
  await writeFile(path.join(other,'.launcher.json'),registry);
  const separate=start([],{...env,HEARTH_DATA_DIR:other});assert.equal(await separate.exited,1);assert.match(separate.output.stderr,/No free Hearth port/);assert.ok(!separate.output.stdout.includes('already running'));
});

test('app port selection happens after a stopped proxy occupies the preferred default port',async t=>{
  if(!await freePort(8001)){t.skip('Default test port is already occupied.');return;}
  const directory=await mkdtemp(path.join(os.tmpdir(),'hearth-proxy-port-'));
  const proxy=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[]}));});
  let app;
  try {
    await writeFile(path.join(directory,'settings.json'),JSON.stringify({...DEFAULT_SETTINGS,proxyBaseUrl:'http://127.0.0.1:8001/v1'}));
    app=await launch({args:[],env:{HEARTH_DATA_DIR:directory,HEARTH_NO_BROWSER:'1',HEARTH_WAKE_LOCK:'0'},log(){},ensureProxyImpl:async()=>{await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(8001,'127.0.0.1',resolve);});}});
    assert.ok(app.server.address().port>8001);
    assert.equal((await fetch(`http://127.0.0.1:${app.server.address().port}/api/bootstrap`)).status,200);
  }finally{
    if(app)await app.close();
    if(proxy.listening)await new Promise(resolve=>proxy.close(resolve));
    if(path.dirname(directory)!==os.tmpdir())throw new Error('Unexpected test directory');await rm(directory,{recursive:true,force:true});
  }
});
