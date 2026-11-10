import { createInitialState, runTurn, applyAuthoredMessage,applyVisualCorrection,applyCharacterPrompt,buildContextRequest } from './engine.mjs';
import {validateVisualFacts} from './visuals.mjs';
import { makeId, clone, branchWorld, publicStory } from './store.mjs';
import { createProvider } from './provider.mjs';
import { Illustrator } from './illustrator.mjs';
import { compactKnowledge,narratorProjection,contextUsage } from './memory.mjs';
import { loggedProvider,formatDebugLog,appendDebugError } from './debug-log.mjs';
import {composeResponse,retainResponses,validateResponses} from './presentation.mjs';
import {createSimpleState,runSimpleTurn,applySimpleAuthoredMessage,buildSimpleContextRequest} from './simple-engine.mjs';

const failure=(message,status=400,code)=>Object.assign(new Error(message),{status,code});
const transcript=messages=>messages.filter(m=>!m.internal).map(({snapshot,...message})=>({...message,storyTime:message.storyTime??snapshot?.time,eventCount:snapshot?.events?.length??message.eventCount}));
function text(value,name,limit=60000,empty=false) { if(typeof value!=='string'||(!empty&&!value.trim())||value.length>limit) throw failure(`Invalid ${name}.`);return value; }
export function validateSetup(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)) throw failure('Invalid story setup.');
  const setup={title:text(input.title,'title',160),premise:text(input.premise,'premise'),persona:{name:text(input.persona?.name,'persona name',120),description:text(input.persona?.description??'','persona description',20000,true)},characters:[]};
  if(input.mode!==undefined&&!['simple','detailed'].includes(input.mode))throw failure('Invalid story mode.');
  setup.mode=input.mode??'detailed';
  if(input.characters!==undefined&&!Array.isArray(input.characters)) throw failure('Invalid cast.');
  if((input.characters??[]).length>30) throw failure('Begin with at most 30 predefined characters; others can arrive later.');
  for(const item of input.characters??[]) {
    const character={name:text(item.name,'character name',120)};
    for(const key of ['description','appearance','personality','goals','location']) character[key]=text(item[key]??'',key,20000,true);
    character.systemPrompt=text(item.systemPrompt??'','character system prompt',60000,true);
    if(item.online) character.online={access:item.online.access===true,interests:Array.isArray(item.online.interests)?item.online.interests.filter(x=>typeof x==='string').slice(0,100):[],connections:Array.isArray(item.online.connections)?item.online.connections.filter(x=>typeof x==='string').slice(0,100):[]};
    setup.characters.push(character);
  }
  return setup;
}

export class StoryService {
  constructor(store,{makeProvider=createProvider}={}) {
    this.store=store;this.makeProvider=makeProvider;this.busy=new Map();this.usageCache=new Map();this.illustrator=new Illustrator({store,makeProvider});
  }
  async view(id) {
    const settings=await this.store.settings();
    // Keep a lease observed during the history read: a turn may commit before
    // this view returns, but old history must never be reported as settled.
    const readingLease=this.busy.get(id);
    const story=await this.store.get(id),branch=story.branches[story.activeBranchId];
    const key=JSON.stringify([story.version,story.activeBranchId,settings]);
    let cached=this.usageCache.get(id);
    if(cached?.key!==key){
      let usage;
      try{usage={narrator:contextUsage(branchWorld(branch),transcript(branch.messages),settings,story.setup.mode==='simple'?buildSimpleContextRequest:buildContextRequest)};}
      catch(error){usage={narrator:{error:error.message,threshold:settings.contextTokenLimit??300000}};}
      cached={key,usage};this.usageCache.set(id,cached);
    }
    return {...publicStory(story,readingLease??this.busy.get(id)),contextUsage:cached.usage};
  }
  async metadata(id,input) {
    this.ensureFree(id);
    if(!input||typeof input!=='object'||Array.isArray(input)||(input.title===undefined&&input.archived===undefined))throw failure('Choose a title or archive change.');
    const title=input.title===undefined?undefined:text(input.title,'story title',160).trim();
    if(title!==undefined&&!title)throw failure('Enter a story title.');
    if(input.archived!==undefined&&typeof input.archived!=='boolean')throw failure('Invalid archive setting.');
    await this.store.mutate(id,undefined,story=>{
      this.assertVersion(story,input.expectedVersion);
      if(title!==undefined){story.title=title;story.setup.title=title;}
      if(input.archived!==undefined)story.archived=input.archived;
    });
    return this.view(id);
  }
  ensureFree(id) { if(this.busy.has(id)) throw failure('This story is already generating. Stop it or wait for the current turn.',409,'STORY_BUSY'); }
  assertVersion(story,version) {if(!Number.isInteger(version)||version!==story.version) throw failure('This story changed. Refresh it before trying again.',409,'STALE_STORY');}
  env(settings,lease,traceContext,mode) {
    const provider=loggedProvider(this.makeProvider(settings),{store:this.store,settings,getContext:()=>({...traceContext,stage:lease.stage})});
    return {settings,traceContext,complete:request=>{
      const prepared=clone(request.messages);
      for(const message of prepared) {
        if(mode==='simple')continue;
        if(message.role!=='user'||typeof message.content!=='string')continue;
        let payload;try{payload=JSON.parse(message.content);}catch{continue;}
        for(const key of ['world','state','establishedWorld'])if(payload[key]?.characters&&payload[key]?.events)payload[key]=narratorProjection(payload[key]);
        message.content=JSON.stringify(payload);
      }
      return provider.complete({...request,messages:prepared});
    },unifiedPresentation:true,signal:lease.controller.signal,onStage:stage=>{lease.stage=stage;}};
  }
  async create(input) {
    const setup=validateSetup(input),id=makeId(),branchId=makeId(),createdAt=new Date().toISOString();
    const initialState=setup.mode==='simple'?createSimpleState(setup):createInitialState(setup);
    const story={id,title:setup.title,setup,createdAt,updatedAt:createdAt,version:0,activeBranchId:branchId,branches:{[branchId]:{id:branchId,name:'Original',parentId:null,forkMessageId:null,createdAt,initialState,messages:[],responses:[],illustrations:[]}}};
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
        await work(story,this.env(settings,lease,traceContext,story.setup.mode));
        lease.controller.signal.throwIfAborted();
      });
    } catch(error) {
      if(traceContext)await appendDebugError(this.store,{...traceContext,stage:error.stage??lease.stage,operation:'story',terminal:true},error).catch(()=>{});
      throw error;
    } finally {if(this.busy.get(id)===lease) this.busy.delete(id);}
    if(illustrate) await this.illustrator.schedule(id).catch(()=>{});
    return this.view(id);
  }
  async turn(id,version,input) {
    if(input!==null) text(input,'message');
    return this.operation(id,version,async (story,env)=>{
      const branch=story.branches[story.activeBranchId];
      if(story.setup.mode==='simple'){
        const result=await runSimpleTurn({...env,state:branchWorld(branch),messages:transcript(branch.messages),input});
        branch.messages.push(...result.messages);return;
      }
      const state=await compactKnowledge(branchWorld(branch),{...env,messages:transcript(branch.messages),buildRequest:buildContextRequest});
      const result=await runTurn({...env,state,messages:transcript(branch.messages),input});
      branch.messages.push(...result.messages);
      const response=await composeResponse(result.messages,env);
      if(response)(branch.responses??=[]).push(response);
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
      if(mode!=='rewind'&&old.messages[index].internal)throw failure('Internal checkpoints cannot be edited or deleted.');
      const retainedCount=mode==='rewind'?index+1:index;
      const messages=clone(old.messages.slice(0,retainedCount));
      let state=clone(messages.at(-1)?.snapshot??old.initialState);
      const newId=makeId();
      env.traceContext.branchId=newId;
      env.traceContext.parentBranchId=old.id;
      env.traceContext.anchorMessageId=input.messageId;
      const branch={id:newId,name:`${mode==='edit'?'Revision':mode==='delete'?'Without passage':'Continuation'} ${Object.keys(story.branches).length}`,parentId:old.id,forkMessageId:input.messageId??null,createdAt:new Date().toISOString(),initialState:clone(old.initialState),messages,illustrations:clone(old.illustrations.filter(image=>messages.some(m=>m.id===image.anchorMessageId)))};
      const retained=retainResponses(old.responses,messages);if(retained!==undefined)branch.responses=retained;
      const revisionStart=messages.length;
      const simple=story.setup.mode==='simple';
      if(mode==='edit') {
        const edited={...clone(old.messages[index]),id:makeId(),text:input.text,createdAt:new Date().toISOString()};delete edited.snapshot;
        const result=await (simple?applySimpleAuthoredMessage:applyAuthoredMessage)({...env,state,messages:transcript(messages),message:edited});
        branch.messages.push(...result.messages);state=result.state;
      }
      if(input.regenerate===true||(mode!=='rewind'&&input.regenerate!==false)) {
        if(!simple)state=await compactKnowledge(state,{...env,messages:transcript(branch.messages),buildRequest:buildContextRequest});
        const continuation=await (simple?runSimpleTurn:runTurn)({...env,state,messages:transcript(branch.messages),input:null});
        if(simple&&branch.messages.at(-1)?.role==='player')branch.messages.at(-1).visiblePlayerInput=continuation.visiblePlayerInput;
        branch.messages.push(...continuation.messages);
      }
      const response=simple?null:await composeResponse(branch.messages.slice(revisionStart),env);
      if(response)(branch.responses??=[]).push(response);
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
  async remove(id) {this.ensureFree(id);await this.illustrator.cancel(id);await this.store.remove(id);this.usageCache.delete(id);return {ok:true};}
  async illustrate(id,{messageId,expectedVersion}) {
    this.ensureFree(id);this.assertVersion(await this.store.get(id),expectedVersion);
    await this.illustrator.schedule(id,{manual:true,messageId});return this.view(id);
  }
  async appearance(id,input) {
    text(input.characterId,'character identity',100);
    if(input.canSee!==undefined&&typeof input.canSee!=='boolean')throw failure('Invalid visual perception access.');
    try{validateVisualFacts(input.facts);}catch(error){throw failure(error.message);}
    return this.operation(id,input.expectedVersion,async(story,env)=>{
      if(story.setup.mode==='simple')throw failure('Individual character appearance controls are available in Detailed mode.');
      const old=story.branches[story.activeBranchId];
      if(!branchWorld(old).characters.some(c=>c.id===input.characterId))throw failure('Character not found.',404);
      const newId=makeId();
      env.traceContext.parentBranchId=old.id;env.traceContext.branchId=newId;
      const result=await applyVisualCorrection({...env,state:branchWorld(old),messages:transcript(old.messages),characterId:input.characterId,facts:input.facts,canSee:input.canSee});
      story.branches[newId]={...clone(old),id:newId,name:`Appearance correction ${Object.keys(story.branches).length}`,parentId:old.id,forkMessageId:old.messages.at(-1)?.id??null,createdAt:new Date().toISOString(),messages:[...clone(old.messages),...result.messages]};
      story.activeBranchId=newId;story.illustrationJob={status:'cancelled'};
    },{interruptImages:true,illustrate:false});
  }
  async characterPrompt(id,input) {
    text(input.characterId,'character identity',100);text(input.systemPrompt,'character system prompt',60000,true);
    if(input.characterId==='player')throw failure('The player is not an AI character.');
    return this.operation(id,input.expectedVersion,async(story,env)=>{
      if(story.setup.mode==='simple')throw failure('Individual character instructions are available in Detailed mode.');
      const old=story.branches[story.activeBranchId],state=branchWorld(old);
      if(!state.characters.some(c=>c.id===input.characterId))throw failure('Character not found.',404);
      const newId=makeId();env.traceContext.parentBranchId=old.id;env.traceContext.branchId=newId;
      const result=applyCharacterPrompt({state,characterId:input.characterId,systemPrompt:input.systemPrompt});
      story.branches[newId]={...clone(old),id:newId,name:`Character instructions ${Object.keys(story.branches).length}`,parentId:old.id,forkMessageId:old.messages.at(-1)?.id??null,createdAt:new Date().toISOString(),messages:[...clone(old.messages),...result.messages]};
      story.activeBranchId=newId;story.illustrationJob={status:'cancelled'};
    },{interruptImages:true,illustrate:false});
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
      if(story.setup.mode==='simple'?world.mode!=='simple':world.mode!==undefined&&world.mode!=='detailed')throw failure('Imported checkpoint mode does not match the story mode.');
      const ids=new Set();
      if(world.perceptionMode!==undefined&&world.perceptionMode!=='helper')throw failure('Invalid imported perception mode.');
      for(const c of world.characters) {
        if(typeof c.id!=='string'||ids.has(c.id)||typeof c.name!=='string'||typeof c.location!=='string'||!Array.isArray(c.knowledge)||!c.online||typeof c.online.access!=='boolean') throw failure('An imported character is invalid.');
        if(c.visual!==undefined){
          if(c.visual?.initialized!==true||!Number.isInteger(c.visual.revision)||c.visual.revision<0||(c.visual.canSee!==undefined&&typeof c.visual.canSee!=='boolean'))throw failure('Invalid imported visual state.');
          try{validateVisualFacts(c.visual.facts);}catch(error){throw failure(error.message);}
        }
        if(c.seenAppearance!==undefined){
          if(!c.seenAppearance||typeof c.seenAppearance!=='object'||Array.isArray(c.seenAppearance))throw failure('Invalid imported appearance memories.');
          for(const view of Object.values(c.seenAppearance))for(const key of ['facts','current']){
            if(!Array.isArray(view?.[key])||view[key].some(f=>typeof f.key!=='string'||typeof f.text!=='string'))throw failure('Invalid imported appearance memories.');
          }
        }
        ids.add(c.id);
        if(c.systemPrompt!==undefined)text(c.systemPrompt,'imported character system prompt',60000,true);
      }
      for(const c of world.characters)if(c.visibleCharacters!==undefined&&(!Array.isArray(c.visibleCharacters)||c.visibleCharacters.some(id=>typeof id!=='string'||id===c.id||!ids.has(id))))throw failure('Invalid imported visible characters.');
    };
    let count=0;
    for(const [key,branch] of Object.entries(story.branches)) {
      if(!/^[a-zA-Z0-9_-]{1,100}$/.test(key)||branch.id!==key||!Array.isArray(branch.messages)||!Array.isArray(branch.illustrations)||typeof branch.name!=='string') throw failure('Invalid imported branch.');
      validateWorld(branch.initialState);
      const messages=new Set();
      for(const m of branch.messages) {
        if(++count>10000||typeof m.id!=='string'||messages.has(m.id)||!['player','character','narrator'].includes(m.role)||typeof m.speaker!=='string') throw failure('Invalid imported message.');
        if(m.internal!==undefined&&typeof m.internal!=='boolean')throw failure('Invalid imported internal checkpoint.');
        if(m.internal===true&&(m.role!=='narrator'||m.text!==''))throw failure('Invalid imported internal checkpoint.');
        text(m.text,'imported message',60000,m.internal===true);validateWorld(m.snapshot);messages.add(m.id);
        if(m.visiblePlayerInput!==undefined){
          if(story.setup.mode!=='simple'||m.role!=='player')throw failure('Invalid imported visible player input.');
          text(m.visiblePlayerInput,'imported visible player input',60000,true);
        }
      }
      try{validateResponses(branch);}catch(error){throw failure(error.message);}
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
