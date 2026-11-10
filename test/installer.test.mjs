import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp,mkdir,copyFile,writeFile,readFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash';
function run(command,args,options={}) {const result=spawnSync(command,args,{encoding:'utf8',windowsHide:true,...options});if(result.error)throw result.error;assert.equal(result.status,0,result.stdout+'\n'+result.stderr);return result;}
test('installer clones, creates a working command, updates without touching saves, and protects other checkouts',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'hearth-install-'));
  try {
    const source=path.join(directory,'source'),checkout=path.join(directory,'installed'),bin=path.join(directory,'bin');
    await mkdir(path.join(source,'scripts'),{recursive:true});
    await copyFile(path.join(root,'scripts','termux-start.sh'),path.join(source,'scripts','termux-start.sh'));
    await copyFile(path.join(root,'.gitattributes'),path.join(source,'.gitattributes'));
    await writeFile(path.join(source,'.gitignore'),'data/\n');
    await writeFile(path.join(source,'scripts','launch.mjs'),'console.log("fixture Hearth launcher", process.argv.slice(2).join(" "));\n');
    run('git',['init','-b','main',source]);run('git',['-C',source,'add','.']);run('git',['-C',source,'-c','user.name=Hearth test','-c','user.email=test@example.invalid','commit','-m','Fixture']);
    const env={...process.env,HEARTH_REPO_URL:source.replaceAll('\\','/'),HEARTH_DIR:checkout.replaceAll('\\','/'),HEARTH_BIN_DIR:bin.replaceAll('\\','/'),HEARTH_NO_START:'1'};
    run(bash,[path.join(root,'install.sh')],{env});
    const wrapper=await readFile(path.join(bin,'hearth'),'utf8');assert.match(wrapper,/# Hearth launcher/);
    assert.match(run(bash,[path.join(bin,'hearth'),'--help'],{env}).stdout,/fixture Hearth launcher --help/);
    await mkdir(path.join(checkout,'data'));await writeFile(path.join(checkout,'data','story.json'),'keep my story');
    await writeFile(path.join(source,'version.txt'),'updated');run('git',['-C',source,'add','version.txt']);run('git',['-C',source,'-c','user.name=Hearth test','-c','user.email=test@example.invalid','commit','-m','Update fixture']);
    run(bash,[path.join(root,'install.sh')],{env});assert.equal(await readFile(path.join(checkout,'version.txt'),'utf8'),'updated');assert.equal(await readFile(path.join(checkout,'data','story.json'),'utf8'),'keep my story');
    const foreign=spawnSync(bash,[path.join(root,'install.sh')],{env:{...env,HEARTH_REPO_URL:'https://example.invalid/unrelated.git'},encoding:'utf8',windowsHide:true});assert.notEqual(foreign.status,0);assert.match(foreign.stderr,/another repository/);assert.equal(await readFile(path.join(checkout,'data','story.json'),'utf8'),'keep my story');
    const otherBin=path.join(directory,'other-bin');await mkdir(otherBin);await writeFile(path.join(otherBin,'hearth'),'an unrelated command');
    const collision=spawnSync(bash,[path.join(root,'install.sh')],{env:{...env,HEARTH_BIN_DIR:otherBin.replaceAll('\\','/')},encoding:'utf8',windowsHide:true});assert.notEqual(collision.status,0);assert.match(collision.stderr,/unrelated command/);assert.equal(await readFile(path.join(otherBin,'hearth'),'utf8'),'an unrelated command');
  } finally {if(path.dirname(directory)!==os.tmpdir())throw new Error('Unexpected test directory');await rm(directory,{recursive:true,force:true});}
});
