import { validateProxyUrl } from './settings.mjs';

export class ProviderError extends Error {
  constructor(message, status = 502, code = 'PROXY_ERROR') { super(message); this.status = status; this.code = code; }
}

function visionRequest(model,messages) {
  const instructions=[];const input=[];
  for(const message of messages) {
    const parts=typeof message.content==='string'?[{type:'text',text:message.content}]:message.content;
    if(!Array.isArray(parts))throw new ProviderError('Invalid visual conversation content.',400);
    if(message.role==='system'||message.role==='developer') {
      if(parts.some(part=>part.type!=='text'))throw new ProviderError('Visual references belong in a user message.',400);
      instructions.push(parts.map(part=>part.text).join(''));continue;
    }
    if(!['user','assistant'].includes(message.role))throw new ProviderError('Unsupported visual conversation role.',400);
    const content=parts.map(part=>{
      if(part.type==='text'&&typeof part.text==='string')return {type:message.role==='assistant'?'output_text':'input_text',text:part.text};
      if(message.role==='user'&&part.type==='image_url'&&typeof part.image_url?.url==='string')return {type:'input_image',image_url:part.image_url.url,...(part.image_url.detail?{detail:part.image_url.detail}:{})};
      throw new ProviderError('Unsupported visual conversation content.',400);
    });
    input.push({role:message.role,content});
  }
  return {model,instructions:instructions.join('\n\n'),input,store:false,stream:false};
}

function visionText(result) {
  if(result.status==='failed'||result.error)throw new ProviderError(result.error?.message||'The visual model request failed.');
  if(result.status==='incomplete')throw new ProviderError('The model response was incomplete. Retry the turn.');
  const content=(Array.isArray(result.output)?result.output:[]).filter(item=>item?.type==='message').flatMap(item=>Array.isArray(item.content)?item.content:[]);
  const refusal=content.find(part=>part?.type==='refusal');
  if(refusal)throw new ProviderError(`The model declined this request: ${refusal.refusal||'Refused.'}`,422,'MODEL_REFUSAL');
  const text=content.filter(part=>part?.type==='output_text'&&typeof part.text==='string').map(part=>part.text).join('');
  if(!text.trim())throw new ProviderError('The model returned no usable visual response.');
  return text;
}

function checkedResponse(result,extract) {
  try{return extract(result);}catch(error){error.response=result;throw error;}
}

export function createProvider(settings, fetchImpl = fetch) {
  const base = validateProxyUrl(settings.proxyBaseUrl);
  async function request(path, options = {}, limit = 24 * 1024 * 1024) {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(settings.requestTimeoutMs)]) : AbortSignal.timeout(settings.requestTimeoutMs);
    let response;
    try { response = await fetchImpl(base + path, {...options, signal, redirect:'error'}); }
    catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      throw new ProviderError(error.name === 'TimeoutError' || signal.aborted ? 'The subscription proxy timed out. Your story was not changed.' : 'Cannot reach openai-oauth. Start it in Termux at the configured local address.', 503, 'PROXY_OFFLINE');
    }
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > limit) throw new ProviderError('The proxy response exceeded the supported size.');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!response.ok) {
      let message;
      try { const body = JSON.parse(text); message = body.error?.message ?? body.detail ?? body.message; } catch {}
      const error=new ProviderError(typeof message === 'string' ? message.slice(0,1600) : `Subscription proxy returned HTTP ${response.status}.`, response.status === 429 ? 429 : 502, response.status === 429 ? 'USAGE_LIMIT' : 'PROXY_ERROR');
      error.response=text;throw error;
    }
    try { return JSON.parse(text); } catch { const error=new ProviderError('The proxy returned an invalid JSON response.');error.response=text;throw error; }
  }
  return {
    async models() {
      const data = await request('/models', {signal:AbortSignal.timeout(8000)}, 2 * 1024 * 1024);
      const list = data.data ?? data.models ?? [];
      return list.map(item => typeof item === 'string' ? {id:item,name:item} : {id:item.id ?? item.slug,name:item.display_name ?? item.name ?? item.id ?? item.slug}).filter(item=>item.id);
    },
    async complete({model=settings.chatModel,messages,signal}) {
      // openai-oauth's chat adapter passes data: images through an SDK URL
      // downloader. Its native Responses route preserves inline image bytes.
      if(messages.some(message=>Array.isArray(message.content)&&message.content.some(part=>part?.type==='image_url'))) {
        const result=await request('/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(visionRequest(model,messages)),signal},4*1024*1024);
        return checkedResponse(result,visionText);
      }
      const result = await request('/chat/completions', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,messages,stream:false}),signal}, 4 * 1024 * 1024);
      return checkedResponse(result,()=>{
        const choice = result.choices?.[0];
        if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new ProviderError(`The model declined this request: ${choice.message.refusal ?? 'Content filter refusal.'}`, 422, 'MODEL_REFUSAL');
        const text = choice?.message?.content;
        if (typeof text !== 'string' || !text.trim() || choice.finish_reason === 'length') throw new ProviderError(choice?.finish_reason === 'length' ? 'The model response was incomplete. Retry the turn.' : 'The model returned no usable response.');
        return text;
      });
    },
    async image({prompt,references=[],signal}) {
      const options = {model:settings.imageModel,prompt,quality:settings.imageQuality,size:settings.imageSize};
      let result;
      if (references.length) {
        const form = new FormData();
        for (const [key,value] of Object.entries(options)) form.set(key,value);
        for (const [index,reference] of references.slice(0,5).entries()) form.append('image[]',new Blob([reference.bytes],{type:reference.type ?? 'image/png'}),`reference-${index+1}.png`);
        result = await request('/images/edits',{method:'POST',body:form,signal});
      } else result = await request('/images/generations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(options),signal});
      const encoded = result.data?.[0]?.b64_json;
      if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/\s]*={0,2}$/.test(encoded) || encoded.length < 20) throw new ProviderError('The image proxy did not return a base64 image.');
      const bytes = Buffer.from(encoded,'base64');
      const isPng = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      const isJpeg = bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
      const isWebp = bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP';
      if (!isPng && !isJpeg && !isWebp) throw new ProviderError('The image proxy returned an unsupported image format.');
      return {bytes,type:isPng?'image/png':isJpeg?'image/jpeg':'image/webp',extension:isPng?'png':isJpeg?'jpg':'webp'};
    }
  };
}
