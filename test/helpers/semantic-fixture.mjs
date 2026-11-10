// Deterministic model responses for older orchestration tests. These simple
// fixture policies are not used by the application; semantic behavior has its
// own scripted edge-case tests.
import {createHash} from 'node:crypto';
export function semanticReply(request){
  const system=request.messages[0].content;
  if(system.includes('PLAYER PASSAGE PRESENTER')){
    const {contributions}=JSON.parse(request.messages[1].content);
    return JSON.stringify({parts:contributions.map(m=>({text:m.text,sourceMessageIds:[m.id],evidence:[{messageId:m.id,excerpt:m.text}],spoken:[]})),omitted:[],faithful:true});
  }
  if(!/PERCEPTION HELPER|PUBLIC AWARENESS HELPER|REACTIVE TURN SCHEDULER/.test(system))return null;
  const data=JSON.parse(request.messages[1].content),world=data.world;
  if(system.includes('REACTIVE TURN SCHEDULER'))return JSON.stringify({nextCharacterId:data.suggestions[data.called.length]??null,yieldToPlayer:false,reason:'Scripted fixture order.'});
  if(system.includes('PUBLIC AWARENESS HELPER'))return JSON.stringify({decisions:data.candidates.map(c=>{
    const pub=c.publication??world.publications.find(p=>p.id===c.publicationId),who=world.characters.find(p=>p.id===c.characterId),audience=pub.audience;
    const eligible=audience.type==='online'?who.online.access&&(!audience.characterIds?.length||audience.characterIds.includes(who.id)):audience.locations.includes(who.location);
    const connected=who.id===pub.authorId||who.online.connections.includes(pub.authorId)||who.online.connections.includes(world.characters.find(p=>p.id===pub.authorId)?.name);
    const relevant=(audience.interests||[]).some(i=>who.online.interests.includes(i));
    const sample=createHash('sha256').update(c.key).digest().readUInt32BE(0)/0x100000000;
    return {key:c.key,aware:eligible&&(sample<(audience.type!=='online'||connected?1:relevant?.75:.15)),reason:'Scripted exposure fixture.'};
  })});
  const event=data.event;
  return JSON.stringify({deliveries:event?world.characters.filter(c=>c.id!==event.characterId&&c.location===event.location&&(!event.intendedRecipients?.length||event.intendedRecipients.includes(c.id))).map(c=>({characterId:c.id,text:event.text,excerpts:[event.text],speaker:world.characters.find(p=>p.id===event.characterId)?.name??'Narrator'})):[],views:world.characters.map(c=>({observerId:c.id,subjects:c.visual?.canSee===false?[]:world.characters.filter(p=>p.id!==c.id&&p.location===c.location).map(p=>({characterId:p.id,keys:(p.visual?.facts||[]).filter(f=>f.visible).map(f=>f.key)}))}))});
}
