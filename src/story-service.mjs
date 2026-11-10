import { createInitialState, runTurn, applyAuthoredMessage } from './engine.mjs';
import { makeId, clone, branchWorld, publicStory } from './store.mjs';
import { createProvider } from './provider.mjs';
import { Illustrator } from './illustrator.mjs';
import { compactKnowledge,narratorProjection } from './memory.mjs';
import { loggedProvider,formatDebugLog,appendDebugError } from './debug-log.mjs';

const failure=(message,status=400,code)=>Object.assign(new Error(message),{status,code});
const transcript=messages=>messages.map(({snapshot,...message})=>({...message,storyTime:message.storyTime??snapshot?.time}));
function text(value,name,limit=60000,empty=false) { if(typeof value!=='string'||(!empty&&!value.trim())||value.length>limit) throw failure(`Invalid ${name}.`);return value; }
export function validateSetup(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)) throw failure('Invalid story setup.');
  const setup={title:text(input.title,'title',160),premise:text(input.premise,'premise'),persona:{name:text(input.persona?.name,'persona name',120),description:text(input.persona?.description??'','persona description',20000,true)},characters:[]};
  if(input.characters!==undefined&&!Array.isArray(input.characters)) throw failure('Invalid cast.');
  if((input.characters??[]).length>30) throw failure('Begin with at most 30 predefined characters; others can arrive later.');
  for(const item of input.characters??[]) {
    const character={name:text(item.name,'character name',120)};
    for(const key of ['description','appearance','personality','goals','location']) character[key]=text(item[key]??'',key,20000,true);
    if(item.online) character.online={access:item.online.access===true,interests:Array.isArray(item.online.interests)?item.online.interests.filter(x=>typeof x==='string').slice(0,100):[],connections:Array.isArray(item.online.connections)?item.online.connections.filter(x=>typeof x==='string').slice(0,100):[]};
    setup.characters.push(character);
  }
  return setup;
}

export class StoryService {
  constructor(store,{makeProvider=createProvider}={}) {
    this.store=store;this.makeProvider=makeProvider;this.busy=new Map();this.illustrator=new Illustrator({store,makeProvider});
  }
  async view(id) { return publicStory(await this.store.get(id),this.busy.get(id)); }
  ensureFree(id) { if(this.busy.has(id)) throw failure('This story is already generating. Stop it or wait for the current turn.',409,'STORY_BUSY'); }
  assertVersion(story,version) {if(!Number.isInteger(version)||version!==story.version) throw failure('This story changed. Refresh it before trying again.',409,'STALE_STORY');}
  env(settings,lease,traceContext) {
    const provider=loggedProvider(this.makeProvider(settings),{store:this.store,settings,getContext:()=>({...traceContext,stage:lease.stage})});
    return {settings,traceContext,complete:request=>{
      const prepared=clone(request.messages);
      for(const message of prepared) {
        if(message.role!=='user'||typeof message.content!=='string')continue;
        let payload;try{payload=JSON.parse(message.content);}catch{continue;}
        for(const key of ['world','state','establishedWorld'])if(payload[key]?.characters&&payload[key]?.events)payload[key]=narratorProjection(payload[key]);
        message.content=JSON.stringify(payload);
      }
      return provider.complete({...request,messages:prepared});
    },signal:lease.controller.signal,onStage:stage=>{lease.stage=stage;}};
  }
  async create(input) {
    const setup=validateSetup(input),id=makeId(),branchId=makeId(),createdAt=new Date().toISOString();
    const initialState=createInitialState(setup);
    const story={id,title:setup.title,setup,createdAt,updatedAt:createdAt,version:0,activeBranchId:branchId,branches:{[branchId]:{id:branchId,name:'Original',parentId:null,forkMessageId:null,createdAt,initialState,messages:[],illustrations:[]}}};
    // Save the setup first: a failed connection does not lose the user's authored premise.
    await this.store.put(story);
    try {return await this.turn(id,0,null);} catch(error) {error.storyId=id;throw error;}
  }
  async operation(id,version,work,{illustrate=true,interruptImages=false}={}) {
    this.ensureFree(id);
    const lease={controller:new AbortController(),stage:'Preparing the story…'};
    let traceContext;
    this.busy.set(id,lease);
    try {
      if(interruptImages) await this.illustrator.cancel(id);
      const settings=await this.store.settings();
      await this.store.mutate(id,version,async story=>{
        this.assertVersion(story,version);
        traceContext={storyId:id,branchId:story.activeBranchId,turnId:makeId(),anchorMessageId:story.branches[story.activeBranchId].messages.at(-1)?.id};
        await work(story,this.env(settings,lease,traceContext));
        lease.controller.signal.throwIfAborted();
      });
    } catch(error) {
      if(traceContext)await appendDebugError(this.store,{...traceContext,stage:lease.stage,operation:'story',terminal:true},error).catch(()=>{});
      throw error;
    } finally {if(this.busy.get(id)===lease) this.busy.delete(id);}
    if(illustrate) await this.illustrator.schedule(id).catch(()=>{});
    return this.view(id);
  }
  async turn(id,version,input) {
    if(input!==null) text(input,'message');
    return this.operation(id,version,async (story,env)=>{
      const branch=story.branches[story.activeBranchId];
      const state=await compactKnowledge(branchWorld(branch),env);
      const result=await runTurn({...env,state,messages:transcript(branch.messages),input});
      branch.messages.push(...result.messages);
    });
  }
  async branch(id,input) {
    const mode=input.mode;
    if(!['rewind','edit','delete'].includes(mode)) throw failure('Invalid revision action.');
    if(mode==='edit') text(input.text,'edited message');
    return this.operation(id,input.expectedVersion,async (story,env)=>{
      const old=story.branches[story.activeBranchId];
      const index=input.messageId?old.messages.findIndex(m=>m.id===input.messageId):-1;
      if((input.messageId&&index<0)||(!input.messageId&&mode!=='rewind')) throw failure('Message not found.',404);
      const retainedCount=mode==='rewind'?index+1:index;
      const messages=clone(old.messages.slice(0,retainedCount));
      let state=clone(messages.at(-1)?.snapshot??old.initialState);
      const newId=makeId();
      env.traceContext.branchId=newId;
      env.traceContext.parentBranchId=old.id;
      env.traceContext.anchorMessageId=input.messageId;
      const branch={id:newId,name:`${mode==='edit'?'Revision':mode==='delete'?'Without passage':'Continuation'} ${Object.keys(story.branches).length}`,parentId:old.id,forkMessageId:input.messageId??null,createdAt:new Date().toISOString(),initialState:clone(old.initialState),messages,illustrations:clone(old.illustrations.filter(image=>messages.some(m=>m.id===image.anchorMessageId)))};
      if(mode==='edit') {
        const edited={...clone(old.messages[index]),id:makeId(),text:input.text,createdAt:new Date().toISOString()};delete edited.snapshot;
        const result=await applyAuthoredMessage({...env,state,messages:transcript(messages),message:edited});
        branch.messages.push(...result.messages);state=result.state;
      }
      if(input.regenerate===true||(mode!=='rewind'&&input.regenerate!==false)) {
        state=await compactKnowledge(state,env);
        const continuation=await runTurn({...env,state,messages:transcript(branch.messages),input:null});
        branch.messages.push(...continuation.messages);
      }
      story.branches[newId]=branch;story.activeBranchId=newId;
      story.illustrationJob={status:'cancelled'};
    },{illustrate:mode!=='rewind'||input.regenerate===true,interruptImages:true});
  }
  async switch(id,{branchId,expectedVersion}) {
    return this.operation(id,expectedVersion,async story=>{
      if(!Object.hasOwn(story.branches,branchId)) throw failure('Branch not found.',404);
      story.activeBranchId=branchId;story.illustrationJob={status:'cancelled'};
    },{illustrate:false,interruptImages:true});
  }
  async cancel(id) {
    const lease=this.busy.get(id);
    if(lease) lease.controller.abort(new DOMException('Generation stopped. No incomplete turn was saved.','AbortError'));
    return {cancelled:Boolean(lease)};
  }
  async remove(id) {this.ensureFree(id);await this.illustrator.cancel(id);await this.store.remove(id);return {ok:true};}
  async illustrate(id,{messageId,expectedVersion}) {
    this.ensureFree(id);this.assertVersion(await this.store.get(id),expectedVersion);
    await this.illustrator.schedule(id,{manual:true,messageId});return this.view(id);
  }
  async export(id) {
    const story=await this.store.get(id),images={};
    for(const branch of Object.values(story.branches)) for(const image of branch.illustrations) if(!images[image.url]) images[image.url]=(await this.store.image(image.url)).toString('base64');
    return {format:'hearth-story',formatVersion:1,exportedAt:new Date().toISOString(),story,images};
  }
  async debug(id) { const story=await this.store.get(id);return formatDebugLog(await this.store.debugRecords(id),{storyId:id,title:story.title}); }
  async import(data) {
    if(data?.format!=='hearth-story'||data.formatVersion!==1||!data.story||!data.images||typeof data.images!=='object') throw failure('Choose a Hearth story export.');
    const story=clone(data.story);story.setup=validateSetup(story.setup);
    if(!story.branches||typeof story.branches!=='object'||Array.isArray(story.branches)||!Object.hasOwn(story.branches,story.activeBranchId)||Object.keys(story.branches).length>200) throw failure('Invalid story branches.');
    const urls=new Map();
    const validateWorld=world=>{
      if(!world||!Array.isArray(world.characters)||!world.characters.some(c=>c.id==='player')||!Array.isArray(world.events)||!Array.isArray(world.publications)||!Array.isArray(world.locations)||typeof world.location!=='string'||!Number.isFinite(world.time)||!world.exposureDecisions||!Array.isArray(world.pending)) throw failure('An imported story checkpoint is invalid.');
      const ids=new Set();
      for(const c of world.characters) {
        if(typeof c.id!=='string'||ids.has(c.id)||typeof c.name!=='string'||typeof c.location!=='string'||!Array.isArray(c.knowledge)||!c.online||typeof c.online.access!=='boolean') throw failure('An imported character is invalid.');
        ids.add(c.id);
      }
    };
    let count=0;
    for(const [key,branch] of Object.entries(story.branches)) {
      if(!/^[a-zA-Z0-9_-]{1,100}$/.test(key)||branch.id!==key||!Array.isArray(branch.messages)||!Array.isArray(branch.illustrations)||typeof branch.name!=='string') throw failure('Invalid imported branch.');
      validateWorld(branch.initialState);
      const messages=new Set();
      for(const m of branch.messages) {
        if(++count>10000||typeof m.id!=='string'||messages.has(m.id)||!['player','character','narrator'].includes(m.role)||typeof m.speaker!=='string') throw failure('Invalid imported message.');
        text(m.text,'imported message');validateWorld(m.snapshot);messages.add(m.id);
      }
      for(const image of branch.illustrations) {
        if(typeof image.id!=='string'||typeof image.url!=='string'||!messages.has(image.anchorMessageId)||typeof image.prompt!=='string') throw failure('Invalid imported illustration.');
        if(!urls.has(image.url)) {
          const encoded=data.images[image.url];
          if(typeof encoded!=='string'||encoded.length>32*1024*1024||!/^[A-Za-z0-9+/\s]*={0,2}$/.test(encoded)) throw failure('Missing or invalid exported image.');
          const bytes=Buffer.from(encoded,'base64');
          const ext=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':bytes[0]===255&&bytes[1]===216?'jpg':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'webp':null;
          if(!ext) throw failure('Unsupported exported image format.');
          urls.set(image.url,await this.store.saveImage(bytes,ext));
        }
        image.url=urls.get(image.url);
      }
    }
    story.id=makeId();story.title=text(story.title,'story title',160);story.version=0;story.createdAt=new Date().toISOString();story.updatedAt=story.createdAt;delete story.illustrationJob;
    await this.store.put(story);return this.view(story.id);
  }
}
