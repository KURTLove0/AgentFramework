'use strict';

// Keep unresolved operations across redraws, scoped to the user and original run.
// A read can recover current state; it must never replay a resume or cancellation.
const flowControlStates=new Map();
function flowControlScope(){return {tenant:state.meta?.tenant,principal:state.meta?.principal,workspace:state.workspaceId};}
function flowControlKey(id,scope=flowControlScope()){return JSON.stringify([scope.tenant,scope.principal,scope.workspace,id]);}
function flowControlCurrent(record){return flowControlStates.get(record.key)===record&&record.key===flowControlKey(record.id)&&state.view==='workflows'&&state.selected===record.id&&state.routeVersion===record.route;}
function flowControlBlocked(id,operation='resume'){
 const record=flowControlStates.get(flowControlKey(id));
 // A stop can supersede an unresolved resume, including its read-only review.
 return Boolean(record&&['pending','reading','unknown'].includes(record.status)&&(operation!=='cancel'||record.operation==='cancel'));
}
function flowControlFeedback(id){
 const record=flowControlStates.get(flowControlKey(id));
 if(!record||state.view!=='workflows'||state.selected!==id)return '';
 const reading=record.status==='reading';
 return `<div id="flow-control-feedback" class="flow-control-feedback" tabindex="-1"><p role="${record.status==='unknown'?'alert':'status'}" aria-atomic="true">${esc(record.message)}</p>${record.status==='unknown'||reading?`<button id="flow-control-review" type="button" class="button secondary" data-review-flow-control="${esc(id)}" ${reading?'disabled aria-busy="true"':''}>${reading?'正在核对…':'核对当前运行状态'}</button>`:''}</div>`;
}
function renderFlowControl(record,focus=false){
 if(!flowControlCurrent(record))return;
 state.fingerprint='';render();
 if(focus){const box=$('#flow-control-feedback');box?.focus({preventScroll:true});box?.scrollIntoView({block:'nearest'});}
}
async function submitFlowControl(button,operation){
 if(!['resume','cancel'].includes(operation))return;
 const id=button.dataset[operation+'Flow'],detail=state.flowDetail,run=detail?.run;
 if(button.disabled||flowControlBlocked(id,operation)||state.view!=='workflows'||state.selected!==id||run?.id!==id)return;
 if(['SUCCEEDED','FAILED','NEEDS_REVIEW','CANCELLED','EXPIRED'].includes(run.status))return;
 if(operation==='resume'&&(detail.job?.active||run.lease_active||detail.queue?.state==='QUEUED'))return;
 if(operation==='cancel'&&run.cancel_requested)return;
 const label=operation==='cancel'?'取消':run.cancel_requested?'取消重试':'恢复';
 const record={...flowControlScope(),id,operation,label,route:state.routeVersion,status:'pending',message:'正在提交'+label+'请求…'};
 record.key=flowControlKey(id,record);flowControlStates.set(record.key,record);renderFlowControl(record,true);
 let receipt;
 try{
  receipt=await api('/api/workflow-runs/'+encodeURIComponent(id)+'/'+operation,{},15000,true,{workspace:record.workspace,payload:'{}'});
  if(receipt?.run?.id!==id)throw Error('返回的运行记录不匹配');
 }catch(error){
  record.status='unknown';record.message=(['TypeError','TimeoutError','SyntaxError'].includes(error.name)?'暂时无法确认'+label+'结果。':error.message+'。')+'请先核对当前运行状态；核对不会再次提交操作。';
  renderFlowControl(record);return;
 }
 record.status='accepted';record.message=label+'请求已保存，执行进度以当前运行状态为准。';
 if(!flowControlCurrent(record))return;
 const feedback=flowRememberMutation('run',receipt,record.workspace,operation==='cancel'?'取消请求已提交':'恢复请求已提交，将复用已有任务');
 if(!feedback){record.message='操作响应已返回，以当前运行状态为准。';renderFlowControl(record);return;}
 // A later catalog failure does not turn an accepted command into an unknown one.
 try{await loadFlows();}
 catch(error){if(flowControlCurrent(record)){feedback.refreshError=error.message;record.message=label+'请求已保存，当前列表暂未刷新：'+error.message+'。可稍后刷新查看进度。';}}
 renderFlowControl(record);
}
async function reviewFlowControl(id){
 const record=flowControlStates.get(flowControlKey(id));
 if(!record||record.status!=='unknown'||state.view!=='workflows'||state.selected!==id)return;
 record.route=state.routeVersion;record.status='reading';record.message='正在核对'+record.label+'请求的当前运行状态，未再次提交操作。';renderFlowControl(record,true);
 try{
  const detail=await api('/api/workflow-runs/'+encodeURIComponent(id),undefined,15000,true,{workspace:record.workspace,payload:undefined});
  if(!flowControlCurrent(record))return;
  if(detail?.run?.id!==id)throw Error('返回的运行记录不匹配');
  if(!flowReceiptOutdated('run',detail)){
   state.flowDataRevision=(state.flowDataRevision||0)+1;state.flowDetail=detail;
   if(state.flows)state.flows.runs=state.flows.runs.map(run=>run.id===id?{...detail.run,queue:detail.queue}:run);
   flowInvalidateHistory();
  }
  record.status='reviewed';record.message='已核对当前运行状态。请根据显示的进度决定下一步；本次核对未提交操作。';renderFlowControl(record);
 }catch(error){record.status='unknown';record.message=record.label+'结果仍未确认。核对未完成：'+error.message+'。保留当前显示，可稍后重试核对。';renderFlowControl(record);}
 finally{if(record.status==='reading'){record.status='unknown';record.message=record.label+'结果仍未确认。上次核对期间已离开此记录，请重新核对当前运行状态。';}}
}
document.addEventListener('click',event=>{
 for(const operation of ['resume','cancel']){
  const button=event.target.closest('[data-'+operation+'-flow]');
  if(button){event.preventDefault();return submitFlowControl(button,operation);}
 }
 const review=event.target.closest('[data-review-flow-control]');
 if(review&&!review.disabled){event.preventDefault();return reviewFlowControl(review.dataset.reviewFlowControl);}
});
