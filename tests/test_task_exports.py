"""Complete task bundles preserve one snapshot, all edits and scoped executions."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from agent_framework import exports,task_exports
from agent_framework.contracts import PolicyDenied,canonical
from agent_framework.store import Store
from agent_framework.task_conversations import TaskConversations
from agent_framework.task_message_edits import update
from agent_framework.web import Application
from tests.test_run_catalog import seed_history
from tests import test_web as fixtures


class TaskExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.root=seed_history(self.app,count=1,turns=2,body_bytes=20)[0];self.service=TaskConversations(self.app)
        self.dispatch=patch.object(TaskConversations,'dispatch',return_value=False);self.dispatch.start();self.addCleanup(self.dispatch.stop)
        for number in (3,4):self.service.append(self.root,{'content':'排队 '+str(number),'request_id':'new-'+str(number),'revision':number-1})
        for n in range(2):update(self.app,self.root,3,{'content':'修改 '+str(n+1)+'\n😀 <img src=x>','revision':n,'request_id':'edit-'+str(n)})
        self.service.cancel_queued(self.root,4,{'revision':6})

    def files(self):return task_exports.bundle_files(self.app,self.root)

    def archive(self,files):
        target=Path(self.tmp.name)/'task.zip'
        with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED) as z:
            for name,raw in files.items():z.writestr(name,raw)
        return target

    def changed(self,files,name,change,*,jsonl=False):
        files=dict(files);value=[json.loads(line) for line in files[name].splitlines()] if jsonl else json.loads(files[name]);change(value)
        files[name]=b''.join(task_exports._line(row) for row in value) if jsonl else exports._json(value)
        m=json.loads(files['manifest.json']);m['files'][name].update(bytes=len(files[name]),sha256=hashlib.sha256(files[name]).hexdigest())
        for human,source in (('conversation.md','conversation.json'),('edit-history.md','edit-history.jsonl')):
            if source==name:m['files'][human]['source_sha256']=hashlib.sha256(files[name]).hexdigest()
        files['manifest.json']=exports._json(m);return files

    def test_bundle_contains_all_turns_edits_and_only_materialized_runs(self):
        files=self.files();view=json.loads(files['conversation.json']);manifest=json.loads(files['manifest.json'])
        self.assertEqual(set(files),exports.TASK_REQUIRED|{'manifest.json'})
        self.assertEqual(manifest['snapshot'],{'task_id':self.root,'conversation_revision':7,'status':'QUEUED','turn_count':4,'run_count':2,'edit_count':2})
        runs=[json.loads(row) for row in files['runs.jsonl'].splitlines()];edits=[json.loads(row) for row in files['edit-history.jsonl'].splitlines()]
        self.assertEqual([r['turn'] for r in runs],[1,2]);self.assertEqual(edits[0]['before'],'排队 3');self.assertEqual(edits[1]['after'],view['turns'][2]['content'])
        self.assertEqual(view['turns'][3]['status'],'CANCELLED');self.assertEqual(view['turns'][3]['checkpoint_version'],None)
        self.assertTrue(all(r['captured_at']==manifest['captured_at'] for r in runs));self.assertIn('    😀 <img src=x>',files['edit-history.md'].decode())
        self.assertTrue(exports.verify_export(self.archive(files))['valid'])
        directory=Path(self.tmp.name)/'unpacked';directory.mkdir()
        for name,raw in files.items():(directory/name).write_bytes(raw)
        self.assertEqual(exports.verify_export(directory)['manifest'],manifest)

    def test_child_identity_normalizes_to_whole_task(self):
        files=task_exports.bundle_files(self.app,self.root+'-turn-2')
        self.assertEqual(json.loads(files['manifest.json'])['snapshot']['task_id'],self.root)
        self.assertEqual(len(json.loads(files['conversation.json'])['turns']),4)

    def test_edit_and_checkpoint_committed_during_capture_do_not_mix(self):
        store=self.app.control_store;writer=Store(store.path);other=Application(self.tmp.name);self.addCleanup(other.close)
        events=store.events;fired=[];before_events=events(self.app.tenant,self.root)
        def concurrent(tenant,identity,*,db=None):
            if not fired:
                fired.append(True);update(other,self.root,3,{'content':'稍后保存的修改','revision':2,'request_id':'concurrent'})
                lease=writer.acquire(tenant,self.root,3);run=writer.load(tenant,self.root);run['report']['content']='稍后保存的回复'
                writer.checkpoint(run,lease,'export.concurrent',{});writer.release(run,lease)
            return events(tenant,identity,db=db)
        with patch.object(store,'events',side_effect=concurrent):files=task_exports.bundle_files(self.app,self.root,store=store)
        self.assertTrue(fired);self.assertTrue(exports.verify_export(self.archive(files))['valid'])
        view=json.loads(files['conversation.json']);runs=[json.loads(line) for line in files['runs.jsonl'].splitlines()]
        self.assertEqual(view['revision'],7);self.assertEqual(view['turns'][2]['edit_revision'],2)
        self.assertEqual(runs[0]['run']['version'],1);self.assertEqual(runs[0]['events'],before_events)
        latest=self.files();self.assertTrue(exports.verify_export(self.archive(latest))['valid'])
        new=json.loads(latest['conversation.json']);self.assertEqual(new['revision'],8);self.assertEqual(new['turns'][2]['content'],'稍后保存的修改');self.assertEqual(new['turns'][0]['reply']['content'],'稍后保存的回复')

    def test_export_performs_no_dispatch_registration_or_detail_read(self):
        with patch.object(self.app,'detail',side_effect=AssertionError('live detail')),patch.object(TaskConversations,'register',side_effect=AssertionError('write')):
            self.dispatch.stop()
            with patch.object(TaskConversations,'dispatch',side_effect=AssertionError('dispatch')):self.files()

    def test_principal_tenant_and_workspace_are_enforced(self):
        for options in ({'principal':'other-person'},{'tenant':'other-tenant'}):
            with self.subTest(options=options):
                try:other=Application(self.tmp.name,**options)
                except (KeyError,ValueError):continue
                self.addCleanup(other.close)
                with self.assertRaises((KeyError,PolicyDenied)):task_exports.bundle_files(other,self.root)
        space=self.app.workspaces.save({'name':'其他空间','business':'验证','scenario':'记录','description':'','revision':0})
        with self.assertRaises((KeyError,PolicyDenied)):task_exports.bundle_files(self.app.scoped(space['id']),self.root)

    def test_foreign_child_is_rejected_before_bundle_is_returned(self):
        store=self.app.control_store;run=store.load(self.app.tenant,self.root+'-turn-2');run['task']['principal']='foreign'
        with store.transaction() as db:db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(run),self.app.tenant,run['run_id']))
        with self.assertRaises(PolicyDenied):self.files()

    def test_names_archives_and_favorite_audits_keep_saved_execution_unchanged(self):
        from agent_framework import task_archive,task_favorites,task_names
        self.service.cancel_queued(self.root,3,{'revision':7})
        task_names.update(self.app,self.root,{'name':'交付记录','revision':0})
        task_favorites.update(self.app,self.root,{'favorited':True,'revision':0})
        current=task_archive.inspect(self.app,self.root)['detail']['conversation']['archive']
        task_archive.update(self.app,self.root,{'archived':True,'revision':current['revision']})
        files=self.files();view=json.loads(files['conversation.json'])
        self.assertEqual(view['task_name']['name'],'交付记录');self.assertTrue(view['archive']['archived']);self.assertNotIn('task_favorite',view)
        self.assertTrue(exports.verify_export(self.archive(files))['valid'])

    def test_stop_request_remains_distinct_from_persisted_run_status(self):
        run=self.app.create({'start':False,'execution_mode':'direct'})['run'];self.app.control_store.request_cancellation(self.app.tenant,run['run_id'])
        files=task_exports.bundle_files(self.app,run['run_id']);view=json.loads(files['conversation.json']);record=json.loads(files['runs.jsonl'])
        self.assertEqual(view['status'],'CANCELLING');self.assertEqual(record['run']['status'],'CREATED');self.assertTrue(record['run']['cancellation']['pending'])
        self.assertTrue(exports.verify_export(self.archive(files))['valid'])

    def test_legacy_root_without_edit_table_exports_without_migration(self):
        root=self.app.create({'start':False,'execution_mode':'direct'})['run']['run_id'];store=self.app.control_store
        with store.transaction() as db:db.execute('DROP TABLE task_message_edits')
        self.app.close();store=Store(store.path,read_only=True)
        with patch.object(TaskConversations,'register',side_effect=AssertionError('registration')):files=task_exports.bundle_files(self.app,root,store=store)
        self.assertEqual(files['edit-history.jsonl'],b'');self.assertEqual(len(json.loads(files['conversation.json'])['turns']),1)
        self.assertTrue(exports.verify_export(self.archive(files))['valid'])
        with store.connect() as db:self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='task_message_edits'").fetchone())

    def test_size_limit_prevents_partial_or_oversized_delivery(self):
        with patch.object(exports,'MAX_BYTES',100),patch.object(zipfile,'ZipFile',side_effect=AssertionError('started ZIP too early')):
            with self.assertRaisesRegex(exports.ExportError,'超过'):task_exports.zip_bundle(self.app,self.root)

    def test_tampered_payload_fails_even_when_parseable(self):
        files=self.files();files['conversation.md']+=b'changed'
        with self.assertRaisesRegex(exports.ExportError,'校验失败'):exports.verify_export(self.archive(files))

    def test_rehashed_invalid_runs_and_events_are_rejected(self):
        files=self.files()
        changes=[lambda rows:rows.pop(),lambda rows:rows.append(deepcopy(rows[0])),lambda rows:rows.reverse(),
                 lambda rows:rows[0]['run']['task'].update(principal='foreign'),lambda rows:rows[0]['run'].update(version=99),
                 lambda rows:rows[0]['events'][1].update(seq=99),lambda rows:rows[1]['run']['task']['conversation_context'].update(turn=99),
                 lambda rows:rows[0].update(captured_at=0),lambda rows:rows[0].update(evidence=[])]
        for change in changes:
            with self.subTest(change=change),self.assertRaises(exports.ExportError):exports.verify_export(self.archive(self.changed(files,'runs.jsonl',change,jsonl=True)))

    def test_rehashed_broken_edit_chains_and_boundaries_are_rejected(self):
        files=self.files()
        for change in (lambda rows:rows.pop(),lambda rows:rows.reverse(),lambda rows:rows[1].update(before='断裂'),lambda rows:rows[1].update(after='不同'),lambda rows:rows[0].update(turn=1),lambda rows:rows[0].update(saved_at=True)):
            with self.subTest(change=change),self.assertRaises(exports.ExportError):exports.verify_export(self.archive(self.changed(files,'edit-history.jsonl',change,jsonl=True)))
        for change in (lambda v:v.update(snapshot_format=True),lambda v:v['turns'][0].update(number=True),lambda v:v['turns'][0].update(checkpoint_version=None),lambda v:v['export_scope'].update(workspace_id='other'),lambda v:v['turns'][2].update(content='different')):
            with self.subTest(change=change),self.assertRaises(exports.ExportError):exports.verify_export(self.archive(self.changed(files,'conversation.json',change)))

    def test_manifest_counts_and_document_source_hash_are_verified(self):
        original=self.files()
        for change in (lambda m:m['snapshot'].update(turn_count=3),lambda m:m['snapshot'].update(run_count=True),lambda m:m['files']['conversation.md'].update(source_sha256='0'*64),lambda m:m['files']['edit-history.md'].pop('source_sha256')):
            files=dict(original);manifest=json.loads(files['manifest.json']);change(manifest);files['manifest.json']=exports._json(manifest)
            with self.assertRaises(exports.ExportError):exports.verify_export(self.archive(files))

    def test_historical_markdown_can_verify_after_renderers_change(self):
        path=self.archive(self.files())
        with patch.object(exports,'conversation_markdown',side_effect=AssertionError('renderer')),patch.object(task_exports,'edit_markdown',side_effect=AssertionError('renderer')):
            self.assertTrue(exports.verify_export(path)['valid'])

    def test_mixed_and_unknown_files_are_rejected_before_payload_read(self):
        original=self.files()
        for name in ('../escape','result.json','extra.txt'):
            files={**original,name:b'unsafe'};path=self.archive(files)
            with patch.object(zipfile.ZipFile,'open',side_effect=AssertionError('payload opened')),self.assertRaises(exports.ExportError):exports.verify_export(path)
        files=dict(original);manifest=json.loads(files['manifest.json']);manifest['format']=exports.FORMAT;files['manifest.json']=exports._json(manifest);path=self.archive(files);opened=[];real=zipfile.ZipFile.open
        def reading(archive,name,*args,**kwargs):opened.append(name);return real(archive,name,*args,**kwargs)
        with patch.object(zipfile.ZipFile,'open',reading),self.assertRaises(exports.ExportError):exports.verify_export(path)
        self.assertEqual(opened,['manifest.json'])

    def test_cli_verifies_complete_task_without_initializing_runtime(self):
        path=self.archive(self.files());unused=Path(self.tmp.name)/'unused'
        command=[sys.executable,'-m','agent_framework','--data-dir',str(unused),'verify-export',str(path)]
        result=subprocess.run(command,capture_output=True,text=True,timeout=10);self.assertEqual(result.returncode,0,result.stderr);self.assertTrue(json.loads(result.stdout)['valid']);self.assertFalse(unused.exists())
        path.write_bytes(b'broken');result=subprocess.run(command,capture_output=True,text=True,timeout=10)
        self.assertNotEqual(result.returncode,0);self.assertNotIn('Traceback',result.stderr);self.assertFalse(unused.exists())


class TaskExportHTTPTests(unittest.TestCase):
    setUp=fixtures.HTTPTests.setUp
    tearDown=fixtures.HTTPTests.tearDown
    request=fixtures.HTTPTests.request

    def test_scoped_read_only_zip_route_and_static_script(self):
        root=seed_history(self.app,count=1,turns=2,body_bytes=5)[0];before=self.app.control_store.load(self.app.tenant,root)
        with patch.object(self.app,'detail',side_effect=AssertionError('live detail')):
            status,headers,raw=self.request('/api/tasks/'+root+'-turn-2/export?kind=bundle')
        self.assertEqual(status,200);self.assertEqual(headers['Content-Type'],'application/zip');self.assertIn('attachment;',headers['Content-Disposition']);self.assertIn(root+'-task-export.zip',headers['Content-Disposition']);self.assertIn('no-store',headers['Cache-Control'])
        path=Path(self.tmp.name)/'http.zip';path.write_bytes(raw);self.assertEqual(exports.verify_export(path)['manifest']['snapshot']['run_count'],2)
        self.assertEqual(self.app.control_store.load(self.app.tenant,root),before)
        self.assertEqual(self.request('/task_export.js')[0],200)
        other=Application(self.tmp.name,principal='different');self.addCleanup(other.close);self.server.application=other
        self.assertEqual(self.request('/api/tasks/'+root+'/export?kind=bundle')[0],403)


if __name__=='__main__':unittest.main()
