'use strict';
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function sandbox(){
 const nodes=new Map(),events=new Map(),calls=[],storage=new Map();
 function element(id){if(nodes.has(id))return nodes.get(id);const e={id,dataset:{},value:'',checked:false,disabled:false,hidden:false,open:false,textContent:'',innerHTML:'',multiple:false,selectedOptions:[],insertAdjacentHTML(_where,text){this.innerHTML+=text;},setAttribute(){},hasAttribute(name){return name==='data-learning-close'&&id==='learning-close';},removeAttribute(){},append(){},addEventListener(name,fn){events.set(id+':'+name,fn);},contains(){return true;},focus(){},showModal(){this.open=true;},close(){this.open=false;}};nodes.set(id,e);return e;}
 const document={createElement:()=>element('learning-dialog'),body:element('body'),addEventListener(name,fn){events.set('document:'+name,fn);},activeElement:null};
 const state={workspaceId:'workspace-default',meta:{tenant:'local',principal:'owner',workspace:{name:'默认'}},routeVersion:1,library:{knowledge:[],memory:{preferences:[],notes:[]},experience:[],capability_methods:[],ontologies:[]}};
 const context=vm.createContext({document,window:{addEventListener(){}},state,Set,Map,JSON,Date,Math,structuredClone,crypto:require('node:crypto').webcrypto,TextEncoder,sessionStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k),get length(){return storage.size;},key:i=>[...storage.keys()][i]},console,confirm:()=>true,requestAnimationFrame:fn=>fn(),
  $:q=>element(q.replace(/^#/,'')),$$:q=>q==='[data-ontology-source]:checked'?[]:q==='button,input,textarea,select'?[element('learning-agent'),element('learning-consent'),element('learning-generate')]:[],
  api:async(url,data)=>{calls.push({url,data});throw Error('missing synthetic reply');},toast:msg=>calls.push({toast:msg}),esc:s=>String(s??'').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c])),icon:()=>'',time:()=>'',json:JSON.stringify,labels:{},assetStatuses:{},resourceEmpty:()=>'',navigate:()=>{},render:()=>{},loadLibrary:async()=>{}});
 context.confirmDialogDiscard=async(_root,_title,message)=>context.confirm(message);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../agent_framework/webui/learning_request.js'),'utf8'),context);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../agent_framework/webui/ontology_save.js'),'utf8'),context);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../agent_framework/webui/learning_review.js'),'utf8'),context);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../agent_framework/webui/learning.js'),'utf8'),context);
 vm.runInContext("renderLearning=()=>{};learningError=message=>{testError=message;};learningUI.workspace='workspace-default';learningDialog.open=true;learningUI.runId='run-test';attachLearningRequest();",context);
 return {nodes,events,calls,storage,context,element,run:s=>vm.runInContext(s,context),get ui(){return vm.runInContext('learningUI',context);},setApi:fn=>context.api=async(url,data)=>{calls.push({url,data});return fn(url,data);}};
}
module.exports={sandbox};
