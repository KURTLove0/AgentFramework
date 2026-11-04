"""Bound model history without retaining a second copy of the whole transcript."""
from collections import deque
import hashlib

from .contracts import canonical


SOURCE_UNAVAILABLE='[此前回复的来源已失效，正文未提供给本轮模型。请按当前可用资料重新回答。]'
SOURCE_UNVERIFIABLE='[此前回复的来源已失效或不可核对，正文未加入本轮上下文。请按当前可用资料重新回答。]'
HISTORY_UNVERIFIABLE='[此前回复的历史来源不可核对，正文未加入本轮上下文。请按当前可用资料重新回答。]'


def is_redacted(message):
    return (message.get('role')=='assistant' and message.get('content') in (SOURCE_UNAVAILABLE,SOURCE_UNVERIFIABLE,HISTORY_UNVERIFIABLE)
            and not message.get('citations') and not message.get('source_dependencies'))


def compact_citations(citations):
    """History needs source identity; original quotes remain in the report audit."""
    if not isinstance(citations,list):raise ValueError('invalid history citations')
    result=[];seen=set()
    for citation in citations:
        if not isinstance(citation,dict):raise ValueError('invalid history citation')
        ref=citation['asset_ref'];content_hash=citation['content_hash']
        if not isinstance(ref,str) or not ref or not isinstance(content_hash,str) or not content_hash:
            raise ValueError('invalid history source identity')
        key=(ref,content_hash)
        if key not in seen:
            result.append({'asset_ref':ref,'content_hash':content_hash});seen.add(key)
    return result


class HistoryWindow:
    def __init__(self,max_bytes,max_messages=200):
        if max_bytes<2 or max_messages<0:raise ValueError('invalid history window')
        self.max_bytes=max_bytes;self.max_messages=max_messages
        self.items=deque();self.bytes=0;self.total=0;self.hash=hashlib.sha256(b'[')

    def append(self,message):
        encoded=canonical(message).encode()
        if self.total:self.hash.update(b',')
        self.hash.update(encoded);self.total+=1
        self.items.append((message,len(encoded)));self.bytes+=len(encoded)
        # Include brackets and commas, not just each message's JSON object.
        while self.items and (len(self.items)>self.max_messages or self.bytes+len(self.items)+1>self.max_bytes):
            _,size=self.items.popleft();self.bytes-=size

    def result(self):
        hashed=self.hash.copy();hashed.update(b']')
        return {'messages':[item for item,_ in self.items],'history_hash':hashed.hexdigest(),
                'omitted_messages':self.total-len(self.items)}
