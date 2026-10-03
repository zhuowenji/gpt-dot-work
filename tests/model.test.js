import test from 'node:test';
import assert from 'node:assert/strict';
import {freshState,searchNotes,projectProgress,isValidState} from '../src/model.js';
test('seed is valid; fresh copies do not mutate seed',()=>{let a=freshState();assert.ok(isValidState(a));a.notes[0].title='changed';assert.notEqual(freshState().notes[0].title,'changed');});
test('knowledge search covers title, content and tags',()=>{const s=freshState();assert.equal(searchNotes(s.notes,'知识库').length,1);assert.equal(searchNotes(s.notes,'核心想法').length,1);assert.equal(searchNotes(s.notes,'慢下来').length,1);assert.equal(searchNotes(s.notes,'不存在').length,0);assert.equal(searchNotes(s.notes,' ').length,3);});
test('progress follows actual completion',()=>{let s=freshState();assert.equal(projectProgress(s,'p1'),50);s.tasks[0].status='已完成';assert.equal(projectProgress(s,'p1'),100);assert.equal(projectProgress(s,'missing'),0);});
test('invalid persisted data is rejected',()=>{assert.equal(isValidState(null),false);let s=freshState();s.notes[0].tags=null;assert.equal(isValidState(s),false);});
test('persisted state rejects malformed dates, identifiers, and requests',()=>{let s=freshState();s.notes[0].updated=12;assert.equal(isValidState(s),false);s=freshState();s.projects[0].id='bad" onclick="';assert.equal(isValidState(s),false);s=freshState();s.requests=[{id:'r1',title:'Demo',body:'No operation',status:'blocked',updated:'2026-10-03'}];assert.ok(isValidState(s));s.requests[0].status='unknown';assert.equal(isValidState(s),false);});
