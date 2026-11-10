import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, directoryIdentity } from './src/store.mjs';
import { StoryService } from './src/story-service.mjs';
import { createProvider } from './src/provider.mjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'};
const fail=(message,status)=>Object.assign(new Error(message),{status});

async function jsonBody(request,limit=2*1024*1024) {
  if(!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw fail('Send an application/json request.',415);
  const chunks=[];let size=0;
  for await(const chunk of request) {size+=chunk.length;if(size>limit) throw fail('This request is too large.',413);chunks.push(chunk);}
  try {const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!body||typeof body!=='object'||Array.isArray(body)) throw new Error();return body;} catch {throw fail('Invalid JSON request.',400);}
}

export async function createApp({dataDir=process.env.HEARTH_DATA_DIR||path.join(ROOT,'data'),makeProvider=createProvider}={}) {
  const store=new Store(path.resolve(dataDir));await store.init();
  const instance={pid:process.pid,dataDirectoryId:await directoryIdentity(store.directory)};
  // Jobs cannot survive a stopped Termux process. Do not leave the interface
  // polling an orphaned persisted job forever after a restart.
  for(const summary of await store.list()) {
    const story=await store.get(summary.id);
    if(['queued','deciding','generating'].includes(story.illustrationJob?.status)) {
      await store.mutate(story.id,undefined,current=>{current.illustrationJob.status='failed';current.illustrationJob.error='The app stopped before this illustration finished. You can request it again.';},{bump:false});
    }
  }
  const service=new StoryService(store,{makeProvider});
  const server=http.createServer(async(request,response)=>{
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const send=(data,status=200)=>{if(response.destroyed)return;response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});response.end(JSON.stringify(data));};
    try {
      const port=server.address()?.port;
      const host=request.headers.host;
      let hostUrl;try {hostUrl=new URL(`http://${host}`);} catch {throw fail('Invalid host.',403);}
      if(!['127.0.0.1','localhost','[::1]'].includes(hostUrl.hostname)||Number(hostUrl.port||80)!==port) throw fail('Hearth accepts local requests only.',403);
      const origin=request.headers.origin;
      if(origin && origin!==`http://${host}`) throw fail('Cross-origin requests are not allowed.',403);
      const url=new URL(request.url,`http://${host}`),pathname=decodeURIComponent(url.pathname);
      const method=request.method;
      if(method==='GET'&&pathname==='/api/bootstrap') return send({settings:await store.settings(),stories:await store.list(),version:'1.1.0',instance});
      if(method==='GET'&&pathname==='/api/settings') return send(await store.settings());
      if(method==='PUT'&&pathname==='/api/settings') {
        const body=await jsonBody(request);
        try {return send(await store.saveSettings(body));}
        catch(error) {if(!error.code)error.status=400;throw error;}
      }
      if(method==='GET'&&pathname==='/api/models') {
        try {return send({connected:true,models:await makeProvider(await store.settings()).models()});}
        catch(error) {return send({connected:false,models:[],error:error.message});}
      }
      if(method==='GET'&&pathname==='/api/stories') return send(await store.list());
      if(method==='POST'&&pathname==='/api/stories') return send(await service.create(await jsonBody(request)),201);
      if(method==='POST'&&pathname==='/api/import') return send(await service.import(await jsonBody(request,64*1024*1024)),201);
      const route=/^\/api\/stories\/([a-zA-Z0-9_-]{1,100})(?:\/(turn|continue|cancel|branch|switch|illustrate|export|debug|metadata|appearance|character-prompt))?$/.exec(pathname);
      if(route) {
        const [,id,action]=route;
        if(method==='GET'&&!action) return send(await service.view(id));
        if(method==='DELETE'&&!action) return send(await service.remove(id));
        if(method==='GET'&&action==='debug') {
          const log=await service.debug(id);
          response.writeHead(200,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});response.end(log);return;
        }
        if(method==='GET'&&action==='export') {
          response.setHeader('Content-Disposition',`attachment; filename="hearth-${id}.json"`);
          return send(await service.export(id));
        }
        if(method==='POST') {
          const body=await jsonBody(request);
          if(action==='turn') return send(await service.turn(id,body.expectedVersion,body.text));
          if(action==='metadata') return send(await service.metadata(id,body));
          if(action==='continue') return send(await service.turn(id,body.expectedVersion,null));
          if(action==='cancel') return send(await service.cancel(id));
          if(action==='branch') return send(await service.branch(id,body));
          if(action==='switch') return send(await service.switch(id,body));
          if(action==='illustrate') return send(await service.illustrate(id,body));
          if(action==='appearance') return send(await service.appearance(id,body));
          if(action==='character-prompt') return send(await service.characterPrompt(id,body));
        }
      }
      if(method==='GET'&&pathname.startsWith('/images/')) {
        const filename=store.imagePath(pathname.slice('/images/'.length));
        const bytes=await readFile(filename);response.writeHead(200,{'content-type':mime[path.extname(filename)],'cache-control':'private, max-age=31536000, immutable'});response.end(bytes);return;
      }
      if(method==='GET'&&['/','/index.html','/app.js','/style.css'].includes(pathname)) {
        const filename=path.join(ROOT,'public',pathname==='/'?'index.html':pathname.slice(1));
        response.writeHead(200,{'content-type':mime[path.extname(filename)],'cache-control':'no-cache'});response.end(await readFile(filename));return;
      }
      throw fail('Not found.',404);
    } catch(error) {
      const aborted=error.name==='AbortError';
      const status=error.status??(error.code==='ENOENT'?404:aborted?409:500);
      send({error:aborted?'Generation stopped. No incomplete turn was saved.':error.message||'An unexpected error occurred.',...(error.code?{code:error.code}:{}),...(error.storyId?{storyId:error.storyId}:{})},status);
    }
  });
  server.requestTimeout=0;
  server.headersTimeout=15000;
  server.keepAliveTimeout=5000;
  return {server,store,service,async close(){for(const id of service.busy.keys()) await service.cancel(id);for(const id of service.illustrator.jobs.keys()) await service.illustrator.cancel(id);await new Promise(resolve=>server.close(resolve));}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const port=Number(process.env.PORT||8000);
  if(!Number.isInteger(port)||port<1||port>65535) throw new Error('PORT must be an integer between 1 and 65535.');
  const app=await createApp();
  app.server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is already in use. Use PORT=8001 npm start, or stop the other app.`:error.message);process.exitCode=1;});
  app.server.listen(port,'127.0.0.1',()=>console.log(`Hearth is ready at http://127.0.0.1:${port}\nStories are saved in ${app.store.directory}\nStart openai-oauth separately, then check the connection in Settings.`));
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{void app.close().then(()=>process.exit(0));});
}
