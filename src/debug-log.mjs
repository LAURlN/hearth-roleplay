import { randomUUID,createHash } from 'node:crypto';

function imageInfo(bytes,type='image/png') {
  return {type,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}
function printable(value) {
  if(typeof value==='string') {
    const match=/^data:([^;,]+);base64,([\s\S]+)$/.exec(value);
    if(match)return {inlineImage:imageInfo(Buffer.from(match[2],'base64'),match[1])};
    return value;
  }
  if(Array.isArray(value))return value.map(printable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,printable(item)]));
  return value;
}

// Capture semantic prompts and raw model text, never transport headers or OAuth
// credentials. Actual image bytes remain in the story's local image files.
export function appendDebugError(store,context,error) {
  return store.appendDebug(context.storyId,{...context,kind:context.terminal?'operation error':'error',at:new Date().toISOString(),error:{message:error.message,name:error.name,code:error.code,status:error.status,...(error.response?{response:printable(error.response)}:{})}});
}

export function loggedProvider(provider,{store,settings,getContext}) {
  async function recorded(operation,request,perform) {
    const context={...getContext(),requestId:randomUUID(),operation};
    await store.appendDebug(context.storyId,{...context,kind:'request',at:new Date().toISOString(),request:printable(request)});
    try {
      const response=await perform();
      const output=operation==='image'?{image:imageInfo(response.bytes,response.type)}:response;
      await store.appendDebug(context.storyId,{...context,kind:'response',at:new Date().toISOString(),response:output});
      return response;
    }catch(error){
      await appendDebugError(store,context,error);
      throw error;
    }
  }
  return {
    ...provider,
    complete:request=>recorded('text',{model:request.model??settings.chatModel,...(request.reasoningEffort?{reasoningEffort:request.reasoningEffort}:{}),messages:request.messages},()=>provider.complete(request)),
    image:request=>recorded('image',{model:settings.imageModel,quality:settings.imageQuality,size:settings.imageSize,prompt:request.prompt,referenceImages:(request.references??[]).map(reference=>imageInfo(reference.bytes,reference.type))},()=>provider.image(request)),
  };
}

export function formatDebugLog(records,{storyId,title}) {
  const lines=['HEARTH AI DEBUG LOG',`Story: ${title} (${storyId})`,'Contains full private character contexts, thoughts and OOC. Review before sharing.','Image bytes are represented by type, length and SHA-256; text prompts and model replies are retained.',''];
  if(!records.length)lines.push('No AI calls recorded yet. Logging begins with requests made after the debug-log update.');
  for(const record of records) {
    lines.push(`=== ${String(record.kind??'record').toUpperCase()} ${record.requestId??''} ===`, `Time: ${record.at??''}`, `Stage: ${record.stage??''}`, `Operation: ${record.operation??''}`, `Branch: ${record.branchId??''}`, `Turn: ${record.turnId??''}`);
    if(record.anchorMessageId)lines.push(`Message: ${record.anchorMessageId}`);
    const value=record.request??record.response??record.error??record;
    lines.push(typeof value==='string'?value:JSON.stringify(value,null,2),'');
  }
  return lines.join('\n');
}
