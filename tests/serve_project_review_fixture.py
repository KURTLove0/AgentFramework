"""Isolated project journeys. All model responses are synthetic, data is temporary."""
import json
import os
import tempfile
import time
from unittest.mock import patch

from agent_framework.llm import CodexTransport,CursorTransport,QoderTransport,ModelError
from agent_framework.model_catalog import ModelCatalog
from agent_framework.model_stream import PublicProgress
from agent_framework.web import Application,WebServer


def generate(transport,prompt,schema,config,timeout):
    request=json.loads(prompt[prompt.index('\n{')+1:])
    if 'designer' in request:
        drafts=[dict(id='draft-agent-fixture-analysis',name='资料分析员',description='分析输入，整理事实与待确认事项',prompt='结合任务输入与上游证据，区分事实和推断，交付分析要点。'),
                dict(id='draft-agent-fixture-report',name='报告撰写员',description='根据上游分析形成报告',prompt='依据已验收的分析结果撰写报告，保留证据与限制。')]
        nodes=[dict(id='node-'+str(i+1),name=d['name'],agent_id=d['id'],agent_revision=1,goal=d['description'],depends_on=[] if i==0 else ['node-1']) for i,d in enumerate(drafts)]
        return json.dumps(dict(reply='已自主设计分析与报告智能体，请审查后保存。',workflow=dict(name='自主协作流程',description=request['message'],nodes=nodes,agent_drafts=drafts)),ensure_ascii=False),{}
    if request['phase']!='execute':raise AssertionError('Normal tasks must execute directly')
    task=request['context']['task'];goal=task['goal'];history=task.get('conversation_context') or {}
    progress=PublicProgress('fixture',getattr(transport,'progress',None) or (lambda data:None))
    progress.feed({'type':'turn.started'})
    progress.feed({'type':'reasoning_summary_delta','item_id':'summary','delta':'正在核对任务目标和已提供的资料。'})
    for _ in range(8):
        if callable(getattr(transport,'should_cancel',None)) and transport.should_cancel():raise ModelError('task_cancelled')
        time.sleep(.1)
    if '确认会议时间' in goal and not history.get('messages'):
        value={'kind':'request_input','summary':'会议安排在什么时候？','result':None}
    else:
        content='已完成：'+goal
        if '对话版式验收' in goal or '整理会议纪要' in goal:
            content='## 会议纪要\n\n本次讨论已整理为以下三项行动，便于继续确认与跟进。\n\n### 已确认事项\n\n- **产品方案**：周五前完成第一版，标明已确认内容与待讨论事项。\n- **客户沟通**：先确认问题，再发送简洁的进展说明。\n- **后续安排**：明确负责人、交付时间和完成标准。\n\n### 建议下一步\n\n1. 由各负责人补充尚未确认的信息。\n2. 核对时间安排后，再形成最终版本。\n\n```json\n{"status": "待确认", "owner": "待补充"}\n```\n\n你可以继续补充要求，我会在同一任务中更新这份纪要。'
        if '细节排版验收' in goal:content='# 执行摘要\n\n'+content+'\n\n### 补充说明\n\n请核对尚未确认的信息。'
        if '字体排版验收' in goal:
            content+='\n\n### 中英文长段落\n\n'+('中文正文与 English typography 共用清晰的阅读节奏。API v1.4.0、日期 2026-11-06 与 1,349 项记录需要易于区分；**重要结论**和 *补充说明* 保留原有含义。'*8)
            content+='\n\n#### 标识与数据\n\n长标识：`request-'+('abcdef0123456789'*20)+'`。\n\n| 指标 Metric | 数量 Count | 说明 Notes |\n| --- | ---: | --- |\n| 前端检查 | 1,349 | 仅为排版合成记录 |\n| 窗口宽度 | 1,440 | CSS pixels |\n'
        if history.get('messages'):content+='\n已有对话：'+str(len(history['messages']))+' 条。'
        for item in task.get('workflow_inputs',[]):content+='\n上游结果：'+item['artifact']['content']
        value={'kind':'result','summary':'已按目标整理本轮结果。','result':{'title':'本轮结果','content':content,'citations':[],'limitations':[]}}
    raw=json.dumps(value,ensure_ascii=False)
    progress.feed({'type':'agent_message_delta','item_id':'answer','delta':raw});progress.flush()
    return raw,{'usage':{'input_tokens':30,'output_tokens':20}}


if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='project-review-browser-',dir='/private/tmp')
    catalog={'models':[{'id':'review-model','name':'Review fixture','efforts':['low'],'default_effort':'low'}],'source':'isolated fixture','cached':False}
    with patch.object(ModelCatalog,'list',return_value=catalog),patch.object(CodexTransport,'generate',generate),patch.object(CursorTransport,'generate',generate),patch.object(QoderTransport,'generate',generate):
        app=Application(root);server=WebServer(('127.0.0.1',int(os.environ.get('PROJECT_REVIEW_PORT','8799'))),app)
        print('Isolated data: '+root,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()
