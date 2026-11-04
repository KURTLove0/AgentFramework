'use strict';
const {setTimeout:delay}=require('node:timers/promises');

// API checks return promises. Await the boolean result on every attempt rather
// than passing a promise-valued predicate to browser animation-frame polling.
async function waitFor(check,message='Condition did not become true',{timeoutMs=30000,intervalMs=100}={}){
 const deadline=performance.now()+timeoutMs;
 for(;;){
  const result=await check();if(result)return result;
  const remaining=deadline-performance.now();if(remaining<=0)throw Error(message);
  await delay(Math.min(intervalMs,remaining));
 }
}
module.exports={waitFor};
