'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{test}=require('node:test');
const root=path.join(__dirname,'../agent_framework/webui');
const agents=fs.readFileSync(path.join(root,'agents.js'),'utf8'),skills=fs.readFileSync(path.join(root,'skills.js'),'utf8');
function part(source,start,end){const first=source.indexOf(start),last=source.indexOf(end,first);assert(first>=0&&last>first);return source.slice(first,last);}
function fixture(){
 const state={agents:[],agentSearch:''};
 const context=vm.createContext({state,esc:value=>String(value??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])),
  icon:()=>'',agentDetailEditAction:()=>'',agentDomainLabel:()=>'',domainWorkMethod:()=>'',agentRuntimeLabel:()=>''});
 vm.runInContext(part(agents,'function agentDetailPanel(','const agentConfigSections=')+
  part(agents,'function filteredAgents(){','function agentDirectoryHref(')+
  part(skills,'function agentSkillsSummary(','async function initAgentSkills('),context);
 return {state,run:code=>vm.runInContext(code,context),context};
}
function profiles(){
 const full={id:'agent-a',name:'目录助手',runtime:'mock',archived:false,definition:{identity:{}},skills:[],
  skill_bindings:[{skill_id:'skill-a',version:1,enabled:true}],skill_packages:[{skill_id:'skill-a',version:1,enabled:true,
   package:{name:'frozen-method',metadata:{description:'核对来源 <script>'},body:'第一版工作方法，保留原文。',files:{'references/source.md':{content:'不应进入目录的资源正文'}}}}]};
 const catalog=structuredClone(full);catalog.catalog_only=true;catalog.skill_summaries=catalog.skill_packages;delete catalog.skill_packages;
 for(const item of catalog.skill_summaries)delete item.package.files;
 return {full,catalog};
}
test('catalog skill details preserve the pinned method and match a complete profile',()=>{
 const f=fixture(),{full,catalog}=profiles();f.context.full=full;f.context.catalog=catalog;
 const original=f.run('agentDetailPanel(full,"skills")'),compact=f.run('agentDetailPanel(catalog,"skills")');
 assert.equal(compact,original);assert(compact.includes('固定发布版本 v1'));assert(compact.includes('第一版工作方法'));
 assert(compact.includes('&lt;script&gt;'));assert(!compact.includes('不应进入目录的资源正文'));
});
test('directory search finds a catalog Agent by its bound skill name',()=>{
 const f=fixture(),{catalog}=profiles();f.state.agents=[catalog];f.state.agentSearch='frozen-method';
 assert.equal(f.run('filteredAgents()').length,1);f.state.agentSearch='没有这个方法';assert.equal(f.run('filteredAgents()').length,0);
});
test('skill badges retain names and bound versions with either directory shape',()=>{
 const f=fixture(),{full,catalog}=profiles();f.context.full=full;f.context.catalog=catalog;
 assert.equal(f.run('agentSkillsSummary(catalog)'),f.run('agentSkillsSummary(full)'));
 assert(f.run('agentSkillsSummary(catalog)').includes('frozen-method'));
});
