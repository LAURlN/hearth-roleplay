import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {DEFAULT_SETTINGS} from '../src/settings.mjs';

async function controller(api){
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const start=source.indexOf('  function modelEfforts('),end=source.indexOf("  $('open-story-menu')",start);
  const fields=new Map(),handlers=new Map();
  const selects=new Set(['chatModel','helperModel','imageModel','chatEffort','characterEffort','helperEffort','illustratorEffort','imageQuality','imageSize'].map(key=>`setting-${key}`));
  const field=id=>{
    if(!fields.has(id)){
      let selected='';
      const f={tagName:selects.has(id)?'SELECT':'INPUT',type:id==='setting-autoIllustrate'?'checkbox':'text',options:[],dataset:{},textContent:'',disabled:false,addEventListener:(event,fn)=>handlers.set(`${id}:${event}`,fn),replaceChildren(){this.options=[];selected='';},append(option){this.options.push(option);if(this.options.length===1)selected=option.value;}};
      Object.defineProperty(f,'value',{get:()=>selected,set:value=>{selected=f.tagName==='SELECT'&&!f.options.some(option=>option.value===String(value))?'':String(value);}});
      fields.set(id,f);
    }
    return fields.get(id);
  };
  const state={settings:{...DEFAULT_SETTINGS,chatModel:'saved-model',helperModel:'helper-a',chatEffort:'high'},models:[],modelRequest:0,settingsLoading:false};
  const settingsFields=vm.runInNewContext(source.match(/const settingsFields = ([\s\S]*?);/)[1]);
  const context={state,$:field,node:(_tag,_class,text='')=>({textContent:text,value:''}),settingsFields,numericSettings:new Set(['imageCooldown','maxResponders','contextMessages']),api,setDrawer(){},inlineError(){},openDialog(){},toast(){}};
  vm.runInNewContext(source.slice(start,end),context);
  return {state,field,handlers,context};
}

test('settings opens with proxy model dropdowns and preserves saved or unsaved choices on refresh',async()=>{
  let calls=0;
  const models=[{id:'chat-a',name:'Chat A',supported_reasoning_levels:[{effort:'low'},{effort:'high'}]},{id:'helper-a',name:'Helper A'},{id:'image-a',name:'Image A'}];
  const c=await controller(async()=>{calls++;return {connected:true,models};});
  c.handlers.get('open-settings:click')();await new Promise(setImmediate);
  assert.equal(calls,1);assert.equal(c.field('setting-chatModel').value,'saved-model');
  assert.ok(c.field('setting-chatModel').options.some(option=>option.value==='chat-a'&&option.textContent.includes('Chat A')));
  assert.ok(c.field('setting-chatModel').options.some(option=>option.value==='saved-model'&&option.textContent.includes('unavailable')));
  c.field('setting-chatModel').value='chat-a';c.field('setting-helperModel').value='';
  c.handlers.get('setting-chatModel:change')();
  assert.deepEqual(c.field('setting-chatEffort').options.map(option=>option.value),['','low','high']);
  assert.equal(c.field('setting-chatEffort').value,'high');
  await c.context.checkModels();
  assert.equal(c.field('setting-chatModel').value,'chat-a');assert.equal(c.field('setting-helperModel').value,'');
  assert.equal(c.field('setting-chatEffort').value,'high');
});

test('failed model refresh retains the selected models and efforts',async()=>{
  let fails=false;
  const c=await controller(async()=>{if(fails)throw new Error('Proxy offline');return {connected:true,models:[{id:'chat-a',name:'Chat A'}]};});
  c.context.populateSettings();await c.context.checkModels();
  c.field('setting-chatModel').value='chat-a';c.field('setting-helperModel').value='';
  c.field('setting-chatEffort').value='none';fails=true;await c.context.checkModels();
  assert.equal(c.field('setting-chatModel').value,'chat-a');assert.equal(c.field('setting-helperModel').value,'');
  assert.equal(c.field('setting-chatEffort').value,'none');assert.match(c.field('model-result').textContent,/offline/);
  assert.equal(c.field('check-models').disabled,false);
});

test('a late model response cannot replace a newer connection catalog',async()=>{
  let resolveOld,calls=0;
  const c=await controller(()=>++calls===1?new Promise(resolve=>{resolveOld=resolve;}):Promise.resolve({connected:true,models:[{id:'new-model'}]}));
  c.context.populateSettings();const old=c.context.checkModels();
  c.state.settings.proxyBaseUrl='http://127.0.0.1:9999/v1';await c.context.checkModels();
  resolveOld({connected:true,models:[{id:'old-model'}]});await old;
  assert.ok(c.field('setting-chatModel').options.some(option=>option.value==='new-model'));
  assert.ok(!c.field('setting-chatModel').options.some(option=>option.value==='old-model'));
});
