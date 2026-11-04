'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const markdownit=require('../agent_framework/webui/markdown-it-15.0.3.min.js'),source=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/reply_markdown.js'),'utf8');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fixture(parser=markdownit){const context=vm.createContext({markdownit:parser,URL,esc,setTimeout,clearTimeout,document:{activeElement:null,addEventListener(){}},navigator:{clipboard:{writeText:async()=>{}}}});vm.runInContext(source,context);return context;}
test('tables preserve cell text, escaped pipes, column alignment and inline code',()=>{
 const html=fixture().renderReplyMarkdown('| 项目 | 数量 | 状态 |\n| :--- | ---: | :---: |\n| A\\|B | 12 | **完成** |\n| `C\\|D` | 8 | <待确认> |');
 assert.match(html,/<table>/);assert.match(html,/scope="col"/);assert.match(html,/text-align:right/);assert.match(html,/text-align:center/);assert.match(html,/A\|B/);assert.match(html,/<code>C\|D<\/code>/);assert.match(html,/&lt;待确认&gt;/);assert.match(html,/tabindex="0"/);
});
test('ordinary pipes and incomplete table separators stay readable until a table exists',()=>{
 const md=fixture();assert(!md.renderReplyMarkdown('管道 A | B\n不是表格').includes('<table>'));assert(!md.renderReplyMarkdown('| A | B |\n|--').includes('<table>'));assert(md.renderReplyMarkdown('| A | B |\n|---|---|\n|1|2|').includes('<table>'));
});
test('headings, nested lists, quoted paragraphs and inline formatting have semantic markup',()=>{
 const html=fixture().renderReplyMarkdown('# 报告\n\n3. 第三步\n   - 子项\n     1. 深一层\n\n> **结论**\n>\n> *限定条件*与~~旧结论~~\n\n---');
 assert.match(html,/<h3>报告<\/h3>/);assert.match(html,/<ol start="3">/);assert.match(html,/<ul>/);assert.match(html,/<blockquote>/);assert.match(html,/<em>限定条件<\/em>/);assert.match(html,/<s>旧结论<\/s>/);assert.match(html,/<hr>/);
});
test('fenced code keeps indentation, literal HTML, inner fences and terminal newlines',()=>{
 const md=fixture(),html=md.renderReplyMarkdown('````html\n  <script>bad()</script>\n```\n\n````');
 assert.match(html,/  &lt;script&gt;bad\(\)&lt;\/script&gt;\n```\n\n<\/code>/);assert(!html.includes('<script>'));assert.match(html,/reply-code-language">html/);assert.match(html,/data-reply-copy-code/);
 const partial=md.renderReplyMarkdown('~~~python\n  print(1)');assert.match(partial,/  print\(1\)<\/code>/);assert.equal((partial.match(/reply-code-block/g)||[]).length,1);
});
test('indented code and unmatched fences produce escaped copyable code without running it',()=>{
 const html=fixture().renderReplyMarkdown('    echo "<img src=x>"\n\n```js\nalert(1)');assert.equal((html.match(/data-reply-copy-code/g)||[]).length,2);assert(!html.includes('<img'));assert.match(html,/alert\(1\)/);
});
test('language info cannot inject attributes or markup',()=>{
 const html=fixture().renderReplyMarkdown('```"><img/src=x/onerror=bad()>\ntext\n```');assert(!html.includes('<img'));assert(!html.includes('onerror='));assert.match(html,/reply-code-language">代码/);
});
test('raw HTML, SVG, forms and scripts remain text',()=>{
 const html=fixture().renderReplyMarkdown('<script>alert(1)</script>\n<svg onload="bad()"></svg>\n<form action="/api/tasks"><input name=x></form>');
 for(const tag of ['script','svg','form','input'])assert(!new RegExp('<'+tag+'(?:\\s|>)').test(html));assert.match(html,/&lt;script&gt;/);
});
test('only absolute HTTP links can navigate and they open isolated from the workbench',()=>{
 const md=fixture();for(const url of ['javascript:alert%281%29','jav&#x61;script:alert%281%29','data:text/html,bad','file:///tmp/x','/api/tasks','//example.com/path','mailto:user@example.com'])assert(!md.renderReplyMarkdown('[link]('+url+')').includes('<a '),url);
 const html=md.renderReplyMarkdown('[资料](https://example.com/a?q=1&b=2) <https://example.com>');assert.equal((html.match(/target="_blank"/g)||[]).length,2);assert.equal((html.match(/rel="noopener noreferrer"/g)||[]).length,2);assert.match(html,/q=1&amp;b=2/);
});
test('images become explicit links with their text instead of making automatic requests',()=>{
 const html=fixture().renderReplyMarkdown('![示意 **说明**](https://example.com/private.png)');assert(!html.includes('<img'));assert.match(html,/图片：示意 说明/);assert.match(html,/href="https:\/\/example.com\/private.png"/);
});
test('reference links and punctuation remain safe without altering code spans',()=>{
 const html=fixture().renderReplyMarkdown('[文档][ref] 与 `**原样** [x](javascript:bad)`\n\n[ref]: https://example.com/a_(b)');assert.match(html,/href="https:\/\/example.com\/a_\(b\)"/);assert.match(html,/<code>\*\*原样\*\* \[x\]\(javascript:bad\)<\/code>/);
});
test('a missing renderer keeps the whole reply readable as escaped text',()=>{
 const html=fixture(null).renderReplyMarkdown('# 标题\n<script>bad</script>');assert.match(html,/reply-plain-fallback/);assert.match(html,/# 标题\n&lt;script&gt;bad&lt;\/script&gt;/);
});
test('long unfinished reference text remains bounded and retains the final user-visible content',{timeout:3000},()=>{
 const html=fixture().renderReplyMarkdown('[unclosed]:\n'.repeat(8000)+'\n保留末尾');assert(html.includes('保留末尾'));assert(html.length<300000);
});
function copyFixture(){
 const c=fixture(),code={textContent:'  print("<value>")\n\n'},status={hidden:true,textContent:''},manual={hidden:true},attrs=new Map(),block={isConnected:true,querySelector:s=>({'pre code':code,'.reply-copy-status':status,'[data-reply-copy-code]':button,'[data-reply-select-code]':manual,'.reply-code-language':{textContent:'python'}}[s]||null)},button={disabled:false,isConnected:true,textContent:'复制代码',closest:()=>block,getAttribute:k=>attrs.get(k),setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k)};return {c,code,status,button,attrs};
}
test('copy captures only the code text once, including whitespace, before awaiting the clipboard',async()=>{
 const {c,code,status,button,attrs}=copyFixture();let finish,calls=0,text;c.navigator.clipboard.writeText=value=>{calls++;text=value;return new Promise(r=>finish=r);};const pending=c.copyReplyCode(button);assert.equal(attrs.get('aria-disabled'),'true');await c.copyReplyCode(button);assert.equal(calls,1);assert.equal(text,code.textContent);assert.equal(attrs.get('aria-busy'),'true');finish();await pending;assert.equal(status.textContent,'代码已复制');assert(!status.hidden);assert(!button.disabled);assert(!attrs.has('aria-busy'));
});
test('clipboard failure gives local recovery without replacing the code',async()=>{
 const {c,code,status,button}=copyFixture();c.navigator.clipboard.writeText=async()=>{throw Error('denied');};await c.copyReplyCode(button);assert.equal(code.textContent,'  print("<value>")\n\n');assert.match(status.textContent,/选中代码/);assert(!button.disabled);
});
test('late clipboard replies never update detached or changed code blocks',async()=>{
 for(const change of [f=>f.button.isConnected=false,f=>f.code.textContent='new content']){const f=copyFixture();let finish;f.c.navigator.clipboard.writeText=()=>new Promise(r=>finish=r);const task=f.c.copyReplyCode(f.button),prior=[f.status.textContent,f.button.textContent];change(f);finish();await task;assert.deepEqual([f.status.textContent,f.button.textContent],prior);}
});
