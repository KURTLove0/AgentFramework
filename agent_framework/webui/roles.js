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
 state.roleDefinition=structuredClone(definition);$('#agent-role').value=definition.identity.role;$('#agent-team').value=definition.identity.owner_team;$('#agent-domain').value=definition.domain_pack_ref;
 $('#agent-duties').innerHTML=definition.responsibilities.map(dutyRow).join('');
 // Registry verifier lists are the authority for each selectable standard.
 const allowed=state.roleCatalog.standards.filter(s=>s.verifier_refs.some(c=>roleChecks().includes(c)));
 $('#agent-standards').innerHTML=allowed.map(s=>`<label class="standard-choice"><input type="checkbox" data-standard-ref="${esc(s.ref)}" ${definition.standard_refs.includes(s.ref)?'checked':''}><span><strong>${esc(roleLabels[s.ref]?.[0]||s.ref)}</strong><small>${esc(roleLabels[s.ref]?.[1]||'按登记的验证器执行。')}</small><code>${esc(s.ref)}</code><small>验收：${s.verifier_refs.map(c=>esc(checkLabels[c]||c)).join('、')}</small></span></label>`).join('');
 $('#agent-native-reads').innerHTML='<h4>模型原生只读 MCP</h4>'+state.roleCatalog.caps.filter(c=>c.effect==='READ'&&definition.capability_refs.includes(c.ref)).map(c=>`<label class="check-label"><input type="checkbox" data-native-ref="${esc(c.ref)}" ${definition.native_read_refs.includes(c.ref)?'checked':''}><span>${esc(c.ref)}<small>通过任务作用域代理读取，计入预算并保存证据。</small></span></label>`).join('');
 $('#agent-adapter').value='';$('#agent-adapter').disabled=definition.domain_pack_ref==='knowledge-answer@1.0.0';updateRolePreview();
}
function roleDomain(){return state.roleCatalog.domains.find(d=>d.ref===state.roleDefinition.domain_pack_ref);}
function roleChecks(){return [...new Set(state.roleDefinition.responsibilities.flatMap(r=>r.check_refs).concat(state.roleCatalog.standards.filter(s=>state.roleDefinition.standard_refs.includes(s.ref)).flatMap(s=>s.verifier_refs)))];}
function dutyRow(duty={description:'',deliverable_ref:state.roleDefinition.domain_pack_ref==='knowledge-answer@1.0.0'?'knowledge-answer@1.0.0':'release-report@1.0.0',check_refs:[]}){
 const qa=state.roleDefinition.domain_pack_ref==='knowledge-answer@1.0.0';const deliverables=qa?['knowledge-answer@1.0.0']:['release-report@1.0.0','release-draft@1.0.0'];
 const checks=qa?['answer-grounded','answer-scope','answer-current']:['report-sections','critical-claims-evidence','draft-readback'];
 return `<fieldset class="duty-row"><legend>岗位职责</legend><label>职责说明<textarea data-duty="description" required rows="2" maxlength="1000">${esc(duty.description)}</textarea></label><label>交付物<select data-duty="deliverable">${deliverables.map(ref=>`<option value="${ref}" ${duty.deliverable_ref===ref?'selected':''}>${esc(deliverableLabels[ref])}</option>`).join('')}</select></label><div class="duty-checks" role="group" aria-label="职责验收项">${checks.map(ref=>`<label class="check-label"><input type="checkbox" data-check-ref="${ref}" ${duty.check_refs.includes(ref)?'checked':''}><span>${esc(checkLabels[ref])}</span></label>`).join('')}</div><button type="button" class="text-button" data-remove-duty>移除此职责</button></fieldset>`;
}
function serializeRoleDefinition(validate=false){
 const d=structuredClone(state.roleDefinition);d.identity={name:$('#agent-name').value.trim(),role:$('#agent-role').value.trim(),owner_team:$('#agent-team').value.trim()};
 d.responsibilities=$$('#agent-duties .duty-row').map(row=>({description:$('[data-duty="description"]',row).value,deliverable_ref:$('[data-duty="deliverable"]',row).value,check_refs:$$('[data-check-ref]:checked',row).map(c=>c.dataset.checkRef)}));
 d.standard_refs=$$('[data-standard-ref]:checked').map(c=>c.dataset.standardRef);d.native_read_refs=$$('[data-native-ref]:checked').map(c=>c.dataset.nativeRef);
 const adapter=$('#agent-adapter').value;if(adapter)d.adapter_bindings=Object.fromEntries(d.capability_refs.map(ref=>[ref,adapter]));
 if(validate){
  if(!d.identity.role||!d.identity.owner_team)throw Error('请填写岗位角色和归属团队。');
  if(!d.responsibilities.length||d.responsibilities.some(r=>!r.description.trim()||!r.check_refs.length))throw Error('每项职责必须填写说明，并选择至少一个验收项。');
  const required=roleDomain().check_refs;const selected=new Set(state.roleCatalog.standards.filter(s=>d.standard_refs.includes(s.ref)).flatMap(s=>s.verifier_refs));
  const covered=new Set(d.responsibilities.flatMap(r=>r.check_refs));
  if(required.some(c=>!selected.has(c)))throw Error('执行标准未覆盖此领域的全部必选验收项。');
  if(required.some(c=>!covered.has(c)))throw Error('请为全部必选验收项指定负责的岗位职责。');
 }
 return d;
}
function updateRolePreview(){if(state.roleDefinition&&$('#agent-duties').children.length)$('#agent-definition').value=JSON.stringify(serializeRoleDefinition(),null,2);}
document.addEventListener('input',e=>{if(e.target.closest('#agent-form'))updateRolePreview();});
document.addEventListener('change',async e=>{
 if(e.target.id==='agent-domain'){
  const select=e.target;select.disabled=true;
  try{const data=await api('/api/agent-definition-default?domain='+encodeURIComponent(select.value));const d=data.definition;d.identity={name:$('#agent-name').value,role:$('#agent-role').value,owner_team:$('#agent-team').value};await initRoleEditor(d);}
  catch(error){$('#agent-form-error').textContent=error.message;$('#agent-form-error').hidden=false;}finally{select.disabled=false;}
 }else if(e.target.closest('#agent-form'))updateRolePreview();
});
document.addEventListener('click',e=>{if(e.target.closest('[data-action="add-agent-duty"]')){if($$('#agent-duties .duty-row').length>=16){toast('最多配置 16 项职责');return;}$('#agent-duties').insertAdjacentHTML('beforeend',dutyRow());updateRolePreview();}const remove=e.target.closest('[data-remove-duty]');if(remove){remove.closest('fieldset').remove();updateRolePreview();}});
