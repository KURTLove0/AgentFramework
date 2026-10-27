"""Bounded CLI stream collection and public progress, never private reasoning."""
import io
import json
import os
import queue
import re
import signal
import subprocess
import threading
import time

from .agent_extensions import allowed_mcp_call
from .model_output_stream import ReplyStream

LIMIT=8*1024*1024

class PublicProgress:
    def __init__(self,provider,callback,profile=None):
        self.provider=provider;self.callback=callback;self.profile=profile;self.seen=set();self.count=0
        self.streams={};self.summaries={};self.message_id='assistant';self.blocks={};self.cursor_partial=False
    def text(self,text,identity='answer',delta=False):
        if identity not in self.streams:
            if len(self.streams)>=32:return
            self.streams[identity]=ReplyStream(lambda data:self.callback({**data,'source':self.provider}),identity)
        stream=self.streams[identity]
        if delta:stream.append(text)
        else:stream.snapshot(text)
    def summary(self,text,identity,delta=False):
        if not isinstance(text,str):return
        value=(self.summaries.get(identity,'')+text if delta else text)[:12000]
        if value and value!=self.summaries.get(identity):
            self.summaries[identity]=value
            self.callback({'kind':'summary_text','text':value,'stream_id':identity,'source':self.provider})
    def flush(self):
        for stream in self.streams.values():stream.flush(force=True)
    def emit(self,kind,text):
        if not isinstance(text,str):return
        text=re.sub(r'[\x00-\x08\x0b-\x1f\x7f]','',text).strip()[:12000]
        key=(kind,text)
        if not text or key in self.seen or self.count>=64:return
        self.seen.add(key);self.count+=1
        self.callback({'kind':kind,'text':text,'source':self.provider})
    def message(self,text,identity='answer'):
        # Structured responses appear as the result, not as protocol JSON in the UI.
        if not isinstance(text,str):return
        self.text(text,identity)
        value=text.strip()
        if value.startswith(('{','[','```')):
            try:body=json.loads(value)
            except (ValueError,TypeError):return
            if isinstance(body,dict) and body.get('kind') in ('result','request_input'):
                if isinstance(body.get('summary'),str):self.emit('summary',body['summary'])
            return
        self.emit('message',text)
    def feed(self,event):
        if not isinstance(event,dict):return
        kind=event.get('type')
        if kind=='stream_event':
            part=event.get('event',{});delta=part.get('delta',{});index=part.get('index',0)
            if part.get('type')=='message_start':self.message_id=part.get('message',{}).get('id','assistant');self.blocks={}
            identity=self.message_id+':'+str(index)
            if part.get('type')=='content_block_start':
                block=part.get('content_block',{});self.blocks[index]=block.get('type')
                if block.get('type')=='text':self.text(block.get('text',''),identity,delta=True)
            elif part.get('type')=='content_block_delta':
                if delta.get('type')=='text_delta' and self.blocks.get(index,'text')=='text':self.text(delta.get('text',''),identity,delta=True)
                elif delta.get('type')=='summary_text_delta':self.summary(delta.get('text'),identity,delta=True)
            elif part.get('type') in ('content_block_stop','message_stop'):self.flush()
            return
        if kind=='agent_message_delta':self.text(event.get('delta'),event.get('item_id','answer'),delta=True);return
        if kind=='reasoning_summary_delta':self.summary(event.get('delta'),event.get('item_id','summary'),delta=True);return
        if kind in ('thread.started','turn.started') or (kind=='system' and event.get('subtype')=='init'):
            self.emit('status','运行时已连接，模型正在处理任务。')
        if kind=='thinking':
            self.emit('status','模型正在处理任务。');return
        if kind in ('reasoning_summary','reasoning.summary'):
            self.emit('summary',event.get('summary'));return
        if kind in ('item.started','item.updated','item.completed'):
            item=event.get('item',{});itype=item.get('type')
            if itype=='reasoning':
                # Some runtimes expose summary_text separately. Raw text is private.
                for part in item.get('summary',[]) if isinstance(item.get('summary'),list) else []:
                    if isinstance(part,dict) and part.get('type')=='summary_text':self.emit('summary',part.get('text'))
                if kind!='item.completed':self.emit('status','模型正在处理任务。')
            elif itype=='agent_message':self.message(item.get('text'),item.get('id','answer'))
            elif itype=='mcp_tool_call' and allowed_mcp_call(item,self.profile):
                self.emit('tool','已完成受控读取。' if kind=='item.completed' else '正在调用已配置的读取工具。')
        if kind=='tool_call' and allowed_mcp_call(event,self.profile,cursor=True):
            self.emit('tool','已完成受控读取。' if event.get('subtype')=='completed' else '正在调用已配置的读取工具。')
        if kind=='assistant':
            message=event.get('message',{});content=message.get('content',[]) if isinstance(message,dict) else []
            if isinstance(content,str):self.message(content,event.get('uuid','answer'))
            elif isinstance(content,list):
                for index,block in enumerate(content):
                    if not isinstance(block,dict):continue
                    if block.get('type')=='text':
                        identity=str(message.get('id') or self.message_id)+':'+str(index)
                        if self.provider=='cursor' and event.get('timestamp_ms') is not None:
                            self.cursor_partial=True
                            # Buffered pre-tool flushes contain model_call_id;
                            # they repeat the deltas already delivered.
                            if not event.get('model_call_id'):self.text(block.get('text'),identity,delta=True)
                        elif not (self.provider=='cursor' and self.cursor_partial):self.message(block.get('text'),identity)
                    elif block.get('type') in ('thinking','reasoning'):
                        self.emit('status','模型正在处理任务。')
                    elif block.get('type')=='tool_use':
                        name=block.get('name');allowed={f"mcp__{s['name']}__{t}" for s in (self.profile or {}).get('mcp_servers',[]) if s.get('enabled') for t in s.get('tools',[])}
                        if name in allowed:self.emit('tool','正在调用已配置的读取工具。')
        if kind in ('turn.completed','result') and event.get('is_error') is not True:
            if kind=='result' and isinstance(event.get('result'),str):self.text(event['result'],'final')
            self.flush()
            self.emit('status','模型已返回输出，正在保存结果。')


def collect(process,prompt,timeout,provider,callback=None,profile=None,cancel=None):
    """Drain both pipes while the child is running; bound memory and terminate on error."""
    if callback is None or not isinstance(getattr(process,'stdout',None),io.TextIOBase):
        return process.communicate(prompt,timeout=timeout)
    from .llm import ModelError
    events=queue.Queue(maxsize=64);stop=threading.Event();readers=[]
    def put(item):
        while not stop.is_set():
            try:events.put(item,timeout=.1);return
            except queue.Full:pass
    def read(name,pipe):
        try:
            while not stop.is_set():
                chunk=pipe.readline(65536)
                if not chunk:break
                put((name,chunk))
        except (OSError,ValueError):pass
        finally:put((name,None))
    def write():
        try:process.stdin.write(prompt);process.stdin.flush();process.stdin.close()
        except (OSError,ValueError):pass
    deadline=time.monotonic()+timeout;stdout=[];stderr=[];size=0;error_size=0;done=set();pending=''
    progress=PublicProgress(provider,callback,profile)
    for name in ('stdout','stderr'):
        thread=threading.Thread(target=read,args=(name,getattr(process,name)),daemon=True);thread.start();readers.append(thread)
    writer=threading.Thread(target=write,daemon=True);writer.start()
    try:
        while len(done)<2 or process.poll() is None:
            if callable(cancel) and cancel():raise ModelError('task_cancelled')
            if time.monotonic()>=deadline:raise ModelError('model_timeout')
            try:name,chunk=events.get(timeout=min(.1,max(.001,deadline-time.monotonic())))
            except queue.Empty:progress.flush();continue
            if chunk is None:done.add(name);continue
            if name=='stderr':
                error_size+=len(chunk.encode())
                if error_size<=65536:stderr.append(chunk)
                continue
            size+=len(chunk.encode())
            if size>LIMIT:raise ModelError('invalid_model_envelope')
            stdout.append(chunk);pending+=chunk
            while '\n' in pending:
                line,pending=pending.split('\n',1)
                try:event=json.loads(line)
                except ValueError:continue
                progress.feed(event)
        if pending:
            try:progress.feed(json.loads(pending))
            except ValueError:pass
        progress.flush()
        try:process.wait(timeout=max(.001,deadline-time.monotonic()))
        except subprocess.TimeoutExpired as exc:raise ModelError('model_timeout') from exc
        return ''.join(stdout),''.join(stderr)
    finally:
        stop.set()
        if process.poll() is None:
            try:os.killpg(process.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            try:process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                try:os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                process.wait(timeout=1)
        for thread in readers:thread.join(timeout=1)
        writer.join(timeout=1)
        for pipe in (process.stdin,process.stdout,process.stderr):
            try:pipe.close()
            except (OSError,ValueError):pass
