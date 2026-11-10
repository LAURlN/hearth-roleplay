import {createInitialState,parseJson} from './engine.mjs';
import {compactKnowledge} from './memory.mjs';
import {makeId,clone} from './store.mjs';
import {SIMPLE_MODE_PROMPT} from './settings.mjs';

const instruction=`SIMPLE ROLEPLAY NARRATOR. Write the next player-visible passage yourself: narration and all NPC speech/actions in one coherent response. Establish the opening when history is empty; otherwise continue from the latest authored passage without replaying it. Only the player controls the player. Return JSON {"text":"player-visible passage","visiblePlayerInput":"latest player's perceptible speech/actions only, empty for private input or continuation","scene":{"location":"optional established location","timeLabel":"optional time label","characters":[{"id":"existing ID or new stable ID","name":"name","appearance":"established visible description","location":"established location"}]}}. scene is optional; include only established public details. Respect the distinction between private authoring guidance and observable events; previously private facts may later be deliberately disclosed or naturally revealed in the story. visiblePlayerInput is used for images, so omit thoughts, OOC directions and anything uncertain. A refusal may be returned as {"refusal":"reason"}.`;

export function createSimpleState(setup){return {...createInitialState(setup),mode:'simple'};}
function historyStart(messages,memory){
  if(memory?.throughMessageId){const index=messages.findIndex(m=>m.id===memory.throughMessageId);if(index>=0)return index+1;}
  return Number.isInteger(memory?.throughMessages)?Math.max(0,Math.min(messages.length,memory.throughMessages)):0;
}
export function buildSimpleContextRequest(state,messages=[],settings={}){
  const story={title:state.title,premise:state.premise,time:state.time,timeLabel:state.timeLabel,location:state.location,characters:state.characters.map(({knowledge,memory,seenAppearance,visibleCharacters,...profile})=>profile),continuityNotes:state.narratorMemory?.summary??''};
  const history=messages.slice(historyStart(messages,state.narratorMemory)).filter(m=>!m.internal).map(({role,text})=>({role:role==='player'?'user':'assistant',content:text}));
  const request=[{role:'system',content:`${settings.simpleModePrompt??SIMPLE_MODE_PROMPT}\n\n${instruction}\n\nStory context:\n${JSON.stringify(story)}`},...history];
  if(!history.length)request.push({role:'user',content:state.narratorMemory?'Continue the story from the continuity notes.':'Begin the roleplay from the supplied premise.'});
  else if(history.at(-1).role!=='user')request.push({role:'user',content:'Continue from the latest passage without choosing the player\'s actions.'});
  return request;
}
function publicText(value,label,empty=false){
  if(typeof value!=='string'||(!empty&&!value.trim())||value.length>60000)throw new Error(`Invalid ${label}.`);
  if(/\[(?:OOC|THOUGHT)\s*:/i.test(value))throw new Error('Private player markers cannot enter a public passage or illustration.');
  return value;
}
function passage(state,role,text,extra={}){return {id:makeId(),role,speaker:role==='player'?state.characters.find(c=>c.id==='player').name:'Narrator',...(role==='player'?{characterId:'player'}:{}),text,createdAt:new Date().toISOString(),storyTime:state.time,eventCount:state.events.length,...extra,snapshot:clone(state)};}
function applyScene(state,scene){
  if(scene===undefined)return;
  if(!scene||typeof scene!=='object'||Array.isArray(scene))throw new Error('Invalid simple scene.');
  const openingLocation=state.location==='Opening location';
  for(const key of ['location','timeLabel'])if(scene[key]!==undefined)state[key]=publicText(scene[key],`scene ${key}`);
  if(openingLocation)for(const character of state.characters)if(character.location==='Opening location')character.location=state.location;
  if(!state.locations.includes(state.location))state.locations.push(state.location);
  if(scene.characters!==undefined){
    if(!Array.isArray(scene.characters)||scene.characters.length>100)throw new Error('Invalid simple scene characters.');
    const ids=new Set();
    for(const value of scene.characters){
      if(!value||typeof value.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(value.id)||ids.has(value.id))throw new Error('Invalid simple character identity.');
      ids.add(value.id);
      let character=state.characters.find(c=>c.id===value.id);
      if(!character){
        const name=publicText(value.name,'simple character name');
        character={id:value.id,name,description:'',appearance:'',personality:'',goals:'',location:state.location,knowledge:[],privateState:'',online:{access:false,interests:[],connections:[]}};
        state.characters.push(character);
      }
      for(const key of ['name','appearance','location'])if(value[key]!==undefined)character[key]=publicText(value[key],`character ${key}`,key==='appearance');
      if(!state.locations.includes(character.location))state.locations.push(character.location);
    }
  }
  // Public appearance metadata is authored by this same narrator, never a
  // second visual-maintenance request. Knowledge arrays stay untouched.
  state.characters.find(c=>c.id==='player').location=state.location;
}
export async function runSimpleTurn({state:source,messages=[],input=null,settings,complete,signal,onStage}){
  signal?.throwIfAborted();
  const state=clone(source),output=[];
  if(input!==null)output.push(passage(state,'player',input));
  const history=[...messages,...output];
  await compactKnowledge(state,{complete,settings:{...settings,helperModel:settings.chatModel,helperEffort:settings.chatEffort??''},signal,onStage,messages:history,target:'narrator',buildRequest:buildSimpleContextRequest});
  signal?.throwIfAborted();
  const stage='Narrating the story';onStage?.(stage);
  let raw;
  try{raw=await complete({model:settings.chatModel,reasoningEffort:settings.chatEffort||undefined,json:true,stage,signal,messages:buildSimpleContextRequest(state,history,settings)});}
  catch(error){if(error&&typeof error==='object')error.stage??=stage;throw error;}
  signal?.throwIfAborted();
  let result;
  // Plain prose remains compatible with providers that ignore JSON guidance.
  try{result=parseJson(raw);}catch(error){if(typeof raw!=='string'||/^\s*(?:\{|```)/.test(raw))throw error;result={text:raw};}
  if(typeof result.refusal==='string')throw new Error(result.refusal);
  const text=publicText(result.text,'simple narrator response');
  const visiblePlayerInput=result.visiblePlayerInput===undefined?'':publicText(result.visiblePlayerInput,'visible player input',true);
  if(output.length){output[0].visiblePlayerInput=visiblePlayerInput;output[0].snapshot=clone(state);}
  applyScene(state,result.scene);
  output.push(passage(state,'narrator',text));
  return {state,messages:output,visiblePlayerInput};
}
export function applySimpleAuthoredMessage({state:source,message}){
  const state=clone(source),authored={...clone(message),snapshot:clone(state)};
  // An edited claim is only authored history. No helper infers facts from it.
  if(authored.role==='player')delete authored.visiblePlayerInput;
  return {state,messages:[authored]};
}
