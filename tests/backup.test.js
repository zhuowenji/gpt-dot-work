import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBackup } from '../scripts/backup.mjs';
test('consistent backup captures WAL writes, is private, and does not overwrite', async()=>{
  const root=await mkdtemp(join(tmpdir(),'gpt-backup-test-'));
  try {
    const source=join(root,'source.sqlite'),dest=join(root,'snapshot.sqlite');
    const db=new DatabaseSync(source);db.exec('PRAGMA journal_mode=WAL; CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES (\'fictional\')');
    const result=await createBackup(source,dest);
    assert.equal(result.sha256.length,64);assert.equal((await stat(dest)).mode&0o777,0o600);
    const copy=new DatabaseSync(dest,{readOnly:true});assert.equal(copy.prepare('SELECT body FROM notes').get().body,'fictional');copy.close();
    const before=await readFile(dest);await assert.rejects(createBackup(source,dest),{code:'EEXIST'});assert.deepEqual(await readFile(dest),before);db.close();
  } finally {await rm(root,{recursive:true,force:true});}
});
test('backup refuses relative paths and non-private destination directory',async()=>{
  await assert.rejects(createBackup('source.sqlite','target.sqlite'),/absolute/);
  const root=await mkdtemp(join(tmpdir(),'gpt-backup-test-'));
  try {
    const source=join(root,'source.sqlite');const db=new DatabaseSync(source);db.exec('CREATE TABLE example(id INTEGER)');db.close();
    const shared=join(root,'shared');await mkdir(shared);await chmod(shared,0o755);
    await assert.rejects(createBackup(source,join(shared,'backup.sqlite')),/mode 0700/);
  }finally{await rm(root,{recursive:true,force:true});}
});
