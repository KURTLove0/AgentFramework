'use strict';
// The pinned parser is shipped locally. Model text never becomes raw HTML.
let replyMarkdownParser=null;
function replyMarkdownEngine(){
 if(replyMarkdownParser)return replyMarkdownParser;
 if(typeof markdownit!=='function')return null;
 const md=markdownit({html:false,breaks:true,linkify:false,typographer:false,maxNesting:24}),escape=md.utils.escapeHtml;
 md.validateLink=url=>{try{if(!/^https?:\/\//i.test(url)||/[\u0000-\u0020\u007f]/.test(url))return false;const parsed=new URL(url);return ['http:','https:'].includes(parsed.protocol)&&!!parsed.hostname;}catch{return false;}};
 md.renderer.rules.link_open=(tokens,i,options,env,self)=>{tokens[i].attrSet('target','_blank');tokens[i].attrSet('rel','noopener noreferrer');return self.renderToken(tokens,i,options);};
 md.renderer.rules.image=(tokens,i,options,env,self)=>{
  const token=tokens[i],label=self.renderInlineAsText(token.children||[],options,env)||'图片',url=token.attrGet('src');
  return md.validateLink(url)?'<a class="reply-image-link" href="'+escape(url)+'" target="_blank" rel="noopener noreferrer">图片：'+escape(label)+'</a>':escape(label);
 };
 for(const type of ['heading_open','heading_close'])md.renderer.rules[type]=(tokens,i,options,env,self)=>{tokens[i].tag='h'+Math.min(6,Number(tokens[i].tag.slice(1))+2);return self.renderToken(tokens,i,options);};
 md.renderer.rules.table_open=(_tokens,_i,_options,env)=>'<div class="reply-table-scroll" data-reply-block="table-'+(env.tableIndex=(env.tableIndex||0)+1)+'" role="region" aria-label="回复中的表格，可横向滚动" tabindex="0"><table>\n';
 md.renderer.rules.table_close=()=>'</table></div>\n';
 md.renderer.rules.th_open=(tokens,i,options,env,self)=>{tokens[i].attrSet('scope','col');return self.renderToken(tokens,i,options);};
 const code=(tokens,i,_options,env)=>{
  const token=tokens[i],info=token.info.trim().split(/\s+/)[0],language=/^[a-zA-Z0-9+#._-]{1,32}$/.test(info)?info:'代码';
  return '<section class="reply-code-block" data-reply-block="code-'+(env.codeIndex=(env.codeIndex||0)+1)+'"><div class="reply-code-header"><span class="reply-code-language">'+escape(language)+'</span><button type="button" class="text-button" data-reply-copy-code aria-label="复制此代码块">复制代码</button></div><pre tabindex="0" aria-label="'+escape(language)+'代码，可横向滚动"><code>'+escape(token.content)+'</code></pre><p class="reply-copy-status" role="status" hidden></p><button type="button" class="text-button reply-select-code" data-reply-select-code hidden>全选代码</button></section>\n';
 };
 md.renderer.rules.fence=code;md.renderer.rules.code_block=code;
 replyMarkdownParser=md;return md;
}
function renderReplyMarkdown(text){
 const md=replyMarkdownEngine(),source=String(text||'');
 // A failed local script load must not hide the actual reply.
 return md?md.render(source,{}):'<pre class="reply-plain-fallback">'+esc(source)+'</pre>';
}
function captureReplyReading(root){
 if(!root?.querySelectorAll)return [];
 return [...root.querySelectorAll('[data-reply-block]')].map(block=>{
  const scroll=block.matches('.reply-code-block')?block.querySelector('pre'):block,active=document.activeElement;
  const code=block.querySelector('code'),selection=typeof document.getSelection==='function'?document.getSelection():null;
  const selected=code?.firstChild&&selection?.rangeCount&&selection.anchorOffset!==selection.focusOffset&&selection.anchorNode===code.firstChild&&selection.focusNode===code.firstChild?[selection.anchorOffset,selection.focusOffset]:null;
  return {key:block.dataset.replyBlock,left:scroll.scrollLeft,top:scroll.scrollTop,text:selected?code.textContent:null,selected,focus:active===block?'region':active===scroll?'code':block.contains(active)&&active?.hasAttribute('data-reply-copy-code')?'copy':block.contains(active)&&active?.hasAttribute('data-reply-select-code')?'select':null};
 });
}
function restoreReplyReading(root,snapshot){
 if(!root?.querySelectorAll)return;
 const previous=new Map(snapshot.map(row=>[row.key,row]));
 for(const block of root.querySelectorAll('[data-reply-block]')){
  if(block.matches('.reply-code-block')){const r=replyCodeCopyState(block);if(r){r.block=block;paintReplyCodeCopy(r);}}
  const prior=previous.get(block.dataset.replyBlock);if(!prior)continue;
  const scroll=block.matches('.reply-code-block')?block.querySelector('pre'):block;
  if(prior.focus){const target=prior.focus==='region'?block:prior.focus==='code'?scroll:block.querySelector(prior.focus==='select'?'[data-reply-select-code]':'[data-reply-copy-code]');if(!target?.hidden)target?.focus({preventScroll:true});}
  const code=block.querySelector('code');
  if(prior.focus&&prior.selected&&code?.firstChild&&code.textContent===prior.text)document.getSelection()?.setBaseAndExtent(code.firstChild,prior.selected[0],code.firstChild,prior.selected[1]);
  scroll.scrollLeft=prior.left;scroll.scrollTop=prior.top;
 }
}
function patchReplyChildren(root,incoming){
 const previous=[...root.childNodes],next=[...incoming.childNodes];
 for(let i=0;i<next.length;i++){
  const old=previous[i],node=next[i];if(!old){root.append(node);continue;}if(old.isEqualNode(node))continue;
  if(old.nodeType!==node.nodeType||old.nodeType===1&&old.tagName!==node.tagName){old.replaceWith(node);continue;}
  if(old.nodeType===3){
   // Replace only the changed span: native ranges retain unchanged prefixes
   // and track suffix offsets without clearing a user's backward selection.
   const a=old.nodeValue,b=node.nodeValue;let start=0,end=0;
   while(start<Math.min(a.length,b.length)&&a[start]===b[start])start++;
   while(end<Math.min(a.length,b.length)-start&&a[a.length-1-end]===b[b.length-1-end])end++;
   old.replaceData(start,a.length-start-end,b.slice(start,b.length-end));continue;
  }
  if(old.nodeType!==1){old.replaceWith(node);continue;}
  if(old.matches('.reply-code-block')||node.matches('.reply-code-block')){
   const same=old.dataset.replyBlock===node.dataset.replyBlock&&old.querySelector('code')?.textContent===node.querySelector('code')?.textContent&&old.querySelector('.reply-code-language')?.textContent===node.querySelector('.reply-code-language')?.textContent;
   if(!same)old.replaceWith(node);continue;
  }
  for(const attribute of [...old.attributes])if(!node.hasAttribute(attribute.name))old.removeAttribute(attribute.name);
  for(const attribute of node.attributes)if(old.getAttribute(attribute.name)!==attribute.value)old.setAttribute(attribute.name,attribute.value);
  patchReplyChildren(old,node);
 }
 for(let i=next.length;i<previous.length;i++)previous[i].remove();
}
function patchReplyMarkdown(root,text){
 const snapshot=captureReplyReading(root),template=document.createElement('template');template.innerHTML=renderReplyMarkdown(text);
 patchReplyChildren(root,template.content);restoreReplyReading(root,snapshot);
}
let replyCodeCopyScopeValue=null,replyCodeAnonymousId=0;
const replyCodeCopies=new Map(),replyCodeAnonymousKeys=new WeakMap();
function replyCodeCopyIdentity(block){
 if(!block)return null;
 const app=typeof state==='undefined'?null:state,c=app?.detail?.conversation,number=Number(block.closest?.('[data-chat-turn]')?.dataset.chatTurn),turn=c?.turns.find(t=>t.number===number);
 if(app&&(!turn||block.closest?.('[data-conversation-id]')?.dataset.conversationId!==c.id))return null;
 if(!app&&!replyCodeAnonymousKeys.has(block))replyCodeAnonymousKeys.set(block,++replyCodeAnonymousId);
 return {scope:JSON.stringify([app?.meta?.tenant,app?.workspaceId,app?.meta?.principal,c?.id,app?.routeVersion]),key:JSON.stringify([number,turn?.run_id,block.dataset?.replyBlock,app?null:replyCodeAnonymousKeys.get(block)])};
}
function replyCodeCopyState(block){
 const identity=replyCodeCopyIdentity(block);if(!identity)return null;
 if(replyCodeCopyScopeValue!==identity.scope){for(const r of replyCodeCopies.values())clearTimeout(r.timer);replyCodeCopies.clear();replyCodeCopyScopeValue=identity.scope;}
 const r=replyCodeCopies.get(identity.key);
 if(r&&(r.text!==block.querySelector('pre code')?.textContent||r.language!==block.querySelector('.reply-code-language')?.textContent)){clearTimeout(r.timer);replyCodeCopies.delete(identity.key);return null;}
 return r||null;
}
function replyCodeCopyCurrent(r){
 const identity=replyCodeCopyIdentity(r.block),code=r.block.querySelector('pre code');
 return replyCodeCopies.get(r.key)===r&&identity?.scope===r.scope&&identity?.key===r.key&&r.block.isConnected&&code?.textContent===r.text&&r.block.querySelector('.reply-code-language')?.textContent===r.language;
}
function paintReplyCodeCopy(r){
 if(!replyCodeCopyCurrent(r))return;
 const button=r.block.querySelector('[data-reply-copy-code]'),status=r.block.querySelector('.reply-copy-status'),manual=r.block.querySelector('[data-reply-select-code]');if(!button?.isConnected||!status||!manual)return;
 button.textContent=r.pending?'正在复制…':r.failed?'重试复制':r.message?'已复制':'复制代码';
 button.setAttribute('aria-label',r.failed?'重试复制此代码块':'复制此代码块');
 for(const name of ['aria-busy','aria-disabled']){if(r.pending)button.setAttribute(name,'true');else button.removeAttribute(name);}
 status.textContent=r.message;status.hidden=!r.message;manual.hidden=!r.manual;
}
function selectReplyCode(button){
 const block=button?.closest('.reply-code-block'),r=replyCodeCopyState(block);if(!button?.isConnected||!r?.manual||!replyCodeCopyCurrent(r))return;
 const code=block.querySelector('pre code'),pre=block.querySelector('pre');pre.focus();
 if(code.firstChild)document.getSelection()?.setBaseAndExtent(code.firstChild,0,code.firstChild,code.textContent.length);
}
async function copyReplyCode(button){
 if(!button?.isConnected||button.disabled)return;
 const block=button.closest('.reply-code-block'),identity=replyCodeCopyIdentity(block),code=block?.querySelector('pre code');if(!identity||!code)return;
 let r=replyCodeCopyState(block);if(r?.pending)return;
 r=r||{...identity,text:code.textContent,language:block.querySelector('.reply-code-language')?.textContent,manual:false};r.block=block;r.pending=true;r.failed=false;r.message='正在复制代码…';replyCodeCopies.set(r.key,r);paintReplyCodeCopy(r);
 r.timer=setTimeout(()=>{if(replyCodeCopyCurrent(r)&&r.pending){r.manual=true;r.message='浏览器尚未确认复制，也可选中代码后手动复制。';paintReplyCodeCopy(r);}},1500);
 try{await navigator.clipboard.writeText(r.text);if(replyCodeCopyCurrent(r))r.message='代码已复制';}
 catch{
  if(replyCodeCopyCurrent(r)){
   r.failed=true;r.manual=true;r.message='自动复制未完成，可重试或选中代码后手动复制。';
   const focused=document.activeElement===r.block.querySelector('[data-reply-copy-code]');paintReplyCodeCopy(r);
   if(focused&&!document.hidden)selectReplyCode(r.block.querySelector('[data-reply-select-code]'));
  }
 }finally{clearTimeout(r.timer);r.pending=false;paintReplyCodeCopy(r);}
}
function resetReplyCodeCopies(){
 for(const r of replyCodeCopies.values()){
  clearTimeout(r.timer);if(replyCodeCopyCurrent(r)){r.pending=false;r.failed=false;r.manual=false;r.message='';paintReplyCodeCopy(r);}
 }
 replyCodeCopies.clear();replyCodeCopyScopeValue=null;
}
function copySelectedReplyCode(event){
 // Native selection text can drop a code block's final LF. Preserve the selected
 // source characters, but leave selections in inputs or other page text alone.
 if(['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)||document.activeElement?.isContentEditable)return;
 const selection=document.getSelection(),node=selection?.anchorNode,block=node?.parentElement?.closest?.('.reply-code-block');
 if(selection?.rangeCount!==1||node!==selection.focusNode||selection.anchorOffset===selection.focusOffset||!block?.isConnected||!replyCodeCopyIdentity(block)||block.querySelector('pre code')?.firstChild!==node||!event.clipboardData)return;
 const start=Math.min(selection.anchorOffset,selection.focusOffset),end=Math.max(selection.anchorOffset,selection.focusOffset);
 try{event.clipboardData.setData('text/plain',node.textContent.slice(start,end));event.preventDefault();}catch{/* Keep the browser's native copy if clipboard event data is unavailable. */}
}
document.addEventListener('click',event=>{const button=event.target.closest('[data-reply-copy-code]');if(button){event.preventDefault();void copyReplyCode(button);}const select=event.target.closest('[data-reply-select-code]');if(select){event.preventDefault();selectReplyCode(select);}});
document.addEventListener('copy',copySelectedReplyCode);
if(typeof window!=='undefined'){window.addEventListener('hashchange',resetReplyCodeCopies);window.addEventListener('pagehide',resetReplyCodeCopies);}
