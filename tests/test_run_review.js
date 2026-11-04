'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{test}=require('node:test');
function fixture(){
 const handlers={},copied=[],esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const context=vm.createContext({state:{},document:{activeElement:null,addEventListener:(name,fn)=>handlers[name]=fn},navigator:{clipboard:{writeText:async text=>copied.push(text)}},esc,icon:()=>'',checks:{'draft-readback':'草稿回读'}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../agent_framework/webui/run_view.js'),'utf8'),context);return {context,handlers,copied};
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
function copyFixture(f){
 const details={open:false},status={textContent:''},text={value:'原记录的核对摘要\n版本：7',closest:()=>details,focus(){f.context.document.activeElement=text;},select(){this.selected=true;}},panel={querySelector:s=>s==='[data-run-review-text]'?text:status};
 const button={disabled:false,isConnected:true,closest:()=>panel};f.context.document.activeElement=button;return {button,text,status,details};
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
