'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test');
const {waitFor}=require('./browser_poll.cjs');

test('an async false value is polled again until the condition actually becomes true',async()=>{
 let attempts=0;await waitFor(async()=>++attempts===3,'not ready',{intervalMs:0});assert.equal(attempts,3);
});
test('a pending promise does not satisfy the condition just by existing',async()=>{
 let release,finished=false;const gate=new Promise(resolve=>release=resolve);
 const pending=waitFor(()=>gate).then(()=>finished=true);
 await new Promise(resolve=>setImmediate(resolve));assert(!finished);release(true);await pending;assert(finished);
});
test('a false condition times out with its diagnostic rather than passing',async()=>{
 await assert.rejects(waitFor(async()=>false,'Task did not finish',{timeoutMs:0}),/Task did not finish/);
});
test('a failed API read propagates without being treated as a successful condition',async()=>{
 const error=Error('read failed');let attempts=0;
 await assert.rejects(waitFor(async()=>{attempts++;throw error;}),e=>e===error);assert.equal(attempts,1);
});
test('a successful checked value is returned to the caller',async()=>{
 const value={status:'SUCCEEDED'};assert.equal(await waitFor(async()=>value),value);
});
