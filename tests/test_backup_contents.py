"""Backup inspection describes the validated snapshot without starting an app."""
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from agent_framework import backups
from agent_framework.cli import main
from agent_framework.contracts import TaskContract, canonical
from agent_framework.runtime import Runtime
from agent_framework.web import Application
from tests.test_run_catalog import seed_history
from tests.test_workflows import role, definition


class BackupContentsTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='backup-contents-');self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve();self.source=self.root/'source';self.archive=self.root/'backup.zip'
        self.app=Application(self.source);self.addCleanup(self.app.close)

    def inspect(self):
        backups.create_backup(self.source,self.archive)
        return backups.verify_backup(self.archive)['contents']

    def test_counts_distinguish_conversations_turns_and_deleted_drafts(self):
        seed_history(self.app,count=2,turns=3,body_bytes=8)
        agent=role(self.app,'归档岗位');self.app.agents.archive(agent['id'],1)
        workflow=self.app.workflows().save(definition([role(self.app,'流程岗位')]))
        self.app.workflows().start(workflow['id'],{'revision':1})
        draft=self.app.save_task_draft({'revision':0,'draft':{'goal':'已删除的草稿'}})
        self.app.discard_task_draft({'revision':draft['revision']})
        other=Application(self.source,principal='another-user');self.addCleanup(other.close)
        other.save_task_draft({'revision':0,'draft':{'goal':'保留的草稿'}})
        settings=self.app.configuration.get()
        self.app.configuration.save({key:settings[key] for key in ('default_runtime','profiles','revision')})
        report=self.inspect()
        self.assertEqual(report['counts'],{'execution_records':6,'conversations':2,'agents':3,'workspaces':1,
            'workflows':1,'workflow_runs':1,'saved_task_drafts':1,'runtime_configurations':1,'business_drafts':0})
        self.assertEqual(report['version'],1)

    def test_workspace_catalog_includes_all_tenants_and_deleted_spaces(self):
        space=self.app.workspaces.save({'name':'已删除业务空间','business':'业务','scenario':'复盘','description':'不应输出的描述','revision':0})
        self.app.workspaces.lifecycle(space['id'],1,True)
        other=Application(self.source,tenant='another-tenant');self.addCleanup(other.close)
        report=self.inspect();catalog=report['workspaces']
        self.assertEqual(catalog['total'],3);self.assertFalse(catalog['has_more'])
        self.assertEqual([(row['tenant'],row['id']) for row in catalog['items']],sorted((row['tenant'],row['id']) for row in catalog['items']))
        row=next(row for row in catalog['items'] if row['id']==space['id'])
        self.assertEqual(row,{'tenant':self.app.tenant,'id':space['id'],'project_id':space['project_id'],'name':'已删除业务空间','deleted':True})
        self.assertNotIn('不应输出的描述',json.dumps(report,ensure_ascii=False))

    def test_workspace_preview_is_bounded_but_total_remains_complete(self):
        with self.app.control_store.transaction() as db:
            for index in range(105):
                db.execute('INSERT INTO workspaces VALUES(?,?,?,?,?,0,0,0)',
                    (self.app.tenant,f'space-{index:03}',1,canonical({'name':f'空间 {index}','description':'large detail '*1000}),f'project-{index}'))
        report=self.inspect();catalog=report['workspaces']
        self.assertEqual(report['counts']['workspaces'],106);self.assertEqual(catalog['total'],106)
        self.assertEqual(catalog['limit'],100);self.assertEqual(len(catalog['items']),100);self.assertTrue(catalog['has_more'])
        self.assertLess(len(json.dumps(report,ensure_ascii=False)),25000)
        second=backups.verify_backup(self.archive,workspace_offset=catalog['next_offset'])['contents']
        self.assertEqual(second['counts'],report['counts']);self.assertEqual(second['workspaces']['offset'],100)
        self.assertEqual(len(second['workspaces']['items']),6);self.assertFalse(second['workspaces']['has_more'])
        self.assertIsNone(second['workspaces']['next_offset'])
        identities=[(row['tenant'],row['id']) for row in catalog['items']+second['workspaces']['items']]
        self.assertEqual(len(set(identities)),106);self.assertEqual(identities,sorted(identities))

    def test_older_core_only_database_needs_no_catalog_or_configuration_tables(self):
        source=self.root/'core-only';runtime=Runtime(source)
        runtime.submit(TaskContract())
        backups.create_backup(source,self.archive)
        report=backups.verify_backup(self.archive)['contents']
        self.assertEqual(report['counts']['execution_records'],1)
        self.assertTrue(all(value==0 for key,value in report['counts'].items() if key!='execution_records'))
        self.assertEqual(report['workspaces']['items'],[]);self.assertFalse(report['workspaces']['has_more'])

    def test_inspection_reads_frozen_archive_without_creating_or_changing_live_data(self):
        seed_history(self.app,count=1,turns=2,body_bytes=8)
        backups.create_backup(self.source,self.archive)
        digest=hashlib.sha256(self.archive.read_bytes()).hexdigest()
        role(self.app,'备份后新增的岗位')
        before={name:(self.source/name).read_bytes() for name in backups.DATABASES}
        with patch.object(Application,'__init__',side_effect=AssertionError('inspection started an application')):
            report=backups.verify_backup(self.archive)['contents']
        self.assertEqual(report['counts']['agents'],1);self.assertEqual(report['counts']['execution_records'],2)
        self.assertEqual(hashlib.sha256(self.archive.read_bytes()).hexdigest(),digest)
        self.assertEqual(before,{name:(self.source/name).read_bytes() for name in backups.DATABASES})

    def test_cli_returns_counts_and_catalog_without_task_or_configuration_body(self):
        self.app.save_task_draft({'revision':0,'draft':{'goal':'PRIVATE_TASK_BODY'}})
        role(self.app,'PRIVATE_AGENT_NAME')
        backups.create_backup(self.source,self.archive)
        output,error=io.StringIO(),io.StringIO()
        with redirect_stdout(output),redirect_stderr(error):
            status=main(['verify-backup',str(self.archive)])
        self.assertEqual(status,0,error.getvalue());report=json.loads(output.getvalue())
        self.assertTrue(report['valid']);self.assertEqual(report['contents']['counts']['saved_task_drafts'],1)
        self.assertNotIn('PRIVATE_TASK_BODY',output.getvalue());self.assertNotIn('PRIVATE_AGENT_NAME',output.getvalue())
        self.assertEqual(set(report['contents']['workspaces']['items'][0]),{'tenant','id','project_id','name','deleted'})
        output=io.StringIO()
        with redirect_stdout(output):self.assertEqual(main(['verify-backup',str(self.archive),'--workspace-offset','100']),0)
        catalog=json.loads(output.getvalue())['contents']['workspaces']
        self.assertEqual(catalog['items'],[]);self.assertEqual(catalog['total'],1);self.assertIsNone(catalog['next_offset'])

    def test_summary_queries_never_write_to_the_validated_databases(self):
        backups.create_backup(self.source,self.archive)
        connect=backups._connect;writes=[]
        def readonly(path,*args,**kwargs):
            db=connect(path,*args,**kwargs)
            def authorize(action,arg1,arg2,database,trigger):
                if action in {sqlite3.SQLITE_INSERT,sqlite3.SQLITE_UPDATE,sqlite3.SQLITE_DELETE,
                              sqlite3.SQLITE_CREATE_TABLE,sqlite3.SQLITE_DROP_TABLE}:
                    writes.append((action,arg1));return sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_OK
            db.set_authorizer(authorize)
            return db
        with patch.object(backups,'_connect',side_effect=readonly):
            self.assertEqual(backups.verify_backup(self.archive)['contents']['counts']['execution_records'],0)
        self.assertEqual(writes,[])

    def test_invalid_page_offsets_fail_before_reading_or_creating_files(self):
        for offset in (-1,True,1.5,'0',2**63):
            with self.subTest(offset=offset),self.assertRaisesRegex(backups.BackupError,'起始位置'):
                backups.verify_backup(self.archive,workspace_offset=offset)
        self.assertFalse(self.archive.exists())

    def test_unreadable_catalog_cannot_publish_a_backup_or_report_false_success(self):
        with self.app.control_store.transaction() as db:db.execute("UPDATE workspaces SET data='invalid-json'")
        output,error=io.StringIO(),io.StringIO()
        with redirect_stdout(output),redirect_stderr(error):
            status=main(['--data-dir',str(self.source),'backup',str(self.archive)])
        self.assertEqual(status,1);self.assertEqual(output.getvalue(),'')
        self.assertIn('内容摘要无法读取',error.getvalue());self.assertNotIn('Traceback',error.getvalue())
        self.assertFalse(self.archive.exists());self.assertFalse(list(self.root.glob('.agent-backup-*.tmp')))


if __name__=='__main__':unittest.main()
