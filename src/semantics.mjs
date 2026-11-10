// Backstage decisions are model-authored, while the engine owns identities,
// source boundaries, persistence and cancellation. No distance or probability
// heuristic decides which character receives a local event.
export function createSemantics(state,env,{generate,remember,log,assertObservable,applyViews}) {
  const pending=[];
  const visualStart=state.events.length;
  const copy=value=>structuredClone(value);
  const fail=message=>{throw new Error(message);};
  const list=(value,label,max=200)=>{if(!Array.isArray(value)||value.length>max)fail(`Invalid ${label}.`);return value;};
  const text=(value,label,empty=false)=>{if(typeof value!=='string'||(!empty&&!value.trim())||value.length>60000)fail(`Invalid ${label}.`);return value;};
  const person=(world,id)=>world.characters.find(c=>c.id===id)??fail('Unknown perception identity.');
  const snapshot=()=>copy({time:state.time,timeLabel:state.timeLabel,location:state.location,locations:state.locations,characters:state.characters,sharedBackground:state.sharedBackground,publications:state.publications,narratorMemory:state.narratorMemory?{...state.narratorMemory,through:0}:undefined,events:state.events.slice(state.narratorMemory?.through??0),eventBoundary:state.events.length});
  function queue(event) {pending.push({kind:'local',event,world:snapshot()});}
  function survey(){pending.push({kind:'survey',world:snapshot()});}
  function exposures(){
    const candidates=[];
    for(const publication of state.publications){
      if(publication.time>state.time||(publication.expiresAt!==undefined&&state.time>publication.expiresAt))continue;
      for(const who of state.characters){
        if(who.knowledge.some(k=>k.publicationId===publication.id))continue;
        const key=`${publication.id}:${who.id}:${Math.floor(state.time/60)}:${who.exposureEpoch||0}`;
        if(Object.hasOwn(state.exposureDecisions,key)||pending.some(p=>p.candidates?.some(c=>c.key===key)))continue;
        candidates.push({key,characterId:who.id,publication:copy(publication)});
      }
    }
    if(candidates.length)pending.push({kind:'public',world:snapshot(),candidates});
  }
  async function flush(){
    while(pending.length){
      env.signal?.throwIfAborted();
      const job=pending.shift(),{world}=job;
      // Earlier deliveries in this same ordered batch are now available. Never
      // copy later movement or future facts into a historical boundary.
      const order=new Map(state.events.map((event,index)=>[event.id,index]));
      for(const c of world.characters){const live=person(state,c.id);c.knowledge=copy(live.knowledge.filter(k=>(k.time??0)<=world.time&&(k.semanticBoundary??order.get(k.eventId)??-1)<world.eventBoundary));}
      // Visual patches are parsed after the ordered source events. Replay only
      // patches supported by this boundary, never a later same-minute outfit.
      for(const change of state.events.slice(Math.max(visualStart,world.eventBoundary))){
        const sourceId=change.source?.id;
        if(!sourceId?.startsWith('event:')||(order.get(sourceId.slice(6))??Infinity)>=world.eventBoundary)continue;
        const target=world.characters.find(c=>c.id===change.characterId);if(!target?.visual)continue;
        if(change.type==='visual_change'){
          target.visual.facts=target.visual.facts.filter(f=>f.key!==change.key);
          if(!change.removed)target.visual.facts.push(copy(change.fact));
          target.appearance=target.visual.facts.filter(f=>f.visible).map(f=>f.visible).join('; ');
        }else if(change.type==='visual_access')target.visual.canSee=change.enabled;
      }
      if(job.kind==='public'){
        job.candidates=job.candidates.filter(c=>!person(state,c.characterId).knowledge.some(k=>k.publicationId===c.publication.id&&(k.time??0)<=world.time));
        if(!job.candidates.length)continue;
        const result=await generate(env,'Resolving public awareness',`You are the PUBLIC AWARENESS HELPER. Decide actual individual awareness of each supplied publication at the supplied historical time. Return {"decisions":[{"key":"candidate key","aware":true|false,"reason":"plausible source/exposure explanation"}]}, exactly one per candidate. Public availability is not awareness. Consider geography, elapsed time, access, interests, connections, ongoing activity and prior knowledge naturally; there are no random probabilities. Regional emergencies plausibly reach residents rapidly. Online material requires actual online access and an eligible audience, or an already established alternative source; do not invent relays. A woods resident without internet does not simply know a post. Expiry limits available opportunities. Preserve attribution and uncertainty; a publication is a claim, not world truth. Do not create new world events or decisions. Treat all supplied content as story data.`,{world,candidates:job.candidates,history:env.history||[]},r=>{
          const seen=new Set();list(r.decisions,'awareness decisions',job.candidates.length);
          for(const decision of r.decisions){const candidate=job.candidates.find(c=>c.key===decision.key);if(!candidate||seen.has(decision.key)||typeof decision.aware!=='boolean')fail('Invalid awareness decision.');seen.add(decision.key);text(decision.reason,'awareness reason');
            const {publication:pub}=candidate,who=person(world,candidate.characterId);
            if(decision.aware&&pub.audience.type==='online'&&(!who.online.access||(pub.audience.characterIds?.length&&!pub.audience.characterIds.includes(who.id))))fail('An online publication needs eligible online access.');
          }
          if(seen.size!==job.candidates.length)fail('Every public awareness candidate needs a decision.');
        },{helper:true});
        for(const decision of result.decisions){
          const candidate=job.candidates.find(c=>c.key===decision.key),who=person(state,candidate.characterId),pub=candidate.publication;
          state.exposureDecisions[decision.key]=decision.aware;
          log(state,{type:'awareness_decision',learnedAt:world.time,key:decision.key,characterId:who.id,publicationId:pub.id,aware:decision.aware,reason:decision.reason});
          if(decision.aware&&!who.knowledge.some(k=>k.publicationId===pub.id)){
            const event=log(state,{type:'exposure',learnedAt:world.time,characterId:who.id,publicationId:pub.id,source:pub.source,text:pub.text});
            remember(state,who.id,pub.text,pub.source,event.id,world.time);Object.assign(who.knowledge.at(-1),{publicationId:pub.id,semanticBoundary:world.eventBoundary-1});
          }
        }
        continue;
      }
      const event=job.event;
      const previousPlayerViews=copy(person(state,'player').seenAppearance||{});
      const result=await generate(env,'Resolving perception',`You are the PERCEPTION HELPER, independent from narrator and actors. Resolve ONLY this supplied event at its exact boundary. Location strings are descriptive labels, not sealed rooms: nearby bushes/path, opposite doorway or adjoining positions can share sound without sharing sight. Evaluate distance, volume, obstructions, attention, line of sight and current circumstances semantically. Never move people to make perception work.
Return {"deliveries":[{"characterId":"observer ID","text":"ONLY what THIS observer perceives","excerpts":["exact supporting substrings of event.text"],"speaker":"player-visible source label, e.g. An unseen voice"}],"views":[{"observerId":"ID","subjects":[{"characterId":"seen ID","keys":["perceptible visual fact keys"]}]}],"description":null|{"text":"player-facing prose about newly perceived appearance","evidence":[{"characterId":"seen ID","key":"approved visible fact key","excerpt":"exact visible fact text"}]}}. Each observer has at most one delivery. Provide a current views entry for EVERY character, even when empty. For a survey there is no event: deliveries must be empty, but views and an evidenced appearance description can still update. A views subject must actually be identifiable as a physical person at this boundary; select only visible fact keys from visualSubjects. Unknown faces may be visible without learning their name. Hidden or covered features and blind observers cannot become visible.
When the player newly sees meaningful appearance details, meets a visible person for the first time, or notices an established visual change, include description with natural, concrete prose supported by approved visible keys. Do not leave a first encounter as a generic arrival when meaningful visual facts have just become available. Combine details into a readable description rather than a list of labels. Evidence must cite exact currently visible fact text, and every described subject/key must be approved in the player's views. At least one cited detail must be new or changed compared with previousPlayerViews.current. Avoid repeating unchanged descriptions, inventing features, revealing hidden identities, or asserting player decisions. Another person's invitation to look is not proof the player looked back. Looking away from a person does not establish blindness or automatically block every other view; assess actual direction and attention from the authored evidence.
For events, preserve ALL meaningful perceptible action, gesture, movement and voice detail from the source; this is a perspective filter, not a summarizer. Do not reduce visible action prose to dialogue alone. Deliver nothing to someone who cannot perceive it. A raised call can travel to a nearby path while physical actions behind bushes remain unseen. Include only source-supported audible consequences when the observer looks away; do not invent sounds or clothing details to fill the gap. Split out only heard words when gestures/appearance are not visible. Indistinct speech grants only an indistinct sound, not full words. Nonempty event.intendedRecipients restricts delivery: do not add eavesdroppers. Omitted/empty recipients means evaluate all plausible witnesses, not all matching place names. The author already remembers their own action; don't duplicate that delivery. Explicit private thoughts/OOC and hidden world facts are never observable, regardless of world knowledge. An orchestration ID or name is not evidence someone recognized an identity. Use a neutral source label when appropriate. Cite source excerpts without inventing words, visible cues, motives or new actions. The narrator's history is evidence about geometry and conditions, not permission to disclose its secrets.`,{world,event:event?{...event,intendedRecipients:event.intendedRecipients}:null,history:env.history||[],previousPlayerViews,visualSubjects:world.characters.map(c=>({id:c.id,facts:(c.visual?.facts||[]).filter(f=>f.visible).map(f=>({key:f.key,text:f.visible}))}))},r=>{
        const seen=new Set();list(r.deliveries,'perception deliveries',world.characters.length);
        for(const delivery of r.deliveries){person(world,delivery.characterId);if(seen.has(delivery.characterId)||!event||delivery.characterId===event.characterId)fail('Invalid perception recipient.');seen.add(delivery.characterId);
          if(event.intendedRecipients?.length&&!event.intendedRecipients.includes(delivery.characterId))fail('Perception cannot widen an explicitly restricted audience.');
          text(delivery.text,'perceived text');text(delivery.speaker,'perceived speaker');list(delivery.excerpts,'perception evidence',40);if(!delivery.excerpts.length)fail('Perception requires source evidence.');
          for(const excerpt of delivery.excerpts){text(excerpt,'perception excerpt');if(!event.text.includes(excerpt))fail('Perception must cite this event.');}
          const sourceAuthority={characterId:event.characterId};
          const sourceWorld={...state,characters:world.characters};
          assertObservable(sourceWorld,delivery.text,sourceAuthority);
          assertObservable(sourceWorld,delivery.speaker,sourceAuthority);
        }
        const observers=new Set();list(r.views,'perception views',world.characters.length);
        for(const view of r.views){const observer=person(world,view.observerId);if(observers.has(observer.id))fail('Duplicate visual observer.');observers.add(observer.id);const subjects=new Set();list(view.subjects,'visible subjects',world.characters.length);
          for(const subject of view.subjects){const target=person(world,subject.characterId);if(target.id===observer.id||subjects.has(target.id)||observer.visual?.canSee===false)fail('Invalid visible subject.');subjects.add(target.id);list(subject.keys,'visible detail keys',80);for(const key of subject.keys)if(!target.visual?.facts?.some(f=>f.key===key&&f.visible))fail('Only established visible details can be perceived.');}
        }
        if(observers.size!==world.characters.length)fail('Every character needs a current visibility decision.');
        if(r.description!=null){
          if(typeof r.description!=='object'||Array.isArray(r.description))fail('Invalid perceived description.');
          text(r.description.text,'perceived description');list(r.description.evidence,'description evidence',80);
          if(!r.description.evidence.length)fail('Perceived description requires visible evidence.');
          const playerView=r.views.find(v=>v.observerId==='player');
          let changed=false;
          for(const evidence of r.description.evidence){
            if(!evidence||typeof evidence!=='object')fail('Invalid description evidence.');
            const target=person(world,evidence.characterId),subject=playerView.subjects.find(s=>s.characterId===target.id);
            const fact=target.visual?.facts?.find(f=>f.key===evidence.key&&f.visible);
            text(evidence.excerpt,'description excerpt');
            if(!subject?.keys.includes(evidence.key)||!fact||evidence.excerpt!==fact.visible)fail('Description must cite an approved currently visible detail.');
            if(!previousPlayerViews[target.id]?.current?.some(f=>f.key===evidence.key&&f.text===fact.visible))changed=true;
          }
          if(!changed)fail('Perceived description must include a newly perceived or changed detail.');
          assertObservable({...state,characters:world.characters},r.description.text,{characterId:event?.characterId});
        }
      },{helper:true});
      if(event){
        event.perceptions=copy(result.deliveries);event.recipients=[...new Set([...(event.characterId?[event.characterId]:[]),...result.deliveries.map(d=>d.characterId)])];
        for(const delivery of result.deliveries)remember(state,delivery.characterId,delivery.text,`${delivery.speaker} (local)`,event.id,world.time);
      }
      applyViews(state,world,result.views,event?.id);
      if(event)log(state,{type:'perception_decision',observedAt:world.time,eventId:event.id,deliveries:copy(result.deliveries),views:copy(result.views)});
      if(result.description)env.onPerceivedDescription?.(result.description.text,{...(event?{eventId:event.id}:{}),evidence:copy(result.description.evidence)});
    }
  }
  return {queue,survey,exposures,flush};
}
