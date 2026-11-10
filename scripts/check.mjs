import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

async function files(directory) {
  const result=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    if(['.git','data','node_modules'].includes(entry.name))continue;
    const name=path.join(directory,entry.name);
    if(entry.isDirectory())result.push(...await files(name));else if(/\.(mjs|js)$/.test(name))result.push(name);
  }
  return result;
}
for(const filename of await files('.')) {
  const result=spawnSync(process.execPath,['--check',filename],{encoding:'utf8'});
  if(result.status!==0){process.stderr.write(result.stderr);process.exit(1);}
}
console.log('All JavaScript syntax checks passed.');
