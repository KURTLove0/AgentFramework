'use strict';
const roleLabels={
 'report-evidence@1.0.0':['报告事实与证据','章节完整，关键事实绑定可信工具证据。'],
 'release-review-rubric@1.0.0':['变更风险与草稿验收','按测试和依赖判定风险，创建后独立回读草稿。'],
 'knowledge-source-evidence@1.0.0':['知识来源与引用','回答逐字引用原文；检查来源范围、发布状态、版本与有效期。']
};
const checkLabels={'report-sections':'报告章节与风险规则','critical-claims-evidence':'关键事实与证据引用','draft-readback':'草稿独立回读','answer-grounded':'回答与原文一致','answer-scope':'来源属于任务范围','answer-current':'来源当前有效'};
const deliverableLabels={'release-report@1.0.0':'变更评估报告','release-draft@1.0.0':'可核对的评估草稿','knowledge-answer@1.0.0':'带原文引用的知识回答'};
async function initRoleEditor(definition){
 if(!state.roleCatalog){const [standards,domains,caps]=await Promise.all([api('/api/standards'),api('/api/domain-packs'),api('/api/capabilities')]);state.roleCatalog={standards:standards.standards,domains:domains.domain_packs,caps:caps.capabilities};}
 state.roleDefinition=structuredClone(definition);$('#agent-role').value=definition.identity.role;renderAgentDomainOptions();
 $('#agent-duties').innerHTML=definition.responsibilities.map(dutyRow).join('');
 // Registry verifier lists are the authority for each selectable standard.
 const allowed=state.roleCatalog.standards.filter(s=>s.verifier_refs.some(c=>roleChecks().includes(c)));
 $('#agent-standards').innerHTML=allowed.map(s=>`<label class="standard-choice"><input type="checkbox" data-standard-ref="${esc(s.ref)}" ${definition.standard_refs.includes(s.ref)?'checked':''}><span><strong>${esc(roleLabels[s.ref]?.[0]||s.ref)}</strong><small>${esc(roleLabels[s.ref]?.[1]||'按登记的验证器执行。')}</small><code>${esc(s.ref)}</code><small>验收：${s.verifier_refs.map(c=>esc(checkLabels[c]||c)).join('、')}</small></span></label>`).join('');
 $('#agent-native-reads').innerHTML='<h4>模型原生只读 MCP</h4><p class="role-section-note">仅选择此岗位需要的读取能力；任务执行时仍会检查范围并保留证据。</p>'+state.roleCatalog.caps.filter(c=>c.effect==='READ'&&definition.capability_refs.includes(c.ref)).map(c=>`<label class="check-label"><input type="checkbox" data-native-ref="${esc(c.ref)}" ${definition.native_read_refs.includes(c.ref)?'checked':''}><span>${esc(c.ref)}<small>通过任务作用域代理读取，计入预算并保存证据。</small></span></label>`).join('');
 $('#agent-adapter').value='';$('#agent-adapter').disabled=definition.domain_pack_ref==='knowledge-answer@1.0.0';updateRolePreview();
}
function roleDomain(){return state.roleCatalog.domains.find(d=>d.ref===state.roleDefinition.domain_pack_ref);}
function roleChecks(){return [...new Set(state.roleDefinition.responsibilities.flatMap(r=>r.check_refs).concat(state.roleCatalog.standards.filter(s=>state.roleDefinition.standard_refs.includes(s.ref)).flatMap(s=>s.verifier_refs)))];}
function dutyRow(duty={description:'',deliverable_ref:state.roleDefinition.domain_pack_ref==='knowledge-answer@1.0.0'?'knowledge-answer@1.0.0':'release-report@1.0.0',check_refs:[]}){
 const qa=state.roleDefinition.domain_pack_ref==='knowledge-answer@1.0.0';const deliverables=qa?['knowledge-answer@1.0.0']:['release-report@1.0.0','release-draft@1.0.0'];
 const checks=qa?['answer-grounded','answer-scope','answer-current']:['report-sections','critical-claims-evidence','draft-readback'];
 return `<fieldset class="duty-row"><legend>岗位职责</legend><label>职责说明<textarea data-duty="description" required rows="2" maxlength="1000">${esc(duty.description)}</textarea></label><label>交付物<select data-duty="deliverable">${deliverables.map(ref=>`<option value="${ref}" ${duty.deliverable_ref===ref?'selected':''}>${esc(deliverableLabels[ref])}</option>`).join('')}</select></label><p class="role-check-heading">此职责负责哪些验收项？</p><div class="duty-checks" role="group" aria-label="职责验收项">${checks.map(ref=>`<label class="check-label"><input type="checkbox" data-check-ref="${ref}" ${duty.check_refs.includes(ref)?'checked':''}><span>${esc(checkLabels[ref])}</span></label>`).join('')}</div><button type="button" class="text-button" data-remove-duty>移除此职责</button></fieldset>`;
}
function serializeRoleDefinition(validate=false){
 const d=structuredClone(state.roleDefinition);d.identity={...d.identity,name:$('#agent-name').value.trim(),role:$('#agent-role').value.trim()};
 d.responsibilities=$$('#agent-duties .duty-row').map(row=>({description:$('[data-duty="description"]',row).value,deliverable_ref:$('[data-duty="deliverable"]',row).value,check_refs:$$('[data-check-ref]:checked',row).map(c=>c.dataset.checkRef)}));
 d.standard_refs=$$('[data-standard-ref]:checked').map(c=>c.dataset.standardRef);d.native_read_refs=$$('[data-native-ref]:checked').map(c=>c.dataset.nativeRef);
 const adapter=$('#agent-adapter').value;if(adapter)d.adapter_bindings=Object.fromEntries(d.capability_refs.map(ref=>[ref,adapter]));
 if(validate){const issue=roleDefinitionIssues(d)[0];if(issue)throw roleValidationError(issue.message,issue.fields);}
 return d;
}
function roleDefinitionIssues(definition=serializeRoleDefinition()){
 const issues=[],add=(section,code,message,fields)=>issues.push({section,code,message,fields:fields.filter(Boolean),source:'role'});
 const missingIdentity=[$('#agent-role')].filter(field=>!field.value.trim());
 if(missingIdentity.length)add('identity','identity','请填写岗位角色。',missingIdentity);
 if(!agentDomainChoice($('#agent-domain').value)||agentDomainChoice($('#agent-domain').value).domain_pack_ref!==definition.domain_pack_ref)add('identity','domain','请选择已有领域，或先创建新领域。',[$('#agent-domain')]);
 if(!$('#agent-domain-create-fields').hidden)add('identity','domain-draft','请先创建并选用新领域，或取消新建。',[$('#agent-domain-name')]);
 const rows=$$('#agent-duties .duty-row');
 if(!definition.responsibilities.length)add('responsibilities','duties','至少添加一项岗位职责，并选择对应的验收项。',[$('[data-action="add-agent-duty"]')]);
 const incomplete=rows.flatMap(row=>{if(!$('[data-duty="description"]',row).value.trim())return [$('[data-duty="description"]',row)];return $$('[data-check-ref]:checked',row).length?[]:[$('[data-check-ref]',row)];});
 if(incomplete.length)add('responsibilities','duty-details','每项职责必须填写说明，并选择至少一个验收项。',incomplete);
 const required=roleDomain()?.check_refs||[],selected=new Set(state.roleCatalog.standards.filter(standard=>definition.standard_refs.includes(standard.ref)).flatMap(standard=>standard.verifier_refs));
 const covered=new Set(definition.responsibilities.flatMap(duty=>duty.check_refs));
 if(required.some(check=>!selected.has(check)))add('responsibilities','standards','执行标准未覆盖此领域的全部必选验收项。请补选标准。',[$('#agent-standards input:not(:checked)')]);
 if(definition.responsibilities.length&&required.some(check=>!covered.has(check)))add('responsibilities','coverage','请为全部必选验收项指定负责的岗位职责。',required.filter(check=>!covered.has(check)).map(check=>$('#agent-duties [data-check-ref="'+check+'"]')));
 return issues;
}
function roleValidationError(message,fields){const error=Error(message);error.agentFields=fields.filter(Boolean);return error;}
function updateRoleCoverage(){
 if(!state.roleDefinition||!state.roleCatalog)return;
 const required=roleDomain()?.check_refs||[];
 const responsibilityChecks=new Set($$('#agent-duties [data-check-ref]:checked').map(field=>field.dataset.checkRef));
 const selectedStandards=new Set($$('#agent-standards [data-standard-ref]:checked').map(field=>field.dataset.standardRef));
 const standardChecks=new Set(state.roleCatalog.standards.filter(standard=>selectedStandards.has(standard.ref)).flatMap(standard=>standard.verifier_refs));
 const covered=required.filter(check=>responsibilityChecks.has(check)&&standardChecks.has(check));
 let container=$('#agent-role-coverage');if(!container){container=document.createElement('div');container.id='agent-role-coverage';container.className='role-coverage';container.setAttribute('role','group');container.setAttribute('aria-label','岗位验收覆盖情况');$('#agent-duties').before(container);}
 const fingerprint=JSON.stringify([required,[...responsibilityChecks],[...standardChecks]]);if(container.dataset.coverage===fingerprint)return;container.dataset.coverage=fingerprint;
 container.innerHTML=`<div class="mini-heading"><strong>验收覆盖</strong><span class="pill ${covered.length===required.length?'good':'warn'}">${covered.length} / ${required.length} 已就绪</span></div><p class="role-section-note">每项验收都需要对应职责和执行标准。下面的状态会随配置更新。</p><div class="role-coverage-items">${required.map(check=>{const assigned=responsibilityChecks.has(check),standard=standardChecks.has(check),ready=assigned&&standard;return `<div class="role-coverage-item ${ready?'complete':''}"><span aria-hidden="true">${icon(ready?'check':'clock')}</span><span><strong>${esc(checkLabels[check]||check)}</strong><small>${assigned?'已指定职责':'待指定职责'} · ${standard?'标准已覆盖':'待选择标准'}</small></span></div>`;}).join('')}</div>`;
}
function updateDutyLabels(){
 $$('#agent-duties .duty-row').forEach((row,index)=>{const number=String(index+1).padStart(2,'0');$('legend',row).textContent='职责 '+number;$('[data-remove-duty]',row).setAttribute('aria-label','移除职责 '+(index+1));$('.duty-checks',row).setAttribute('aria-label','职责 '+(index+1)+' 的验收项');});
}
function updateRolePreview(){
 if(!state.roleDefinition||!$('#agent-duties'))return;
 $('#agent-definition').value=JSON.stringify(serializeRoleDefinition(),null,2);updateDutyLabels();updateRoleCoverage();if(typeof scheduleAgentConfigurationRefresh==='function')scheduleAgentConfigurationRefresh();
}
document.addEventListener('input',e=>{if(e.target.closest('#agent-form')&&!e.target.closest('.select-popover')&&!e.isComposing&&!state.agentComposing&&!state.composing)updateRolePreview();});
document.addEventListener('change',async e=>{
 if(e.target.id==='agent-domain'){
  await changeAgentDomain(e.target.value);
 }else if(e.target.closest('#agent-form'))updateRolePreview();
});
document.addEventListener('click',e=>{
 if(e.target.closest('[data-action="add-agent-duty"]')){
  if($$('#agent-duties .duty-row').length>=16){toast('最多配置 16 项职责');return;}
  $('#agent-duties').insertAdjacentHTML('beforeend',dutyRow());updateRolePreview();$('#agent-duties .duty-row:last-child [data-duty="description"]').focus();markAgentFormChanged();
 }
 const remove=e.target.closest('[data-remove-duty]');if(remove){const row=remove.closest('fieldset'),next=row.nextElementSibling||row.previousElementSibling;row.remove();updateRolePreview();(next?$('[data-duty="description"]',next):$('[data-action="add-agent-duty"]')).focus();markAgentFormChanged();}
});
