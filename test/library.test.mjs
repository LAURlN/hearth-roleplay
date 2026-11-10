import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createApp} from '../server.mjs';
import {createInitialState} from '../src/engine.mjs';
import {Store} from '../src/store.mjs';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('appearance correction submits flexible details and sight, keeping the editor draft after a failed save',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const start=source.indexOf('  function openAppearanceEditor('),end=source.indexOf('  const tabs = ',start);
  const handlers=new Map(),fields=new Map();
  const field=id=>{
    if(!fields.has(id))fields.set(id,{checked:false,children:[],addEventListener:(event,fn)=>handlers.set(`${id}:${event}`,fn),querySelectorAll:()=>[]});
    return fields.get(id);
  };
  const draft=[{key:'hair',layer:'physical',text:'black hair',visible:'hair hidden by a hood'}];
  field('appearance-rows').children=draft.map(fact=>({querySelectorAll:()=>Object.entries(fact).map(([key,value])=>({dataset:{visualField:key},value}))}));
  let succeeds=false,submitted,closed=0;
  const state={story:{id:'story',activeBranchId:'original'},visualEditor:{storyId:'story',branchId:'original',characterId:'player'}};
  const context={state,$:field,locked:()=>false,inlineError(){},toast(){},closeDialog(){closed++;},mutateStory:async(path,body)=>{assert.equal(path,'/appearance');submitted=body;return succeeds;}};
  vm.runInNewContext(source.slice(start,end),context);
  await handlers.get('appearance-form:submit')({preventDefault(){}});
  assert.deepEqual(JSON.parse(JSON.stringify(submitted)),{characterId:'player',facts:draft,canSee:false});
  assert.equal(closed,0);assert.equal(state.appearanceSaving,false);assert.equal(field('appearance-rows').children.length,1);
  succeeds=true;await handlers.get('appearance-form:submit')({preventDefault(){}});assert.equal(closed,2);
});

async function fixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),'hearth-library-'));
  const app=await createApp({dataDir:directory,makeProvider:()=>{throw new Error('Library management must not create a model provider.');}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const request=async(url,method='GET',body)=>{
    const response=await fetch(base+url,{method,headers:body?{'content-type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  };
  for(const id of ['first','second']){
    const setup={title:id,premise:'A quiet room.',persona:{name:'Player',description:''},characters:[]};
    const initialState=createInitialState(setup);
    await app.store.put({id,title:id,setup,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',version:0,activeBranchId:'original',branches:{original:{id:'original',name:'Original',parentId:null,forkMessageId:null,createdAt:'2026-01-01T00:00:00.000Z',initialState,messages:[],illustrations:[]}}});
  }
  return {...app,directory,request};
}

test('rename, archive and restore persist independently of story branches and make no AI calls',async t=>{
  const f=await fixture(t),before=await f.store.get('first');
  const renamed=await f.request('/api/stories/first/metadata','POST',{title:'  A new title  ',expectedVersion:0});
  assert.equal(renamed.status,200);assert.equal(renamed.body.title,'A new title');assert.equal(renamed.body.version,1);
  const archived=await f.request('/api/stories/first/metadata','POST',{archived:true,expectedVersion:1});
  assert.equal(archived.status,200);assert.equal(archived.body.archived,true);
  const list=(await f.request('/api/stories')).body;
  assert.equal(list.find(s=>s.id==='first').archived,true);assert.equal(list.find(s=>s.id==='first').version,2);
  assert.equal(list.find(s=>s.id==='second').archived,false);
  assert.deepEqual((await f.store.get('first')).branches,before.branches);
  const restarted=new Store(f.directory);await restarted.init();assert.equal((await restarted.get('first')).archived,true);
  const restored=await f.request('/api/stories/first/metadata','POST',{archived:false,expectedVersion:2});
  assert.equal(restored.status,200);assert.equal(restored.body.archived,false);assert.equal(restored.body.title,'A new title');
});

test('library metadata validates titles/archive types and rejects busy or stale changes',async t=>{
  const f=await fixture(t);
  for(const body of [{title:'   ',expectedVersion:0},{title:'x'.repeat(161),expectedVersion:0},{archived:'yes',expectedVersion:0},{expectedVersion:0}])assert.equal((await f.request('/api/stories/first/metadata','POST',body)).status,400);
  assert.equal((await f.request('/api/stories/first/metadata','POST',{title:'New',expectedVersion:4})).status,409);
  f.service.busy.set('first',{controller:new AbortController(),stage:'Busy'});
  assert.equal((await f.request('/api/stories/first/metadata','POST',{archived:true,expectedVersion:0})).status,409);
  f.service.busy.delete('first');
  assert.equal((await f.request('/api/stories/missing/metadata','POST',{title:'Missing',expectedVersion:0})).status,404);
  assert.equal((await f.store.get('first')).version,0);
});

test('deleting a chosen archived library story leaves other stories intact and removes its debug log',async t=>{
  const f=await fixture(t),second=await f.store.get('second');
  await f.request('/api/stories/first/metadata','POST',{archived:true,expectedVersion:0});
  await f.store.appendDebug('first',{kind:'request',request:{messages:[]}});
  assert.equal((await f.request('/api/stories/first','DELETE')).status,200);
  assert.equal((await f.request('/api/stories/first')).status,404);
  assert.deepEqual(await f.store.get('second'),second);
  assert.deepEqual(await f.store.debugRecords('first'),[]);
  assert.deepEqual((await f.request('/api/stories')).body.map(s=>s.id),['second']);
});

test('the library delete controller targets its selected entry while preserving another open conversation',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const start=source.indexOf('  function confirmDeleteStory('),end=source.indexOf("  $('confirm-form').addEventListener",start);
  assert.ok(start>=0&&end>start);
  const target={id:'archived-entry',title:'Old story',archived:true},active={id:'open-story',title:'Keep reading',busy:false};
  const fields=new Map(),requests=[],removed=[];let pollingStops=0;
  const field=id=>{if(!fields.has(id))fields.set(id,{addEventListener(){}});return fields.get(id);};
  const state={story:active,stories:[target,active],operation:null,selecting:false};
  const context={state,$:field,storyPath:id=>`/api/stories/${id}`,api:async(...args)=>{requests.push(args);},inlineError(){},updateControls(){},renderLibrary(){},clearError(){},closeDialog(){},openDialog(){},toast(){},schedulePolling(){},stopPolling(){pollingStops++;},storage:{remove:key=>removed.push(key)}};
  vm.runInNewContext(source.slice(start,end),context);
  context.confirmDeleteStory(target);await state.confirmAction();
  assert.equal(requests[0][0],'/api/stories/archived-entry');assert.equal(requests[0][1].method,'DELETE');
  assert.equal(state.story,active);assert.deepEqual(state.stories,[active]);assert.equal(pollingStops,0);
  assert.deepEqual(removed,['draft:archived-entry']);
});
