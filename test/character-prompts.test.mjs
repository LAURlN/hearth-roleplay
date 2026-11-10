import {semanticReply} from './helpers/semantic-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createInitialState,runTurn,applyCharacterPrompt,characterContext} from '../src/engine.mjs';
import {narratorProjection} from '../src/memory.mjs';

const settings={chatModel:'actor-model',helperModel:'helper-model',roleplayPrompt:'GENERAL ROLEPLAY RULES',characterPrompt:'SHARED CHARACTER ACTING RULES',contextMessages:24,maxResponders:3};
const cast=[{name:'Ada',systemPrompt:'ADA INDIVIDUAL INSTRUCTIONS'},{name:'Ben',systemPrompt:'BEN INDIVIDUAL INSTRUCTIONS'}];
function world(){return createInitialState({location:'room',persona:{name:'Pat'},characters:cast});}

test('each actor receives general, shared and only its own individual system rules',async()=>{
  const state=world();let actors=0;
  const complete=async request=>{
    const system=request.messages[0].content,data=JSON.parse(request.messages[1].content);
    assert.ok(system.includes(settings.roleplayPrompt));
    if(semanticReply(request)!==null)return semanticReply(request);
    if(system.includes('CHARACTER VISUAL STATE')){assert.ok(!system.includes(settings.characterPrompt));return '{"patches":[]}';}
    if(system.includes('omniscient narrator/planner')){assert.ok(!system.includes(settings.characterPrompt));return JSON.stringify({events:[],text:'The room is quiet.',speakers:state.characters.filter(c=>c.id!=='player').map(c=>c.id)});}
    if(system.includes('You play ONLY')){
      actors++;assert.equal(request.model,'actor-model');assert.ok(system.includes(settings.characterPrompt));
      const own=state.characters.find(c=>c.id===data.context.character.id),other=state.characters.find(c=>c.id!=='player'&&c.id!==own.id);
      assert.ok(system.includes(own.systemPrompt));assert.ok(!JSON.stringify(request).includes(other.systemPrompt));
      assert.ok(system.indexOf(own.systemPrompt)<system.indexOf('You play ONLY'));
      return JSON.stringify({text:`${own.name} greets Pat.`,privateState:'',movement:null});
    }
    throw new Error('Unexpected request');
  };
  await runTurn({state,settings,complete,input:null});assert.equal(actors,2);
});

test('creation curator receives general rules; model-invented prompt fields never become actor system instructions',async()=>{
  const state=createInitialState({location:'room',persona:{name:'Pat'}});
  const newcomer={id:'new-person',name:'Cy',location:'room',systemPrompt:'MODEL INVENTED SYSTEM OVERRIDE'};
  let curated=false,acted=false;
  const complete=async request=>{
    const system=request.messages[0].content;
    if(semanticReply(request)!==null)return semanticReply(request);
    if(system.includes('CHARACTER VISUAL STATE'))return '{"patches":[]}';
    if(system.includes('omniscient narrator/planner'))return JSON.stringify({text:'',events:[{type:'introduction',character:newcomer,reason:'A new arrival.'}],speakers:[newcomer.id]});
    if(system.includes('CHARACTER CONTEXT CURATOR')){
      curated=true;assert.equal(request.model,'helper-model');assert.ok(system.includes(settings.roleplayPrompt));assert.ok(!system.includes(settings.characterPrompt));
      return JSON.stringify({character:newcomer,knowledge:[],continuity:null,memories:[]});
    }
    if(system.includes('You play ONLY')){acted=true;assert.ok(system.includes(settings.characterPrompt));assert.ok(!system.includes(newcomer.systemPrompt));return '{"text":"Hello.","privateState":"","movement":null}';}
    throw new Error('Unexpected request');
  };
  const result=await runTurn({state,settings,complete,input:null});
  assert.ok(curated&&acted);assert.equal(result.state.characters.find(c=>c.id===newcomer.id).systemPrompt,'');
});

test('prompt changes are non-observable checkpoints and do not alter the original state or other character knowledge',()=>{
  const state=world(),ada=state.characters.find(c=>c.name==='Ada'),ben=state.characters.find(c=>c.name==='Ben');
  const baseline=structuredClone(state);
  const result=applyCharacterPrompt({state,characterId:ada.id,systemPrompt:'REVISED ADA INSTRUCTIONS'});
  assert.deepEqual(state,baseline);assert.equal(result.state.characters.find(c=>c.id===ada.id).systemPrompt,'REVISED ADA INSTRUCTIONS');
  assert.deepEqual(result.state.characters.find(c=>c.id===ben.id).knowledge,ben.knowledge);
  assert.ok(!JSON.stringify(characterContext(result.state,ben.id)).includes('REVISED ADA INSTRUCTIONS'));
  assert.ok(!JSON.stringify(narratorProjection(result.state)).includes('REVISED ADA INSTRUCTIONS'));
  assert.ok(!JSON.stringify(narratorProjection(result.state)).includes(ben.systemPrompt));
  assert.ok(!result.messages[0].text.includes('REVISED ADA INSTRUCTIONS'));
  assert.ok(!JSON.stringify(result.state.events).includes('REVISED ADA INSTRUCTIONS'));
  assert.throws(()=>applyCharacterPrompt({state,characterId:'player',systemPrompt:'Play for me'}),/player has no AI/);
});

test('failed character prompt edits keep their draft and submit exact text only for the selected actor',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const start=source.indexOf('  function openCharacterPrompt('),end=source.indexOf('  function addAppearanceRow(',start);
  const handlers=new Map(),fields=new Map();
  const field=id=>{
    if(!fields.has(id))fields.set(id,{value:'',addEventListener:(event,fn)=>handlers.set(`${id}:${event}`,fn),querySelectorAll:()=>[]});
    return fields.get(id);
  };
  const state={story:{id:'story',activeBranchId:'original'},promptEditor:{storyId:'story',branchId:'original',characterId:'ada'}};
  let succeeds=false,body,closed=0;
  field('character-prompt-text').value='Keep a dry sense of humour.\n Preserve this exact line.';
  vm.runInNewContext(source.slice(start,end),{state,$:field,locked:()=>false,inlineError(){},toast(){},closeDialog(){closed++;},mutateStory:async(path,input)=>{assert.equal(path,'/character-prompt');body=input;return succeeds;}});
  await handlers.get('character-prompt-form:submit')({preventDefault(){}});
  assert.equal(body.characterId,'ada');assert.equal(body.systemPrompt,field('character-prompt-text').value);assert.equal(closed,0);assert.equal(state.characterPromptSaving,false);
  succeeds=true;await handlers.get('character-prompt-form:submit')({preventDefault(){}});assert.equal(closed,2);
});
