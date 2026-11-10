import { mkdir, readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings.mjs';

export const makeId = () => randomUUID();
export const clone = value => structuredClone(value);
export const branchWorld = branch => clone(branch.messages.at(-1)?.snapshot ?? branch.initialState);
export const assertId = id => { if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw Object.assign(new Error('Invalid identifier.'),{status:400}); return id; };

export class Store {
  constructor(directory) { this.directory = directory; this.locks = new Map(); }
  async init() { await mkdir(path.join(this.directory,'stories'),{recursive:true}); await mkdir(path.join(this.directory,'images'),{recursive:true}); }
  async atomic(filename, value) {
    const temp = `${filename}.${makeId()}.tmp`;
    try { await writeFile(temp,typeof value==='string'?value:JSON.stringify(value),{mode:0o600,flush:true}); await rename(temp,filename); }
    finally { await unlink(temp).catch(()=>{}); }
  }
  async settings() {
    try { return normalizeSettings(JSON.parse(await readFile(path.join(this.directory,'settings.json'),'utf8'))); }
    catch (error) { if (error.code==='ENOENT') return {...DEFAULT_SETTINGS}; throw error; }
  }
  async saveSettings(input) {
    return this.exclusive('settings',async()=>{ const result=normalizeSettings(input,await this.settings()); await this.atomic(path.join(this.directory,'settings.json'),result); return result; });
  }
  async exclusive(key, operation) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release; const current = new Promise(resolve=>{release=resolve;});
    this.locks.set(key,current);
    await previous.catch(()=>{});
    try { return await operation(); } finally { release(); if(this.locks.get(key)===current) this.locks.delete(key); }
  }
  filename(id) { return path.join(this.directory,'stories',assertId(id)+'.json'); }
  async get(id) {
    try { return JSON.parse(await readFile(this.filename(id),'utf8')); }
    catch(error) { if(error.code==='ENOENT') throw Object.assign(new Error('Story not found.'),{status:404}); throw error; }
  }
  async put(story) { await this.atomic(this.filename(story.id),story); return story; }
  async mutate(id, expectedVersion, operation, {bump=true}={}) {
    return this.exclusive(id,async()=>{
      const story=await this.get(id);
      if(expectedVersion!==undefined && expectedVersion!==story.version) throw Object.assign(new Error('This story changed. Refresh it before trying again.'),{status:409,code:'STALE_STORY'});
      const result=await operation(story);
      if (bump) story.version++;
      story.updatedAt=new Date().toISOString(); await this.put(story); return result ?? story;
    });
  }
  async list() {
    const names=await readdir(path.join(this.directory,'stories'));
    const results=await Promise.all(names.filter(x=>x.endsWith('.json')).map(async name=>{
      try { const s=await this.get(name.slice(0,-5)); return {id:s.id,title:s.title,updatedAt:s.updatedAt,messageCount:s.branches[s.activeBranchId].messages.length,branchCount:Object.keys(s.branches).length}; }
      catch { return null; }
    }));
    return results.filter(Boolean).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  }
  async remove(id) { await this.exclusive(id,()=>unlink(this.filename(id))); }
  imagePath(name) { if(!/^[a-zA-Z0-9_-]+\.(png|jpg|webp)$/.test(name)) throw Object.assign(new Error('Invalid image path.'),{status:400}); return path.join(this.directory,'images',name); }
  async saveImage(bytes, extension='png') { const name=`${makeId()}.${extension}`; await writeFile(this.imagePath(name),bytes,{mode:0o600}); return `/images/${name}`; }
  async image(url) { return readFile(this.imagePath(String(url).split('/').at(-1))); }
}

export function publicStory(story,busy={}) {
  const branch=story.branches[story.activeBranchId];
  return {id:story.id,title:story.title,setup:story.setup,createdAt:story.createdAt,updatedAt:story.updatedAt,version:story.version,activeBranchId:story.activeBranchId,branches:Object.values(story.branches).map(b=>({id:b.id,name:b.name,parentId:b.parentId,forkMessageId:b.forkMessageId,messageCount:b.messages.length,createdAt:b.createdAt})),branch:{id:branch.id,name:branch.name,messages:branch.messages.map(({snapshot,...message})=>message),illustrations:branch.illustrations},world:branchWorld(branch),busy:Boolean(busy.controller),stage:busy.stage??'',illustrationJob:story.illustrationJob};
}
