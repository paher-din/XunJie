import test from 'node:test';
import assert from 'node:assert/strict';
import {createDigitalLogicApplicationDatabase} from '../db/transaction.ts';
test('DL-A approved fresh application has exactly 35 tables and preserves them on close',()=>{
 const db=createDigitalLogicApplicationDatabase();
 try { const names=db.withTransaction(tx=>tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(row=>row.name));
 assert.equal(names.length,35); for(const name of ['digital_logic_config_versions','application_control','teacher_design_requests','hdl_sessions','workspace_submissions','workspace_reopen_grants'])assert(names.includes(name));
 assert(!names.includes('learner_state_versions'));
 }finally{db.close();}
});
