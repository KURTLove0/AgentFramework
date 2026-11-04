'use strict';
const flowGrantStates=new Map();
function flowGrantScope(){return {tenant:state.meta?.tenant,principal:state.meta?.principal,workspace:state.workspaceId};}
function flowGrantKey(id,node,scope=flowGrantScope()){return JSON.stringify([scope.tenant,scope.principal,scope.workspace,id,node]);}
function flowGrantCurrent(record){return flowGrantStates.get(record.key)===record&&record.key===flowGrantKey(record.id,record.node)&&state.view==='workflows'&&state.selected===record.id&&state.routeVersion===record.route;}
function flowGrantBlocked(id,node){const record=flowGrantStates.get(flowGrantKey(id,node));return Boolean(record&&['pending','reading','unknown'].includes(record.status));}
function flowGrantFeedback(id,node){
 const record=flowGrantStates.get(flowGrantKey(id,node));if(!record)return '';
 const busy=['pending','reading'].includes(record.status);
 return `<div id="flow-grant-feedback-${esc(node)}" class="flow-grant-feedback" tabindex="-1"><p role="${record.status==='unknown'?'alert':'status'}">${esc(record.message)}</p>${record.status==='unknown'||record.status==='reading'?`<button type="button" class="button secondary" data-review-flow-grant="${esc(id)}" data-node="${esc(node)}" ${busy?'disabled':''}>${busy?'正在核对…':'核对当前提案与运行'}</button>`:''}</div>`;
}
function renderFlowGrant(record,focus=false){
 if(!flowGrantCurrent(record))return;state.fingerprint='';render();
 if(focus){const box=$('#flow-grant-feedback-'+record.node);box?.focus({preventScroll:true});box?.scrollIntoView({block:'nearest'});}
}
async function submitFlowGrant(button){
 const id=button.dataset.grantFlow,node=button.dataset.node,token=button.dataset.proposalToken;
 if(button.disabled||flowGrantBlocked(id,node)||flowControlBlocked(id,'grant')||state.view!=='workflows'||state.selected!==id||state.flowDetail?.run?.id!==id)return;
 const record={...flowGrantScope(),id,node,token,route:state.routeVersion,status:'pending',message:'正在提交已审查的具体提案…'};record.key=flowGrantKey(id,node,record);flowGrantStates.set(record.key,record);
 if(!/^[0-9a-f]{64}$/.test(token||'')){record.status='unknown';record.message='缺少当前提案信息，请先核对运行详情，再审查授权。';renderFlowGrant(record,true);return;}
 renderFlowGrant(record);
 try{
  const payload={node_id:node,proposal_token:token};
  const detail=await api('/api/workflow-runs/'+encodeURIComponent(id)+'/grant',payload,15000,true,{workspace:record.workspace,payload:JSON.stringify(payload)});
  if(detail?.run?.id!==id)throw Error('返回的运行记录不匹配，请核对当前状态。');
  record.status='accepted';record.message='授权请求已保存，执行进度以当前运行状态为准。';
  if(!flowGrantCurrent(record))return;
  const feedback=flowRememberMutation('run',detail,record.workspace,'已授权此提案，继续执行');
  if(!feedback){record.message='操作响应已返回，以当前运行状态为准。';renderFlowGrant(record);return;}
  await flowRefreshAfterMutation(feedback);
 }catch(error){
  record.status='unknown';record.message=(['TypeError','TimeoutError','SyntaxError'].includes(error.name)?'暂时无法确认授权结果。':error.message+'。')+'请先核对当前提案与运行；核对不会再次授权。';renderFlowGrant(record,true);
 }
}
async function reviewFlowGrant(id,node){
 const key=flowGrantKey(id,node),record=flowGrantStates.get(key);
 if(!record||['pending','reading'].includes(record.status)||state.view!=='workflows'||state.selected!==id)return;
 record.route=state.routeVersion;record.status='reading';record.message='正在读取当前提案与运行状态，未提交授权。';renderFlowGrant(record);
 try{
  const detail=await api('/api/workflow-runs/'+encodeURIComponent(id),undefined,15000,true,{workspace:record.workspace,payload:undefined});
  if(!flowGrantCurrent(record))return;
  if(detail?.run?.id!==id)throw Error('返回的运行记录不匹配');
  if(!flowReceiptOutdated('run',detail)){
   state.flowDataRevision=(state.flowDataRevision||0)+1;state.flowDetail=detail;
   if(state.flows)state.flows.runs=state.flows.runs.map(run=>run.id===id?{...detail.run,queue:detail.queue}:run);
   flowInvalidateHistory();
  }
  record.status='reviewed';record.message='已核对当前状态。若仍待授权，请重新审查显示的提案后再确认。';renderFlowGrant(record,true);
 }catch(error){record.status='unknown';record.message='核对未完成：'+error.message+'。保留当前显示，可稍后重试核对。';renderFlowGrant(record,true);}
 finally{if(record.status==='reading'){record.status='unknown';record.message='上次核对期间已离开此记录，请重新核对当前状态。';}}
}
document.addEventListener('click',async event=>{
 const grant=event.target.closest('[data-grant-flow]');if(grant){event.preventDefault();return submitFlowGrant(grant);}
 const review=event.target.closest('[data-review-flow-grant]');if(review&&!review.disabled){event.preventDefault();return reviewFlowGrant(review.dataset.reviewFlowGrant,review.dataset.node);}
});
