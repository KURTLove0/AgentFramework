"""Project incomplete model text into public fields; never expose protocol JSON."""
import json
import re
import time

MAX_TEXT=12000


def _string(text,start):
    out=[];n=start+1
    escapes={'n':'\n','r':'\r','t':'\t','b':'\b','f':'\f','"':'"','\\':'\\','/':'/'}
    while n<len(text):
        char=text[n]
        if char=='"':return ''.join(out),n+1,True
        if char=='\\':
            if n+1>=len(text):break
            code=text[n+1]
            if code=='u':
                if n+6>len(text):break
                try:value=int(text[n+2:n+6],16)
                except ValueError:break
                n+=6
                if 0xD800<=value<=0xDBFF:
                    if n+6>len(text) or text[n:n+2]!='\\u':break
                    try:low=int(text[n+2:n+6],16)
                    except ValueError:break
                    if not 0xDC00<=low<=0xDFFF:break
                    value=0x10000+((value-0xD800)<<10)+low-0xDC00;n+=6
                elif 0xDC00<=value<=0xDFFF:break
                out.append(chr(value));continue
            if code not in escapes:break
            out.append(escapes[code]);n+=2;continue
        if ord(char)<32:break
        out.append(char);n+=1
    return ''.join(out),n,False


def public_fields(text):
    """Read only top-level summary and result.content, including incomplete strings."""
    fields={};stack=[];n=0
    while n<len(text):
        char=text[n]
        if char.isspace():n+=1;continue
        frame=stack[-1] if stack else None
        path=frame['path']+(frame['key'],) if frame and frame['state']=='value' else ()
        if char in '{[':
            if frame:
                if frame['state']!='value':break
                frame['state']='after'
            elif n!=len(text)-len(text.lstrip()):break
            stack.append({'path':path,'key':None,'state':'key' if char=='{' else 'value','object':char=='{'});n+=1;continue
        if not frame:break
        if char=='"':
            value,n,closed=_string(text,n)
            if frame['object'] and frame['state']=='key':
                if not closed:break
                frame.update(key=value,state='colon')
            elif frame['state']=='value':
                field={('summary',):'summary',('result','content'):'answer'}.get(path)
                if field:fields[field]=value[:MAX_TEXT]
                frame['state']='after'
            else:break
            if not closed:break
            continue
        if char==':' and frame['state']=='colon':frame['state']='value'
        elif char==',' and frame['state']=='after':frame.update(state='key' if frame['object'] else 'value',key=None)
        elif char in '}]':
            if (char=='}')!=frame['object']:break
            stack.pop()
        elif frame['state']=='value':
            # Non-string primitives cannot contain visible prose.
            while n<len(text) and text[n] not in ',}]':n+=1
            frame['state']='after';continue
        else:break
        n+=1
    return fields


class ReplyStream:
    """Accept deltas or cumulative snapshots, emitting bounded text replacements."""
    def __init__(self,callback,stream_id,clock=time.monotonic):
        self.callback=callback;self.stream_id=stream_id;self.clock=clock
        self.raw='';self.sent={};self.last=0;self.closed=False

    def append(self,text):
        if not isinstance(text,str) or self.closed:return
        self.raw+=text
        if len(self.raw)>1024*1024:self.closed=True;return
        self.flush()

    def snapshot(self,text):
        if not isinstance(text,str) or self.closed:return
        if text==self.raw:return
        self.raw=text[:1024*1024];self.flush(force=True)

    def fields(self):
        value=self.raw.lstrip()
        if not value or value in ('`','``'):return {}
        if value.startswith('```'):
            if '\n' not in value:return {}
            tag,body=value.split('\n',1)
            if tag.strip().lower()=='```json' or tag.strip()=='```' and body.lstrip().startswith(('{','[')):
                value=body.lstrip()
        if value.startswith(('{','[')):return public_fields(value)
        return {'answer':value[:MAX_TEXT]}

    def flush(self,force=False):
        now=self.clock()
        if not force and self.sent and now-self.last<.04:return
        self.last=now
        for field,value in self.fields().items():
            value=re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]','',value)
            if value and self.sent.get(field)!=value:
                self.sent[field]=value
                self.callback({'kind':'summary_text' if field=='summary' else 'answer_text',
                               'text':value,'stream_id':self.stream_id})
