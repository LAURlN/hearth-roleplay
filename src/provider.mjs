import { validateProxyUrl } from './settings.mjs';

export class ProviderError extends Error {
  constructor(message, status = 502, code = 'PROXY_ERROR') { super(message); this.status = status; this.code = code; }
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
      throw new ProviderError(typeof message === 'string' ? message.slice(0,1600) : `Subscription proxy returned HTTP ${response.status}.`, response.status === 429 ? 429 : 502, response.status === 429 ? 'USAGE_LIMIT' : 'PROXY_ERROR');
    }
    try { return JSON.parse(text); } catch { throw new ProviderError('The proxy returned an invalid JSON response.'); }
  }
  return {
    async models() {
      const data = await request('/models', {signal:AbortSignal.timeout(8000)}, 2 * 1024 * 1024);
      const list = data.data ?? data.models ?? [];
      return list.map(item => typeof item === 'string' ? {id:item,name:item} : {id:item.id ?? item.slug,name:item.display_name ?? item.name ?? item.id ?? item.slug}).filter(item=>item.id);
    },
    async complete({model=settings.chatModel,messages,signal}) {
      const result = await request('/chat/completions', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,messages,stream:false}),signal}, 4 * 1024 * 1024);
      const choice = result.choices?.[0];
      if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new ProviderError(`The model declined this request: ${choice.message.refusal ?? 'Content filter refusal.'}`, 422, 'MODEL_REFUSAL');
      const text = choice?.message?.content;
      if (typeof text !== 'string' || !text.trim() || choice.finish_reason === 'length') throw new ProviderError(choice?.finish_reason === 'length' ? 'The model response was incomplete. Retry the turn.' : 'The model returned no usable response.');
      return text;
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
