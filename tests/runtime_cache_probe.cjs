'use strict';
// Raw CDP avoids Playwright's navigation bookkeeping for a real BFCache return.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
module.exports=async function probe(base){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-cache-chrome-')),command=process.env.RUNTIME_CACHE_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const child=spawn(command,['--headless=new','--disable-background-networking','--disable-component-update','--disable-default-apps','--disable-extensions','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+directory,'about:blank'],{detached:true,stdio:'ignore'});
 let socket,identity=0;const waiting=new Map(),diagnostics=[],navigationWaiters=new Set();let launchError;child.on('error',e=>launchError=e);
 const stop=()=>new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('exit',resolve);try{process.kill(-child.pid,'SIGTERM');}catch{resolve();}setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid,'SIGKILL');}catch{}}resolve();},2000).unref();});
 try{
  const portFile=path.join(directory,'DevToolsActivePort'),deadline=Date.now()+15000;
  while(!fs.existsSync(portFile)){if(launchError)throw launchError;if(child.exitCode!==null||Date.now()>deadline)throw Error('Temporary Chrome did not expose CDP');await delay(25);}
  const [port,url]=fs.readFileSync(portFile,'utf8').trim().split('\n');socket=new WebSocket('ws://127.0.0.1:'+port+url);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',event=>{const value=JSON.parse(event.data);if(value.id){const pending=waiting.get(value.id);if(pending){waiting.delete(value.id);clearTimeout(pending.timer);value.error?pending.reject(Error(JSON.stringify(value.error))):pending.resolve(value.result);}}else if(value.method==='Page.backForwardCacheNotUsed')diagnostics.push(value.params);else if(value.method==='Page.frameNavigated'&&!value.params.frame.parentId){for(const done of navigationWaiters)done(value.params);navigationWaiters.clear();}});
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++identity,timer=setTimeout(()=>{waiting.delete(id);reject(Error('CDP timeout: '+method));},12000);waiting.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  const target=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
  const command=(method,params)=>send(method,params,sessionId),evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text+': '+result.exceptionDetails.exception?.description);return result.result.value;};
  const navigate=async(method,params)=>{const arrived=new Promise((resolve,reject)=>{const done=result=>{clearTimeout(timer);resolve(result);},timer=setTimeout(()=>{navigationWaiters.delete(done);reject(Error('Navigation did not commit'));},12000);navigationWaiters.add(done);});await command(method,params);return arrived;};
  const until=async expression=>{const deadline=Date.now()+10000;let last;while(Date.now()<deadline){try{last=await evaluate(expression);if(last)return last;}catch(e){last=e.message;}await delay(25);}throw Error('Condition timed out: '+expression+'; '+JSON.stringify({last,diagnostics}));};
  await command('Page.enable');await command('Runtime.enable');
  await command('Page.addScriptToEvaluateOnNewDocument',{source:"window.runtimeProbeToken=crypto.randomUUID();window.runtimeProbeShows=[];addEventListener('pageshow',e=>runtimeProbeShows.push(e.persisted));"});
  await navigate('Page.navigate',{url:base});await until("typeof state!=='undefined'&&state.connected&&!state.busy");await evaluate("location.hash='#/runtimes'");await until("state.view==='runtimes'&&runtimeSettingsEditor&&!runtimeSettingsEditor.busy&&!state.busy&&!Object.keys(state.modelRequests||{}).length");
  await evaluate("document.querySelector('#codex-timeout').value='81';document.querySelector('#codex-timeout').dispatchEvent(new Event('input',{bubbles:true}))");
  await evaluate("window.scrollTo({top:250,behavior:'instant'})");
  const before=await evaluate("({token:runtimeProbeToken,revision:state.runtimeConfig.settings.revision,top:window.scrollY})");assert(before.top>0);
  await navigate('Page.navigate',{url:'about:blank'});
  const history=await command('Page.getNavigationHistory');const returned=await navigate('Page.navigateToHistoryEntry',{entryId:history.entries[history.currentIndex-1].id});
  const restored=await until("typeof runtimeProbeShows!=='undefined'&&runtimeProbeShows.includes(true)&&typeof runtimeSettingsEditor!=='undefined'&&runtimeSettingsEditor&&!runtimeSettingsEditor.busy&&!state.busy&&({token:runtimeProbeToken,pageshows:runtimeProbeShows,timeout:document.querySelector('#codex-timeout').value,disabled:document.querySelector('#codex-timeout').disabled,revision:state.runtimeConfig.settings.revision})");
  assert.equal(restored.token,before.token);assert.equal(restored.timeout,'81');assert.equal(restored.disabled,false);assert.equal(restored.revision,before.revision);
  restored.scroll=await evaluate("({top:window.scrollY,memory:routePositions().get(state.routeKey),stored:storedRoutePositions().get(state.routeKey)})");for(const top of Object.values(restored.scroll))assert(Math.abs(top-before.top)<2);
  await evaluate("document.querySelector('#runtime-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");await until('state.runtimeConfig.settings.revision==='+String(before.revision+1)+'&&!runtimeSettingsEditor.busy');
  assert.equal(await evaluate('state.runtimeConfig.settings.profiles.codex.timeout'),81);
  const result={...restored,navigation_type:returned.type,saved_revision:before.revision+1,chrome:await send('Browser.getVersion'),diagnostics,method:'Independent temporary Chrome process, raw CDP navigation, identical document token and pageshow.persisted=true; synthetic HTML cache permission only.'};
  await send('Browser.close').catch(()=>{});return result;
 }finally{
  for(const request of waiting.values()){clearTimeout(request.timer);request.reject(Error('probe closed'));}waiting.clear();socket?.close();await stop();fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
};
