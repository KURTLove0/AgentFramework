"""Bounded CLI directory I/O, without model execution or reader threads."""
import json
import subprocess
import sys
import time

from .contracts import canonical
from .process_pipes import ProcessPipes
from .processes import finish_process, stop_process_group


QUERY_TIMEOUT=20
OUTPUT_LIMIT=2*1024*1024


class ModelDiscoveryError(ValueError):
    pass


class DirectoryProcess:
    def __init__(self,command,**kwargs):
        self.command=command;self.options=kwargs
        self.process=None;self.pipes=None;self.size=0;self.ended=set();self.pending=''

    def __enter__(self):
        self.deadline=time.monotonic()+QUERY_TIMEOUT
        self.process=subprocess.Popen(self.command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE,text=True,start_new_session=True,**self.options)
        try:self.pipes=ProcessPipes(self.process,limit=OUTPUT_LIMIT)
        except BaseException:
            finish_process(self.process,self.pipes,sys.exception(),stop=stop_process_group)
            raise
        return self

    def __exit__(self,kind,error,traceback):
        finish_process(self.process,self.pipes,error,stop=stop_process_group)

    def check(self):
        if time.monotonic()>=self.deadline:raise ModelDiscoveryError('模型目录读取超时，请检查 CLI 后重试')
        if self.pipes.input_error:raise ModelDiscoveryError('模型目录查询连接已关闭') from self.pipes.input_error

    def send(self,data):
        self.check();self.pipes.queue_input(canonical(data)+'\n')
        while self.pipes.input:
            self.check();self.pipes.poll(min(.05,max(0,self.deadline-time.monotonic())))
        self.check()

    def receive(self):
        self.check()
        event=self.pipes.receive(min(.05,max(0,self.deadline-time.monotonic())))
        if event is not None:
            label,text=event
            if text is None:self.ended.add(label)
            else:
                self.size+=len(text.encode('utf-8'))
                if self.size>OUTPUT_LIMIT:raise ModelDiscoveryError('CLI 模型目录输出过大，请检查 CLI 后重试')
        return event

    def response(self,identity):
        while True:
            # Check even when notifications or already-buffered lines never stop.
            self.check()
            if '\n' in self.pending:
                line,self.pending=self.pending.split('\n',1)
            elif 'stdout' in self.ended:
                if not self.pending:raise ModelDiscoveryError('模型目录查询提前结束')
                line,self.pending=self.pending,''
            else:
                event=self.receive()
                if event is not None and event[0]=='stdout' and event[1] is not None:self.pending+=event[1]
                continue
            data=json.loads(line)
            if not isinstance(data,dict):raise ModelDiscoveryError('CLI 未返回有效的模型目录')
            if data.get('id') is not None and data.get('method'):
                raise ModelDiscoveryError('模型目录查询返回了非目录操作请求')
            if data.get('id')==identity:
                if 'error' in data:raise ModelDiscoveryError('CLI 拒绝读取模型目录')
                result=data.get('result')
                if not isinstance(result,dict):raise ModelDiscoveryError('CLI 未返回有效的模型目录')
                return result


def run_directory_command(command,**kwargs):
    with DirectoryProcess(command,**kwargs) as session:
        session.pipes.queue_input('',close=True)
        output={'stdout':[],'stderr':[]}
        while len(session.ended)<2 or session.process.poll() is None:
            event=session.receive()
            if event is not None and event[1] is not None:output[event[0]].append(event[1])
        session.check()
        return subprocess.CompletedProcess(command,session.process.returncode,
                                           ''.join(output['stdout']),''.join(output['stderr']))
