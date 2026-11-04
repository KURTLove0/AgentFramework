"""Coherent, complete exports never mix checkpoints or overwrite old artifacts."""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from agent_framework import exports
from agent_framework.cli import export_result, main
from agent_framework.contracts import TaskContract, PolicyDenied
from agent_framework.exports import capture_run, verify_export, zip_bundle
from agent_framework.runtime import Runtime
from agent_framework.store import Store
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application
from tests import test_web as web_tests


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='task-exports-',dir='/private/tmp');self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.runtime=Runtime(self.root/'data')
        self.created=self.runtime.submit(TaskContract(execution_mode='direct'),grant=False)
        self.target=self.root/'导出 结果'

    def test_existing_directory_and_old_report_are_never_reused(self):
        self.target.mkdir();old=self.target/'report.md';old.write_text('上一次任务的报告')
        with self.assertRaises(ValueError):export_result(self.runtime,self.created,self.target)
        self.assertEqual(old.read_text(),'上一次任务的报告')
        self.assertEqual(sorted(p.name for p in self.target.iterdir()),['report.md'])

    def test_export_refreshes_passed_state_and_captures_matching_events(self):
        lease=self.runtime.store.acquire(self.created['tenant_id'],self.created['run_id'],3)
        state=self.runtime.store.load(self.created['tenant_id'],self.created['run_id'])
        state['last_error']='最新检查点';self.runtime.checkpoint(state,lease,'export.checkpoint',{'version':1});self.runtime.store.release(state,lease)
        export_result(self.runtime,self.created,self.target)
        result=json.loads((self.target/'result.json').read_text())
        events=[json.loads(line) for line in (self.target/'events.jsonl').read_text().splitlines()]
        self.assertEqual(result['last_error'],'最新检查点')
        self.assertEqual(events[-1]['kind'],'export.checkpoint')

    def test_wal_writer_can_commit_during_export_without_mixing_versions(self):
        store=self.runtime.store;tenant=self.created['tenant_id'];identity=self.created['run_id'];actions=store.actions
        writer=Store(store.path);lease=writer.acquire(tenant,identity,3)
        def write_during_read(state,*,db=None):
            latest=writer.load(tenant,identity);latest['last_error']='新检查点'
            writer.save_context(latest,lease,{'id':'ctx-new','hash':'context-hash','phase':'execute'})
            writer.checkpoint(latest,lease,'export.concurrent',{},action={'logical_id':'a1','status':'PREPARED','tool_ref':'report.draft.create@1.0.0','args':{'idempotency_key':'one'}},evidence={'id':'e1','data':'新证据'})
            writer.release(latest,lease)
            return actions(state,db=db)
        with patch.object(store,'actions',side_effect=write_during_read):snapshot=capture_run(store,tenant,identity)
        self.assertEqual(snapshot['run']['version'],0);self.assertEqual(snapshot['run']['actions'],[]);self.assertEqual(snapshot['evidence'],{});self.assertEqual(snapshot['context_manifests'],[])
        self.assertNotIn('export.concurrent',[event['kind'] for event in snapshot['events']])
        self.assertEqual(writer.load(tenant,identity)['last_error'],'新检查点')
        export_result(self.runtime,self.created,self.target);self.assertTrue(verify_export(self.target)['valid'])

    def test_stop_request_cannot_appear_in_events_without_matching_run_metadata(self):
        store=self.runtime.store;events=store.events;writer=Store(store.path)
        def stop_during_read(tenant,identity,*,db=None):
            writer.request_cancellation(tenant,identity)
            return events(tenant,identity,db=db)
        with patch.object(store,'events',side_effect=stop_during_read):snapshot=capture_run(store,self.created['tenant_id'],self.created['run_id'])
        self.assertIsNone(snapshot['run']['cancellation'])
        self.assertNotIn('run.cancel_requested',[event['kind'] for event in snapshot['events']])
        current=capture_run(store,self.created['tenant_id'],self.created['run_id'])
        self.assertTrue(current['run']['cancellation']['pending']);self.assertIn('run.cancel_requested',[event['kind'] for event in current['events']])

    def test_folder_and_zip_share_a_valid_manifest_and_detect_tampering(self):
        snapshot=capture_run(self.runtime.store,self.created['tenant_id'],self.created['run_id'])
        exports.write_directory(snapshot,self.target);archive=self.root/'bundle.zip';archive.write_bytes(zip_bundle(snapshot))
        self.assertEqual(verify_export(self.target)['manifest'],verify_export(archive)['manifest'])
        self.assertEqual(self.target.stat().st_mode&0o077,0);self.assertEqual((self.target/'result.json').stat().st_mode&0o077,0)
        (self.target/'events.jsonl').write_text('changed')
        with self.assertRaisesRegex(ValueError,'校验失败'):verify_export(self.target)

    def test_file_or_symlink_destination_is_preserved(self):
        occupied=self.root/'existing';occupied.write_text('existing contents')
        for target in (occupied,self.root/'link'):
            if target.name=='link':target.symlink_to(occupied)
            with self.assertRaises(ValueError):export_result(self.runtime,self.created,target)
        self.assertEqual(occupied.read_text(),'existing contents')

    def test_write_failure_cleans_only_the_new_export_folder(self):
        write=exports._write_file
        def fail(path,raw,**kwargs):
            if path.name=='events.jsonl':raise OSError('disk unavailable')
            write(path,raw,**kwargs)
        with patch.object(exports,'_write_file',side_effect=fail),self.assertRaises(OSError):export_result(self.runtime,self.created,self.target)
        self.assertFalse(self.target.exists());self.assertTrue((self.root/'data/runtime.sqlite3').exists())

    def test_real_process_exit_leaves_an_explicitly_incomplete_export(self):
        program='''import os,sys
from agent_framework import exports
from agent_framework.cli import export_result
from agent_framework.runtime import Runtime
runtime=Runtime(sys.argv[1]);run=runtime.store.result('tenant-demo',sys.argv[2]);write=exports._write_file
def exit_during_write(path,raw,**kwargs):
    write(path,raw,**kwargs)
    if path.name=='result.json':os._exit(74)
exports._write_file=exit_during_write
export_result(runtime,run,sys.argv[3])
'''
        process=subprocess.run([sys.executable,'-c',program,str(self.root/'data'),self.created['run_id'],str(self.target)],capture_output=True,text=True,timeout=10)
        self.assertEqual(process.returncode,74,process.stderr);self.assertTrue((self.target/exports.MARKER).exists())
        with self.assertRaisesRegex(ValueError,'未完成'):verify_export(self.target)
        before={item.name:item.read_bytes() for item in self.target.iterdir()}
        with self.assertRaises(ValueError):export_result(self.runtime,self.created,self.target)
        self.assertEqual({item.name:item.read_bytes() for item in self.target.iterdir()},before)

    def test_verifier_rejects_unknown_paths_duplicate_entries_and_missing_files(self):
        snapshot=capture_run(self.runtime.store,self.created['tenant_id'],self.created['run_id']);files=exports.bundle_files(snapshot)
        for name,change in (('path',{'../escape':b'unsafe'}),('missing',None),('marker',{exports.MARKER:b'incomplete'})):
            with self.subTest(name=name):
                target=self.root/(name+'.zip')
                with zipfile.ZipFile(target,'w') as archive:
                    for key,raw in files.items():
                        if change is None and key=='events.jsonl':continue
                        archive.writestr(key,raw)
                    for key,raw in (change or {}).items():archive.writestr(key,raw)
                with self.assertRaises(ValueError):verify_export(target)
        self.assertFalse((self.root/'escape').exists())
        duplicate=self.root/'duplicate.zip'
        with zipfile.ZipFile(duplicate,'w') as archive:
            for key,raw in files.items():archive.writestr(key,raw)
            with self.assertWarns(UserWarning):archive.writestr('result.json',files['result.json'])
        with self.assertRaisesRegex(ValueError,'重复'):verify_export(duplicate)

    def test_cli_verification_is_read_only_and_stopped_task_export_is_successful(self):
        self.runtime.cancel(self.created['run_id'])
        with redirect_stdout(io.StringIO()):status=main(['--data-dir',str(self.root/'data'),'export',self.created['run_id'],str(self.target)])
        self.assertEqual(status,0);self.assertEqual(verify_export(self.target)['manifest']['snapshot']['status'],'CANCELLED')
        unused=self.root/'must-not-exist'
        with patch('agent_framework.cli.Runtime',side_effect=AssertionError('verification initialized runtime')),redirect_stdout(io.StringIO()):
            self.assertEqual(main(['--data-dir',str(unused),'verify-export',str(self.target)]),0)
        self.assertFalse(unused.exists())

    def test_conversation_export_keeps_rows_and_revision_from_the_same_snapshot(self):
        app=Application(self.root/'conversation');self.addCleanup(app.close)
        root=app.create({'start':False,'execution_mode':'direct'})['run'];service=TaskConversations(app);service.register(root)
        other=Application(app.data_dir);self.addCleanup(other.close);projected=service._turn_states;injected=False
        def append_during_read(root_state,rows,db):
            nonlocal injected
            if not injected:
                injected=True
                with patch.object(other,'schedule'):TaskConversations(other).append(root['run_id'],{'content':'新排队消息','request_id':'new-message','revision':1})
            return projected(root_state,rows,db)
        with patch.object(service,'_turn_states',side_effect=append_during_read):view=service.export(root['run_id'])
        self.assertTrue(injected)
        self.assertEqual(view['revision'],1);self.assertEqual(len(view['turns']),1)
        latest=service.export(root['run_id']);self.assertEqual(latest['revision'],2);self.assertEqual(len(latest['turns']),2)

    def test_saved_report_during_stop_is_labeled_as_unfinished(self):
        with patch.object(self.runtime,'cancellation_requested',side_effect=lambda state,**_options:bool(state.get('report'))):
            result=self.runtime.run(self.created['run_id'])
        self.assertEqual(result['status'],'CANCELLED');self.assertTrue(result['report'])
        export_result(self.runtime,result,self.target)
        self.assertTrue(verify_export(self.target)['valid']);text=(self.target/'report.md').read_text()
        self.assertIn('不能作为已完成结果',text);self.assertIn(result['report']['content'],text)

    def test_historical_bundle_verification_does_not_require_the_current_renderer(self):
        result=self.runtime.run(self.created['run_id']);self.assertTrue(result['report'])
        export_result(self.runtime,result,self.target)
        with patch.object(exports,'report_markdown',side_effect=AssertionError('renderer changed after export')):
            self.assertTrue(verify_export(self.target)['valid'])


class ExportHTTPTests(unittest.TestCase):
    setUp=web_tests.HTTPTests.setUp
    tearDown=web_tests.HTTPTests.tearDown
    request=web_tests.HTTPTests.request

    def test_run_bundle_download_contains_the_same_result_and_events(self):
        root=self.app.create({'start':False})['run'];status,headers,raw=self.request('/api/runs/'+root['run_id']+'/download?kind=bundle')
        self.assertEqual(status,200);self.assertEqual(headers['Content-Type'],'application/zip')
        target=Path(self.tmp.name)/'http.zip';target.write_bytes(raw)
        self.assertEqual(verify_export(target)['manifest']['snapshot']['run_id'],root['run_id'])

    def test_bundle_and_conversation_export_keep_existing_scope_guards(self):
        root=self.app.create({'start':False,'execution_mode':'direct'})['run']
        other=Application(self.tmp.name,principal='other-user');self.addCleanup(other.close)
        with self.assertRaises(PolicyDenied):other.run_export(root['run_id'])
        self.server.application=other
        for path in ('/api/runs/'+root['run_id']+'/download?kind=bundle','/api/tasks/'+root['run_id']+'/export?kind=json'):
            self.assertEqual(self.request(path)[0],403)

    def test_conversation_rejects_unknown_format_and_marks_unfinished_content(self):
        root=self.app.create({'start':False,'execution_mode':'direct'})['run'];path='/api/tasks/'+root['run_id']+'/export'
        self.assertEqual(self.request(path+'?kind=unknown')[0],400)
        status,_,raw=self.request(path+'?kind=markdown');self.assertEqual(status,200);self.assertIn('本轮未完成',raw.decode())


if __name__=='__main__':unittest.main()
