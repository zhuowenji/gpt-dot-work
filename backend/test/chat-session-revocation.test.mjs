import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
test('restore revocation clears owner, guest and account credentials without deleting records',t=>{
  const dir=mkdtempSync(join(tmpdir(),'chat-revoke-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'state.sqlite');let db=new DatabaseSync(path);
  for(const name of ['owner_sessions','chat_guest_sessions','chat_account_sessions','chat_account_idempotency'])db.exec(`CREATE TABLE ${name}(id TEXT); INSERT INTO ${name} VALUES ('fixture');`);
  db.exec("CREATE TABLE chat_threads(id TEXT,content TEXT);INSERT INTO chat_threads VALUES('example','retain private content');");db.close();
  const r=spawnSync(process.execPath,[fileURLToPath(new URL('../revoke-sessions.mjs',import.meta.url))],{env:{...process.env,WORKSPACE_DB_PATH:path},encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/owner, guest and account/);
  db=new DatabaseSync(path);
  for(const name of ['owner_sessions','chat_guest_sessions','chat_account_sessions','chat_account_idempotency'])assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n,0);
  assert.equal(db.prepare('SELECT content FROM chat_threads').get().content,'retain private content');db.close();
});
