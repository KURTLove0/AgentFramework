'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{test}=require('node:test');
function fixture(){
 const handlers={},copied=[],esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const panels=[],timers=new Map();let timer=0;const context=vm.createContext({state:{},document:{activeElement:null,querySelectorAll:()=>panels.filter(p=>p.button.isConnected),addEventListener:(name,fn)=>handlers[name]=fn},setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id),navigator:{clipboard:{writeText:async text=>copied.push(text)}},esc,icon:()=>'',checks:{'draft-readback':'草稿回读'}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../agent_framework/webui/run_view.js'),'utf8'),context);return {context,handlers,copied,panels,timers};
}
function detail(){return {run:{run_id:'run-review',version:7,status:'NEEDS_REVIEW',last_error:'无法确认写入结果',tenant_id:'tenant-a',task:{project_id:'project-a',principal:'person-a',acceptance:['draft-readback','not-yet-checked']},snapshot:{},checks:{'draft-readback':{passed:false,detail:'草稿正文与预期不符',evidence_refs:['evidence-read']}},actions:[{logical_id:'write-a',tool_ref:'report.draft.create@1.0.0',status:'UNKNOWN',args:{project_id:'project-a',idempotency_key:'run-review:report:1',private_payload:'NOT_IN_SUMMARY'},attempts:1,reconcile_attempts:3},{logical_id:'read-ok',tool_ref:'change.read@1.0.0',status:'VERIFIED',args:{}}]}};}
test('review summary exposes exact operation identity and distinguishes failed from pending checks',()=>{
 const f=fixture(),d=detail(),before=JSON.stringify(d),html=f.context.renderRunReview(d),text=f.context.runReviewText(d);
 for(const value of ['run-review:report:1','project-a','write-a','UNKNOWN','草稿正文与预期不符','evidence-read']){assert(html.includes(value));assert(text.includes(value));}
 assert.match(html,/尚未检查/);assert.match(html,/未通过/);assert(!text.includes('read-ok'));assert(!text.includes('NOT_IN_SUMMARY'));assert.equal(JSON.stringify(d),before);
});
test('recorded receipts remain separate from confirmed outcomes and arbitrary text stays escaped',()=>{
 const f=fixture(),d=detail();d.run.actions[0]={...d.run.actions[0],status:'OBSERVED',result:{id:'draft-<unsafe>',version:2}};d.run.last_error='认知调用失败：task_deadline';
 const html=f.context.renderRunReview(d);assert.match(html,/已收到回执，尚待核验/);assert.match(html,/draft-&lt;unsafe&gt;/);assert(!html.includes('draft-<unsafe>'));assert(!html.includes('重新提交'));assert(!html.includes('data-action="resume"'));
});
test('review without tool effects explains checks and does not invent an external write',()=>{
 const f=fixture(),d=detail();d.run.actions=[];const html=f.context.renderRunReview(d);
 assert.match(html,/核对未通过或尚未完成的检查项/);assert(!html.includes('幂等键'));assert(!html.includes('外部写入'));
 d.run.status='SUCCEEDED';assert.equal(f.context.renderRunReview(d),'');
});
test('multiple operations keep distinct keys and saved receipt fields without exposing full arguments',()=>{
 const f=fixture(),d=detail();d.run.actions.push({...d.run.actions[0],logical_id:'write-b',args:{idempotency_key:'another-key'},status:'OBSERVED',result:{id:'draft-b',version:4,private_payload:'NOT_IN_SUMMARY'}});
 const text=f.context.runReviewText(d);for(const value of ['write-a','write-b','another-key','draft-b','回执版本：4','记录版本：7'])assert(text.includes(value));assert(!text.includes('NOT_IN_SUMMARY'));
});
test('the summary textarea cannot inject markup and successful checks are omitted',()=>{
 const f=fixture(),d=detail();d.run.actions[0].args.idempotency_key='</textarea><img src=x onerror=alert(1)>';d.run.checks['not-yet-checked']={passed:true,detail:'already checked'};
 const html=f.context.renderRunReview(d);assert(html.includes('&lt;/textarea&gt;'));assert(!html.includes('<img'));assert(!html.includes('already checked'));assert(!html.includes('尚未检查'));
});
function copyFixture(f,d=detail()){
 const record=f.context.runReviewCopyState(d),details={open:false},status={textContent:''},text={value:record.text,style:{height:''},selectionStart:0,selectionEnd:0,selectionDirection:'none',scrollTop:0,scrollLeft:0,closest:()=>details,focus(){f.context.document.activeElement=text;},select(){this.selected=true;this.selectionStart=0;this.selectionEnd=this.value.length;},setSelectionRange(start,end,direction){Object.assign(this,{selectionStart:start,selectionEnd:end,selectionDirection:direction});}},panel={dataset:{reviewScope:record.scope},querySelector:s=>s==='[data-run-review-text]'?text:s==='[data-run-review-copy]'?button:status};
 const button={disabled:false,isConnected:true,attributes:{},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];},closest:()=>panel};panel.button=button;f.panels.push(panel);f.context.document.activeElement=button;return {button,text,status,details,panel,record};
}
test('copy uses exactly the displayed snapshot and reports completion',async()=>{
 const f=fixture(),ui=copyFixture(f);await f.context.copyRunReview(ui.button);assert.deepEqual(f.copied,[ui.text.value]);assert.equal(ui.status.textContent,'核对摘要已复制。');assert.equal(ui.button.disabled,false);assert.equal(ui.details.open,false);
});
test('clipboard denial offers selected plain text without another request',async()=>{
 const f=fixture(),ui=copyFixture(f);f.context.navigator.clipboard.writeText=async()=>{throw Error('denied');};await f.context.copyRunReview(ui.button);
 assert(ui.details.open&&ui.text.selected);assert.match(ui.status.textContent,/复制不可用/);assert.equal(ui.button.disabled,false);
});
test('late clipboard failure cannot steal focus or mutate a closed inspector',async()=>{
 for(const removed of [true,false]){
  const f=fixture(),ui=copyFixture(f);let reject;f.context.navigator.clipboard.writeText=()=>new Promise((a,b)=>reject=b);
  const pending=f.context.copyRunReview(ui.button);const elsewhere={};f.context.document.activeElement=elsewhere;ui.button.isConnected=!removed;reject(Error('denied'));await pending;
  assert.equal(f.context.document.activeElement,elsewhere);assert(!ui.text.selected);if(removed){assert.equal(ui.details.open,false);assert(!ui.status.textContent.includes('复制不可用'));}
 }
});
test('copy survives an unchanged redraw and repeated activation uses one clipboard request',async()=>{
 const f=fixture(),first=copyFixture(f);let finish,count=0;f.context.navigator.clipboard.writeText=()=>{count++;return new Promise(resolve=>finish=resolve);};const pending=f.context.copyRunReview(first.button);assert.equal(first.button.disabled,false);assert.equal(first.button.attributes['aria-busy'],'true');first.button.isConnected=false;const next=copyFixture(f);f.context.syncRunReviewCopies();assert.equal(next.button.attributes['aria-busy'],'true');await f.context.copyRunReview(next.button);assert.equal(count,1);finish();await pending;assert.equal(next.status.textContent,'核对摘要已复制。');assert(!next.button.attributes['aria-busy']);
});
test('a changed summary owns new feedback and a prior completion cannot update it',async()=>{
 const f=fixture(),first=copyFixture(f);let finish;f.context.navigator.clipboard.writeText=()=>new Promise(resolve=>finish=resolve);const pending=f.context.copyRunReview(first.button);first.button.isConnected=false;const changed=detail();changed.run.version++;const next=copyFixture(f,changed);finish();await pending;assert.equal(next.status.textContent,'');assert.equal(next.record.pending,false);assert.notEqual(first.text.value,next.text.value);
});
test('late copy failure cannot cross route, workspace, identity or inspector sessions',async()=>{
 for(const mode of ['routeVersion','workspaceId','principal','inspector']){
  const f=fixture();if(mode==='inspector'){f.context.runInspector={identity:'run-review',open:true};f.context.runInspectorCurrent=r=>r===f.context.runInspector&&r.open;}const first=copyFixture(f);let reject;f.context.navigator.clipboard.writeText=()=>new Promise((_r,no)=>reject=no);const pending=f.context.copyRunReview(first.button);
  if(mode==='principal')f.context.state.meta={principal:'new'};else if(mode==='inspector')f.context.runInspector={identity:'run-review',open:true};else f.context.state[mode]='new';first.button.isConnected=false;const next=copyFixture(f);reject(Error('old'));await pending;assert.equal(next.status.textContent,'');assert.equal(next.details.open,false);assert.equal(f.context.document.activeElement,next.button);
 }
});
test('slow clipboard exposes manual selection without stealing focus or adding a request',async()=>{
 const f=fixture(),ui=copyFixture(f);let finish,count=0;f.context.navigator.clipboard.writeText=()=>{count++;return new Promise(resolve=>finish=resolve);};const pending=f.context.copyRunReview(ui.button),other={};f.context.document.activeElement=other;for(const timer of f.timers.values())timer();assert(ui.details.open);assert.match(ui.status.textContent,/尚未确认/);assert.equal(f.context.document.activeElement,other);f.context.selectRunReviewText(ui.button);assert(ui.text.selected);finish();await pending;assert.equal(count,1);assert.equal(f.context.document.activeElement,ui.text);assert.equal(f.timers.size,0);
});
test('reading restores selection and scroll only for unchanged summary text',()=>{
 const f=fixture(),ui=copyFixture(f);ui.details.open=true;Object.assign(ui.text,{selectionStart:10,selectionEnd:30,selectionDirection:'backward',scrollTop:70,scrollLeft:3});ui.text.style.height='220px';const reading=f.context.captureRunReviewReading(f.context.document);ui.button.isConnected=false;const next=copyFixture(f);f.context.restoreRunReviewReading(f.context.document,reading);assert.equal(next.text.selectionDirection,'backward');assert.equal(next.text.scrollTop,70);assert.equal(next.text.style.height,'220px');assert(next.details.open);next.text.value='changed';next.text.scrollTop=0;next.text.selectionEnd=0;f.context.restoreRunReviewReading(f.context.document,reading);assert.equal(next.text.scrollTop,0);assert.equal(next.text.selectionEnd,0);
});
test('document departure clears pending feedback and fences its late completion while preserving usable controls',async()=>{
 const f=fixture(),ui=copyFixture(f);let finish;f.context.navigator.clipboard.writeText=()=>new Promise(resolve=>finish=resolve);const pending=f.context.copyRunReview(ui.button);f.context.resetRunReviewCopies();assert(!ui.button.attributes['aria-busy']);assert.equal(ui.status.textContent,'');finish();await pending;assert.equal(ui.status.textContent,'');f.context.navigator.clipboard.writeText=async text=>f.copied.push(text);await f.context.copyRunReview(ui.button);assert.deepEqual(f.copied,[ui.text.value]);assert.equal(ui.status.textContent,'核对摘要已复制。');
});
