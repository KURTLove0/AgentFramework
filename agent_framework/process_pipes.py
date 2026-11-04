"""Bounded, nonblocking subprocess pipes owned by the execution thread."""
from collections import deque
import codecs
import io
import os
import selectors


class ProcessPipes:
    def __init__(self,process,limit=8*1024*1024):
        self.process=process;self.limit=limit;self.events=deque();self.buffered=0
        self.input=deque();self.input_error=None;self.close_input=False
        self.selector=selectors.DefaultSelector();self.decoders={}
        try:
            for label in ('stdin','stdout','stderr'):
                pipe=getattr(process,label);os.set_blocking(pipe.fileno(),False)
                if label!='stdin':
                    decoder=codecs.getincrementaldecoder(pipe.encoding or 'utf-8')(errors=pipe.errors or 'strict')
                    self.decoders[label]=io.IncrementalNewlineDecoder(decoder,translate=True)
                    self.selector.register(pipe,selectors.EVENT_READ,label)
        except BaseException:
            self.selector.close();raise

    def queue_input(self,text,*,close=False):
        pipe=self.process.stdin
        if pipe.closed:raise BrokenPipeError('model stdin closed')
        data=text.encode(pipe.encoding or 'utf-8',errors=pipe.errors or 'strict')
        if data:self.input.append(memoryview(data))
        self.close_input=close
        if self.input:
            try:self.selector.get_key(pipe)
            except KeyError:self.selector.register(pipe,selectors.EVENT_WRITE,'stdin')
        elif close:pipe.close()

    def _stop_input(self):
        try:self.selector.unregister(self.process.stdin)
        except KeyError:pass
        self.input.clear()
        if self.close_input:self.process.stdin.close()

    def _event(self,label,text,size):
        self.buffered+=size
        if self.buffered>self.limit:
            from .llm import ModelError
            raise ModelError('invalid_model_envelope')
        if text or text is None or size:self.events.append((label,text,size))

    def poll(self,timeout):
        for key,_ in self.selector.select(timeout):
            pipe,label=key.fileobj,key.data
            if label=='stdin':
                try:written=os.write(pipe.fileno(),self.input[0][:65536])
                except BlockingIOError:continue
                except OSError as exc:self.input_error=exc;self._stop_input();continue
                self.input[0]=self.input[0][written:]
                if not self.input[0]:self.input.popleft()
                if not self.input:self._stop_input()
                continue
            try:data=os.read(pipe.fileno(),65536)
            except BlockingIOError:continue
            if not data:self.selector.unregister(pipe)
            try:text=self.decoders[label].decode(data,final=not data)
            except UnicodeError as exc:
                from .llm import ModelError
                raise ModelError('invalid_model_envelope') from exc
            self._event(label,text,len(data))
            if not data:self._event(label,None,0)

    def receive(self,timeout):
        if not self.events:self.poll(timeout)
        if not self.events:return None
        label,text,size=self.events.popleft();self.buffered-=size
        return label,text

    def close(self):
        errors=[]
        try:self.selector.close()
        except Exception as exc:errors.append(exc)
        for pipe in (self.process.stdin,self.process.stdout,self.process.stderr):
            try:pipe.close()
            except Exception as exc:errors.append(exc)
        self.input.clear();self.events.clear();self.buffered=0
        if errors:raise errors[0]
