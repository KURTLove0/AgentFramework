'use strict';
// Run with: node tests/test_agent_interactions.js
// Actual Agent scripts run in a small isolated DOM/VM. Fixtures are synthetic;
// API calls fail immediately, and no browser, model or business store is used.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const directory=path.resolve(__dirname,'..','agent_framework','webui');
let passed=0;
function fixture(){
 const nodes={},created=[],listeners=[],queued=[],calls=[],checks=['report-sections','critical-claims-evidence','draft-readback'];let context;
 function node(id='',options={}){
  const item={id,value:'',type:'text',required:false,disabled:false,hidden:false,open:false,removed:false,dataset:{},attrs:{},children:[],controls:[],listeners:{},textContent:'',innerHTML:'',validity:{valid:true},validationMessage:'请填写此字段。',willValidate:true,classList:{toggle(){}},...options};
  item.setAttribute=(name,value)=>item.attrs[name]=String(value);item.getAttribute=name=>item.attrs[name]??null;item.removeAttribute=name=>delete item.attrs[name];
  item.addEventListener=(kind,fn,options)=>{(item.listeners[kind]||=[]).push({fn,once:options?.once});};
  item.focus=()=>{context.document.activeElement=item;calls.push({kind:'focus',id:item.id});};item.scrollIntoView=()=>calls.push({kind:'scroll',id:item.id});
  item.closest=selector=>selector==='label'?item.label||null:selector==='.agent-config-panel'?item.panel||null:selector==='#agent-form'?item.panel?nodes['agent-form']:null:selector==='#agent-dialog'?item.panel?nodes['agent-dialog']:null:null;
  item.getClientRects=()=>item.removed||item.panel?.hidden?[]:[{}];item.after=element=>{created.push(element);element.parentElement=item.parentElement;};item.before=item.after;item.append=(...elements)=>item.children.push(...elements);item.prepend=(...elements)=>item.children.unshift(...elements);item.remove=()=>{item.removed=true;};
  item.showModal=()=>{item.open=true;calls.push({kind:'modal',id:item.id});};item.close=()=>{item.open=false;const handlers=item.listeners.close||[];item.listeners.close=handlers.filter(handler=>!handler.once);handlers.forEach(handler=>handler.fn());};
  item.querySelector=selector=>selector==='[data-close]'?nodes['confirm-back']:item.fields?.[selector]||null;
  if(id)nodes[id]=item;return item;
 }
 for(const id of ['agent-form','agent-dialog','agent-form-state','agent-form-error','agent-config-progress','agent-config-progress-text','agent-next-guidance','agent-skill-context','agent-review-summary','agent-save','agent-duties','agent-standards','agent-skills','agent-legacy-skills','agent-definition','agent-domain-create-fields','agent-domain-new','agent-domain-name','agent-domain-description','agent-domain-method','agent-domain-help','agent-domain-create','confirm-dialog','confirm-title','confirm-body','confirm-error','confirm-submit','confirm-back'])node(id);
 nodes['agent-domain-create-fields'].hidden=true;nodes['agent-domain-create-fields'].disabled=true;nodes['agent-dialog'].open=true;nodes['agent-form'].dataset.organized='true';nodes['agent-form'].dataset.revision='0';nodes['agent-form'].dataset.id='';nodes['agent-form-error'].hidden=true;
 const ids=['identity','runtime','advanced'];
 for(const id of ids){node('agent-config-panel-'+id,{hidden:id!=='identity'});node('agent-config-tab-'+id,{dataset:{agentConfigTab:id}});node('agent-step-status-'+id);}
 const previous=node('previous',{dataset:{agentConfigDirection:'-1'}}),next=node('next',{dataset:{agentConfigDirection:'1'}}),addSkill=node('add-skill'),addDuty=node('add-duty');
 function control(id,section,value='',options={}){if(['responsibilities','skills'].includes(section))section='advanced';const panel=nodes['agent-config-panel-'+section],item=node(id,{value,panel,parentElement:panel,...options});item.label=node('',{childNodes:[{textContent:id}]});item.label.parentElement=panel;panel.controls.push(item);return item;}
 control('agent-description','identity','模拟岗位描述');control('agent-name','identity','模拟评估岗位',{required:true});control('agent-role','identity','release-reviewer',{required:true});control('agent-domain','identity','');control('agent-execution-template','runtime','change-assessment@2.0.0');
 control('agent-runtime','runtime','mock');control('agent-model','runtime','builtin');control('agent-prompt','runtime','仅使用模拟证据',{required:true,type:'textarea'});control('agent-timeout','runtime','60');control('agent-attempts','runtime','2');control('agent-adapter','advanced','');
 const duty=node('duty');duty.fields={'[data-duty="description"]':control('duty-description','responsibilities','评估并独立回读模拟草稿',{required:true,type:'textarea'}),'[data-duty="deliverable"]':control('duty-deliverable','responsibilities','release-report@1.0.0')};duty.checks=checks.map(check=>control('check-'+check,'responsibilities','',{type:'checkbox',checked:true,dataset:{checkRef:check}}));duty.fields['[data-check-ref]']=duty.checks[0];
 duty.fields.legend=node();duty.fields['[data-remove-duty]']=node();duty.fields['.duty-checks']=node();
 const standard=control('standard','responsibilities','',{type:'checkbox',checked:true,dataset:{standardRef:'synthetic-standard@1'}});
 const rows=[duty],mcps=[];
 function all(selector,root){
  if(selector==='input,select,textarea')return root.controls||[];
  if(selector==='[data-agent-config-tab]')return ids.map(id=>nodes['agent-config-tab-'+id]);
  if(selector==='#agent-duties .duty-row')return rows;
  if(selector==='[data-check-ref]:checked')return (root.checks||[]).filter(item=>item.checked);
  if(selector==='#agent-duties [data-check-ref]:checked')return rows.flatMap(row=>row.checks.filter(item=>item.checked));
  if(selector==='[data-standard-ref]:checked')return standard.checked?[standard]:[];
  if(selector==='[data-native-ref]:checked')return [];
  if(selector==='#agent-mcps .mcp-row')return mcps;
  if(selector==='[data-agent-field-error]')return created.filter(item=>item.dataset.agentFieldError&&!item.removed);
  if(selector==='[aria-invalid="true"]')return Object.values(nodes).filter(item=>item.attrs['aria-invalid']==='true');
  return [];
 }
 function one(selector,root){
  if(root?.fields?.[selector])return root.fields[selector];
  if(selector==='[data-agent-config-direction="-1"]')return previous;if(selector==='[data-agent-config-direction="1"]')return next;
  if(selector==='[data-action="add-agent-skill"]')return addSkill;if(selector==='[data-action="add-agent-duty"]')return addDuty;
  if(selector==='#agent-standards input:not(:checked)')return standard.checked?null:standard;
  const check=selector.match(/^#agent-duties \[data-check-ref="([^"]+)"\]$/);if(check)return duty.checks.find(item=>item.dataset.checkRef===check[1]);
  return nodes[selector.replace(/^#/,'')]||null;
 }
 const state={agentDomains:[],agentConfigSection:'identity',agentDirty:false,agentAttemptedSections:new Set(),agentSkillBindings:[],agentLegacySkills:[],skillCatalog:[],roleDefinition:{identity:{name:'模拟岗位',role:'release-reviewer'},domain_pack_ref:'change-assessment@2.0.0',responsibilities:[{description:'评估',deliverable_ref:'release-report@1.0.0',check_refs:checks}],standard_refs:['synthetic-standard@1'],capability_refs:['read@1','write@1'],native_read_refs:[],adapter_bindings:{'read@1':'frozen-adapter@1','write@1':'frozen-adapter@1'}},roleCatalog:{standards:[{ref:'synthetic-standard@1',verifier_refs:checks}],domains:[{ref:'change-assessment@2.0.0',check_refs:checks}],caps:[]}};
 context=vm.createContext({state,structuredClone,console,queueMicrotask:fn=>queued.push(fn),document:{activeElement:nodes['agent-name'],addEventListener:(kind,fn,capture)=>listeners.push({kind,fn,capture}),createElement:()=>node(),getElementById:id=>nodes[id]||created.find(item=>item.id===id&&!item.removed),contains:item=>!item.removed},$:one,$$:all,esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),icon:()=>'<svg aria-hidden="true"></svg>',fact:(label,value)=>'<dt>'+label+'</dt><dd>'+value+'</dd>',runtimeLabel:value=>value,toast:message=>calls.push({kind:'toast',message}),api:()=>{calls.push({kind:'api'});throw Error('Unexpected API call');},newTask:options=>calls.push({kind:'new-task',options}),navigate:()=>{},render:()=>{},selectableSkillVersions:()=>state.skillCatalog.flatMap(skill=>skill.versions.filter(version=>version.status==='PUBLISHED'&&!skill.archived).map(version=>({skill_id:skill.id,version:version.version,name:skill.name}))),serializeAgentSkillBindings:()=>structuredClone(state.agentSkillBindings),agentSkillsSummary:()=>''});
 for(const filename of ['agents.js','agent_domains.js','roles.js'])vm.runInContext(fs.readFileSync(path.join(directory,filename),'utf8'),context,{filename});
 const run=expression=>vm.runInContext(expression,context),flush=()=>{while(queued.length)queued.shift()();};
 return {nodes,state,calls,run,flush,listeners,checks,standard,duty,rows,mcps,control,context,node};
}
async function scenario(name,fn){const f=fixture();await fn(f);assert.equal(f.calls.filter(call=>call.kind==='api').length,0,'Interaction must not invoke an API');passed++;console.log('PASS '+name);}
async function main(){
 await scenario('archive keeps the committed state without depending on another list read',async f=>{
  f.state.workspaceId='workspace-a';f.state.view='agents';f.state.selected='agent-a';
  f.state.agents=[{id:'agent-a',revision:1,archived:false},{id:'agent-b',revision:3,archived:false}];
  const requests=[];f.context.api=async(url,data)=>{requests.push({url,data});if(!data)throw Error('List unavailable');return {id:'agent-a',revision:2,archived:true};};
  await f.run('archiveAgent("agent-a")');
  assert.equal(requests.length,1);assert.equal(f.state.agents[0].archived,true);assert.equal(f.state.agents[0].revision,2);assert.equal(f.state.agents[1].id,'agent-b');
  assert.match(f.run('agentArchiveControl(state.agents[0])'),/恢复使用/);assert.equal(f.calls.filter(call=>call.kind==='toast').at(-1).message,'智能体已归档，可随时恢复');
 });
 await scenario('restore immediately exposes the authoritative new revision',async f=>{
  f.state.workspaceId='workspace-a';f.state.agents=[{id:'agent-a',revision:2,archived:true}];
  f.context.api=async(url,data)=>{assert.equal(data.archived,false);assert.equal(data.revision,2);return {id:'agent-a',revision:3,archived:false};};
  await f.run('archiveAgent("agent-a")');assert.equal(f.state.agents[0].archived,false);assert.equal(f.state.agents[0].revision,3);assert.match(f.run('agentArchiveControl(state.agents[0])'),/归档智能体/);
 });
 await scenario('slow archive stays busy across rendering and rejects duplicate submissions',async f=>{
  f.state.workspaceId='workspace-a';f.state.agents=[{id:'agent-a',revision:1,archived:false}];let finish,posts=0;
  f.context.api=()=>{posts++;return new Promise(resolve=>finish=resolve);};
  const pending=f.run('archiveAgent("agent-a")');assert.match(f.run('agentArchiveControl(state.agents[0])'),/disabled aria-busy="true"/);
  await f.run('archiveAgent("agent-a")');assert.equal(posts,1);
  finish({id:'agent-a',revision:2,archived:true});await pending;assert.equal(f.run('agentArchivePending("agent-a")'),false);assert.doesNotMatch(f.run('agentArchiveControl(state.agents[0])'),/aria-busy/);
 });
 await scenario('rejected archive preserves the original state and permits an explicit retry',async f=>{
  f.state.workspaceId='workspace-a';f.state.agents=[{id:'agent-a',revision:1,archived:false}];const button=f.node('agent-archive-agent-a');
  f.context.api=async()=>{throw Error('Service unavailable');};await f.run('archiveAgent("agent-a",document.getElementById("agent-archive-agent-a"))');
  assert.equal(f.state.agents[0].archived,false);assert.equal(button.disabled,false);assert.equal(button.attrs['aria-busy'],undefined);assert.match(f.calls.filter(call=>call.kind==='toast').at(-1).message,/归档失败/);
  f.context.api=async()=>({id:'agent-a',revision:2,archived:true});await f.run('archiveAgent("agent-a")');assert.equal(f.state.agents[0].archived,true);
 });
 await scenario('archive response cannot replace another workspace or announce success there',async f=>{
  f.state.workspaceId='workspace-a';f.state.agents=[{id:'agent-a',revision:1,archived:false}];let finish;
  f.context.api=()=>new Promise(resolve=>finish=resolve);const pending=f.run('archiveAgent("agent-a")');
  f.state.workspaceId='workspace-b';f.state.agents=[{id:'agent-b',revision:1,archived:false}];finish({id:'agent-a',revision:2,archived:true});await pending;
  assert.equal(f.state.agents[0].id,'agent-b');assert.equal(f.calls.filter(call=>call.kind==='toast').length,0);assert.equal(f.state.agentArchiveRequests.size,0);
 });
 await scenario('the directory arrow has a stable return-focus target',f=>{
  f.state.agents=[{id:'agent-a',name:'资料助手',runtime:'mock',definition:f.state.roleDefinition}];
  assert.match(f.run('agentDirectoryRow(state.agents[0])'),/id="agent-inspect-agent-a"[^>]*href="#\/agents\/agent-a"/);
 });
 await scenario('missing identity is shown in progress and blocks Next at the actual field',f=>{f.nodes['agent-name'].value='';f.nodes['agent-name'].validity.valid=false;f.run('refreshAgentConfiguration()');assert.equal(f.nodes['agent-config-progress'].value,2);f.run('advanceAgentConfiguration()');assert.equal(f.state.agentConfigSection,'identity');assert.equal(f.nodes['agent-name'].attrs['aria-invalid'],'true');assert.equal(f.nodes['agent-step-status-identity'].textContent,'待修正');assert.equal(f.context.document.activeElement,f.nodes['agent-form-error']);});
 await scenario('correcting a reported field clears stale error without focus then permits Next',f=>{f.nodes['agent-name'].value='';f.nodes['agent-name'].validity.valid=false;f.run('advanceAgentConfiguration()');f.nodes['agent-name'].value='模拟新岗位';f.nodes['agent-name'].validity.valid=true;const focus=f.calls.filter(call=>call.kind==='focus').length;f.run('refreshAgentReportedErrors();refreshAgentConfiguration()');assert.equal(f.nodes['agent-form-error'].hidden,true);assert.equal(f.calls.filter(call=>call.kind==='focus').length,focus);assert.equal(f.nodes['agent-config-progress'].value,3);f.run('advanceAgentConfiguration()');assert.equal(f.state.agentConfigSection,'runtime');});
 await scenario('standards and responsibility coverage remain required',f=>{f.state.agentConfigSection='advanced';f.standard.checked=false;f.run('advanceAgentConfiguration()');assert.equal(f.state.agentConfigSection,'advanced');assert.match(f.nodes['agent-form-error'].innerHTML,/执行标准未覆盖/);f.standard.checked=true;f.duty.checks[2].checked=false;assert(f.run('roleDefinitionIssues()').some(issue=>issue.code==='coverage'));});
 await scenario('all role errors are assigned to their own sections',f=>{f.nodes['agent-role'].value='';f.standard.checked=false;const issues=f.run('roleDefinitionIssues()');assert(issues.some(issue=>issue.section==='identity'));assert(issues.some(issue=>issue.section==='responsibilities'));});
 await scenario('serialized adapter bindings and verifier references are preserved',f=>{const definition=f.run('serializeRoleDefinition(true)');assert.equal(definition.adapter_bindings['write@1'],'frozen-adapter@1');assert.deepEqual([...definition.responsibilities[0].check_refs],f.checks);});
 await scenario('teamless identity advances and never invents team metadata',f=>{assert.equal(f.nodes['agent-team'],undefined);f.run('advanceAgentConfiguration()');assert.equal(f.state.agentConfigSection,'runtime');assert(!('owner_team' in f.run('serializeRoleDefinition(true)').identity));});
 await scenario('editing a legacy identity retains its existing team without an input',f=>{f.state.roleDefinition.identity.owner_team='历史团队';assert.equal(f.run('serializeRoleDefinition(true)').identity.owner_team,'历史团队');});
 await scenario('unpublished or mismatched domain blocks saving at the domain select',f=>{f.nodes['agent-domain'].value='custom-domain@1';assert.throws(()=>f.run('serializeRoleDefinition(true)'),/请选择已有领域/);f.run('advanceAgentConfiguration()');assert.equal(f.state.agentConfigSection,'identity');assert.equal(f.nodes['agent-domain'].attrs['aria-invalid'],'true');f.nodes['agent-domain'].value='';f.state.roleDefinition.domain_pack_ref='custom-domain@1';assert.throws(()=>f.run('serializeRoleDefinition(true)'),/执行配置不可用/);});
 await scenario('an unfinished inline domain cannot be skipped and cancelling clears errors',f=>{f.run('toggleAgentDomainEditor(true);advanceAgentConfiguration()');assert.equal(f.state.agentConfigSection,'identity');assert.match(f.nodes['agent-form-error'].innerHTML,/先创建并选用/);f.nodes['agent-domain-name'].value='未完成领域';f.run('toggleAgentDomainEditor(false)');assert.equal(f.nodes['agent-form-error'].hidden,true);assert.equal(f.nodes['agent-domain-name'].value,'未完成领域');f.run('advanceAgentConfiguration()');assert.equal(f.state.agentConfigSection,'runtime');});
 await scenario('custom business domains are selectable independently of their execution method',f=>{f.state.agentDomains=[{id:'domain-synthetic',name:'客户服务',description:'售后流程',work_method:'先了解问题，再核对证据并给出建议。',revision:1}];f.state.agentProcessingDomain=f.state.agentDomains[0];f.nodes['agent-domain'].value='domain-synthetic';assert.equal(f.run('serializeRoleDefinition(true)').domain_pack_ref,'change-assessment@2.0.0');assert.equal(f.run('agentEditorDomainLabel()'),'客户服务');f.state.agents=[{id:'custom',name:'服务助手',runtime:'mock',definition:f.state.roleDefinition,processing_domain:f.state.agentDomains[0]},{id:'builtin',name:'发布助手',runtime:'mock',definition:f.state.roleDefinition}];f.state.agentDomain='domain-synthetic';assert.deepEqual([...f.run('filteredAgents()')].map(a=>a.id),['custom']);f.state.agentDomain='all';f.state.agentSearch='售后流程';assert.deepEqual([...f.run('filteredAgents()')].map(a=>a.id),['custom']);});
 await scenario('changing or clearing a business domain preserves execution bindings and manual instructions',async f=>{
  f.state.agentDomains=[{id:'domain-synthetic',name:'产品研究',description:'业务范围',work_method:'访谈、比较并输出建议。',revision:1}];
  const definition=JSON.stringify(f.run('serializeRoleDefinition(true)')),prompt=f.nodes['agent-prompt'].value;
  await f.run('changeAgentDomain("domain-synthetic")');
  assert.equal(JSON.stringify(f.run('serializeRoleDefinition(true)')),definition);assert.equal(f.nodes['agent-prompt'].value,prompt);
  assert.equal(f.run('domainWorkMethod(state.agentProcessingDomain)'),'访谈、比较并输出建议。');
  await f.run('changeAgentDomain("")');assert.equal(f.state.agentProcessingDomain,null);
  assert.equal(JSON.stringify(f.run('serializeRoleDefinition(true)')),definition);assert.equal(f.nodes['agent-prompt'].value,prompt);
 });
 await scenario('submitting an early step advances without prematurely creating an Agent',async f=>{await f.run('saveAgent($("#agent-form"))');assert.equal(f.state.agentConfigSection,'runtime');assert.equal(f.nodes['agent-save'].hidden,true);});
 await scenario('model loading is visibly busy and cannot advance',f=>{f.state.agentConfigSection='runtime';f.state.agentModelLoading=true;f.run('refreshAgentConfiguration();advanceAgentConfiguration()');assert.equal(f.state.agentConfigSection,'runtime');assert.equal(f.nodes.next.disabled,true);assert.equal(f.nodes['agent-step-status-runtime'].textContent,'读取中');});
 await scenario('invalid model selection links the runtime error to its input',f=>{f.state.agentConfigSection='runtime';f.nodes['agent-model'].required=true;f.nodes['agent-model'].validity.valid=false;f.run('advanceAgentConfiguration()');assert.equal(f.nodes['agent-model'].attrs['aria-invalid'],'true');assert.equal(f.state.agentConfigSection,'runtime');});
 await scenario('three-step flow goes from model configuration directly to review',f=>{f.state.agentConfigSection='runtime';f.run('refreshAgentConfiguration()');assert.match(f.nodes.next.textContent,/预览配置/);f.run('advanceAgentConfiguration()');assert.equal(f.state.agentConfigSection,'advanced');assert.equal(f.state.agentSkillBindings.length,0);assert.equal(f.nodes.next.hidden,true);assert.equal(f.nodes['agent-save'].hidden,false);});
 await scenario('withdrawn enabled binding is blocked while disabled frozen version is preserved',f=>{f.control('agent-skill-select-0','skills','skill-old@1');f.state.agentSkillBindings=[{skill_id:'skill-old',version:1,enabled:true}];assert(f.run('agentConfigurationSteps()').find(step=>step.id==='advanced').issues.length);f.state.agentSkillBindings[0].enabled=false;assert.equal(f.run('agentConfigurationSteps()').find(step=>step.id==='advanced').issues.length,0);assert.equal(f.state.agentSkillBindings[0].version,1);});
 await scenario('Skills context shows pinned version without upgrading to newer release',f=>{f.state.skillCatalog=[{id:'skill-synthetic',name:'review <method>',versions:[{version:1,status:'PUBLISHED'},{version:2,status:'PUBLISHED'}]}];f.state.agentSkillBindings=[{skill_id:'skill-synthetic',version:1,enabled:true}];f.run('refreshAgentSkillContext()');assert.match(f.nodes['agent-skill-context'].innerHTML,/固定 v1/);assert.match(f.nodes['agent-skill-context'].innerHTML,/&lt;method&gt;/);assert.equal(f.state.agentSkillBindings[0].version,1);});
 await scenario('empty Skill directory offers management instead of creating an empty binding',f=>{f.run('refreshAgentSkillContext()');assert.equal(f.nodes['add-skill'].disabled,true);assert.match(f.nodes['agent-skill-context'].innerHTML,/data-manage-skills/);assert.equal(f.state.agentSkillBindings.length,0);});
 await scenario('MCP arguments must remain a JSON array',f=>{const field=f.control('mcp-args','advanced','{}');f.mcps.push({fields:{'[data-field="args"]':field}});assert(f.run('agentConfigurationSteps()').find(step=>step.id==='advanced').issues.length);field.value='["--synthetic"]';assert.equal(f.run('agentConfigurationSteps()').find(step=>step.id==='advanced').issues.length,0);});
 await scenario('IME composition defers progress and prevents accidental advancement',f=>{f.state.agentConfigSection='identity';f.nodes['agent-config-progress-text'].textContent='unchanged';f.state.agentComposing=true;f.run('scheduleAgentConfigurationRefresh();advanceAgentConfiguration()');f.flush();assert.equal(f.nodes['agent-config-progress-text'].textContent,'unchanged');assert.equal(f.state.agentConfigSection,'identity');f.state.agentComposing=false;f.run('scheduleAgentConfigurationRefresh()');f.flush();assert.match(f.nodes['agent-config-progress-text'].textContent,/3 项已就绪/);});
 await scenario('review points back to incomplete sections and does not imply task authorization',f=>{f.nodes['agent-name'].validity.valid=false;f.run('refreshAgentConfiguration()');assert.match(f.nodes['agent-review-summary'].innerHTML,/data-agent-review-step="identity"/);assert.match(f.nodes['agent-review-summary'].innerHTML,/任务授权.*单独确认/);});
 await scenario('dirty dismissal keeps the form until discard is explicitly chosen',f=>{f.run('markAgentFormChanged();requestAgentDiscard()');assert.equal(f.nodes['agent-dialog'].open,true);assert.equal(f.nodes['confirm-dialog'].open,true);f.nodes['confirm-dialog'].close();assert.equal(f.state.agentDirty,true);f.run('requestAgentDiscard()');f.nodes['confirm-submit'].onclick();assert.equal(f.nodes['agent-dialog'].open,false);assert.equal(f.state.agentDirty,false);});
 await scenario('Skills management preserves dirty editor through its shared return flow',f=>{f.state.agentDirty=true;let delegated=0;f.context.startSkillManagementFromAgent=()=>delegated++;const event={target:{closest:selector=>selector==='#agent-dialog [data-manage-skills]'?{}:null},preventDefault(){},stopImmediatePropagation(){}};f.listeners.find(item=>item.kind==='click'&&item.capture===true).fn(event);assert.equal(delegated,1);assert.equal(f.state.agentDirty,true);assert.equal(f.nodes['confirm-dialog'].open,false);});
 await scenario('Agent card CTA forwards the chosen identity into task creation',f=>{const event={target:{closest:selector=>selector==='[data-agent-new-task]'?{dataset:{agentNewTask:'agent-synthetic'}}:null}};f.listeners.find(item=>item.kind==='click'&&!item.capture).fn(event);assert.equal(f.calls.find(call=>call.kind==='new-task').options.agentId,'agent-synthetic');});
 await scenario('switching a read-only task back to writing never grants permission automatically',f=>{const form={grant:{checked:true,disabled:false,closest:()=>({hidden:false})},change_id:{closest:()=>({hidden:false})}};f.nodes['create-form']=form;f.node('task-domain',{value:'knowledge-answer@1.0.0'});f.node('scenario-select');f.nodes['scenario-select'].label={hidden:false};for(const id of ['create-title','task-intro','scenario-description'])f.node(id);f.run('updateTaskDomain()');assert.equal(form.grant.checked,false);f.nodes['task-domain'].value='change-assessment@2.0.0';f.run('updateTaskDomain()');assert.equal(form.grant.checked,false);});
 await scenario('saved Agent remains visible and focused when the follow-up list read fails',async f=>{f.state.agentConfigSection='advanced';f.state.workspaceId='workspace-synthetic';f.state.view='agents';f.state.agentSearch='does-not-match';f.state.agentStatus='archived';f.state.agentDomain='knowledge-answer@1.0.0';const requests=[];f.node('agent-new-task-agent-saved');f.context.api=async(url,data)=>{requests.push({url,data});if(data)return {...data,id:'agent-saved',revision:1,archived:false};throw Error('synthetic list failure');};await f.run('saveAgent($("#agent-form"))');await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.filter(item=>item.data).length,1);assert.equal(f.nodes['agent-form'].dataset.id,'agent-saved');assert.equal(f.nodes['agent-form'].dataset.revision,'1');assert.equal(f.state.agentSearch,'');assert.equal(f.state.agentStatus,'all');assert.equal(f.state.agentDomain,'all');assert.equal(f.nodes['agent-dialog'].open,false);assert.equal(f.nodes['agent-form-error'].hidden,true);assert.equal(f.state.agents[0].id,'agent-saved');assert.equal(f.context.document.activeElement.id,'agent-new-task-agent-saved');assert(f.calls.some(call=>call.kind==='toast'&&call.message.includes('已保存；列表暂未刷新')));});
 await scenario('post-save list refresh cannot overwrite another workspace',async f=>{f.state.agentConfigSection='advanced';f.state.workspaceId='workspace-a';f.state.view='agents';let complete;f.context.api=async(url,data)=>data?{...data,id:'agent-saved',revision:1,archived:false}:new Promise(resolve=>complete=resolve);await f.run('saveAgent($("#agent-form"))');f.state.workspaceId='workspace-b';f.state.agents=[{id:'agent-in-b'}];complete({agents:[{id:'agent-from-a'}]});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.state.agents[0].id,'agent-in-b');f.run('focusSavedAgent()');assert.equal(f.state.agentSavedFocus,null);});
 console.log('Agent interaction scenarios: '+passed+'/'+passed+' passed (isolated synthetic APIs, no network/model/business writes).');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
