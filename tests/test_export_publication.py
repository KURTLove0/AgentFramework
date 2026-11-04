"""Published exports remain intact; verification rejects metadata before payload IO."""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from agent_framework import exports
from agent_framework.contracts import TaskContract
from agent_framework.runtime import Runtime


def sync_phase(path,target):
    path=Path(path)
    if path==target:
        if not (target/exports.MARKER).exists():return 'marker-removal'
        return 'data-entries' if (target/'manifest.json').exists() else 'marker-entry'
    if path==target.parent:
        if not target.exists():return 'parent-ready'
        return 'destination-entry' if (target/'manifest.json').exists() else 'target-entry'
    return 'ancestor'


PHASES=('parent-ready','marker-entry','target-entry','data-entries','destination-entry','marker-removal')


class ExportPublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        runtime = Runtime(self.root / 'source')
        run = runtime.submit(TaskContract(execution_mode='direct'), grant=False)
        self.snapshot = exports.capture_run(runtime.store, run['tenant_id'], run['run_id'])
        self.target = self.root / '导出 文件'

    def archive(self, *, extra=None, symlink=False):
        target = self.root / 'bundle.zip'
        with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, raw in exports.bundle_files(self.snapshot).items():
                if symlink and name == 'result.json':
                    info = zipfile.ZipInfo(name)
                    info.create_system = 3
                    info.external_attr = (stat.S_IFLNK | 0o777) << 16
                    archive.writestr(info, raw)
                else:
                    archive.writestr(name, raw)
            if extra:
                archive.writestr(*extra)
        return target

    def test_failed_export_preserves_files_added_by_another_writer(self):
        write = exports._write_file
        def fail(path, raw, **kwargs):
            if path.name == 'events.jsonl':
                (self.target / 'keep.txt').write_text('not created by the exporter')
                raise OSError('injected write failure')
            return write(path, raw, **kwargs)
        with patch.object(exports, '_write_file', side_effect=fail), self.assertRaises(OSError):
            exports.write_directory(self.snapshot, self.target)
        self.assertTrue((self.target / 'keep.txt').is_file())
        self.assertEqual((self.target / 'keep.txt').read_text(), 'not created by the exporter')

    def test_error_after_completion_marker_removal_does_not_delete_complete_export(self):
        unlink = Path.unlink
        def fail(path, *args, **kwargs):
            result = unlink(path, *args, **kwargs)
            if path == self.target / exports.MARKER:
                raise OSError('injected marker retirement failure')
            return result
        with patch.object(Path, 'unlink', fail), self.assertRaises(OSError):
            exports.write_directory(self.snapshot, self.target)
        self.assertTrue(self.target.is_dir())
        self.assertTrue(exports.verify_export(self.target)['valid'])

    def test_directory_entries_are_synced_before_success(self):
        sync = os.fsync
        seen = set()
        def observe(fd):
            info = os.fstat(fd)
            if stat.S_ISDIR(info.st_mode):
                seen.add(info.st_ino)
            return sync(fd)
        with patch.object(exports.os, 'fsync', side_effect=observe):
            exports.write_directory(self.snapshot, self.target)
        self.assertTrue({self.root.stat().st_ino, self.target.stat().st_ino} <= seen)

    def test_unknown_zip_member_is_rejected_before_any_member_is_opened(self):
        archive = self.archive(extra=('../unexpected', b'not an export file'))
        with patch.object(zipfile.ZipFile, 'open', side_effect=AssertionError('payload opened before metadata validation')):
            with self.assertRaises(exports.ExportError):
                exports.verify_export(archive)

    def test_zip_symlink_metadata_is_rejected_even_when_content_hash_matches(self):
        archive = self.archive(symlink=True)
        with self.assertRaises(exports.ExportError):
            exports.verify_export(archive)

    def test_malformed_deflate_becomes_a_controlled_export_error(self):
        archive = self.archive()
        with zipfile.ZipFile(archive) as reader:
            offset = reader.getinfo('result.json').header_offset
        raw = bytearray(archive.read_bytes())
        payload = offset + 30 + int.from_bytes(raw[offset + 26:offset + 28], 'little') + int.from_bytes(raw[offset + 28:offset + 30], 'little')
        raw[payload] = 7  # Deflate block type 3 is reserved and invalid.
        archive.write_bytes(raw)
        with self.assertRaises(exports.ExportError):
            exports.verify_export(archive)
        result=subprocess.run([sys.executable,'-m','agent_framework','verify-export',str(archive)],capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,1);self.assertIn('无法读取导出 ZIP',result.stderr);self.assertNotIn('Traceback',result.stderr)

    def test_nested_parent_entries_are_synced_and_marker_is_retired_last(self):
        target=self.root/'new parent'/'new child'/'export';sync=exports._sync_directory;unlink=Path.unlink;seen=[]
        def observe(path):
            seen.append((Path(path),sync_phase(path,target)));return sync(path)
        def checked_unlink(path,*args,**kwargs):
            if path==target/exports.MARKER:
                self.assertIn((target,'data-entries'),seen)
                self.assertEqual(seen[-1],(target.parent,'destination-entry'))
            return unlink(path,*args,**kwargs)
        with patch.object(exports,'_sync_directory',side_effect=observe),patch.object(Path,'unlink',checked_unlink):
            exports.write_directory(self.snapshot,target)
        self.assertTrue({self.root,target.parent.parent,target.parent,target}<={path for path,_ in seen})
        self.assertEqual(seen[-1],(target,'marker-removal'));self.assertTrue(exports.verify_export(target)['valid'])

    def test_sync_failure_at_every_publication_boundary_is_reported_without_false_success(self):
        sync=exports._sync_directory
        for phase in PHASES:
            target=self.root/('failed-'+phase);failed=False
            def fail_once(path):
                nonlocal failed
                if not failed and sync_phase(path,target)==phase:
                    failed=True;raise OSError('injected sync failure '+phase)
                return sync(path)
            with self.subTest(phase=phase),patch.object(exports,'_sync_directory',side_effect=fail_once),self.assertRaisesRegex(OSError,'injected sync failure'):
                exports.write_directory(self.snapshot,target)
            self.assertTrue(failed)
            if phase=='marker-removal':self.assertTrue(exports.verify_export(target)['valid'])
            else:self.assertFalse(target.exists())

    def test_partial_file_is_owned_before_its_sync_can_fail(self):
        sync=os.fsync;failed=False
        def fail_once(fd):
            nonlocal failed
            path=self.target/'result.json'
            if not failed and path.exists() and os.fstat(fd).st_ino==path.stat().st_ino:
                failed=True;raise OSError('injected file sync failure')
            return sync(fd)
        with patch.object(exports.os,'fsync',side_effect=fail_once),self.assertRaisesRegex(OSError,'file sync failure'):
            exports.write_directory(self.snapshot,self.target)
        self.assertTrue(failed);self.assertFalse(self.target.exists())

    def test_replaced_payload_is_preserved_and_cleanup_keeps_incomplete_marker(self):
        write=exports._write_file
        def replace_and_fail(path,raw,**kwargs):
            if path.name=='events.jsonl':
                replacement=self.root/'replacement';replacement.write_text('foreign replacement')
                replacement.replace(self.target/'result.json')
                raise OSError('injected writer failure')
            return write(path,raw,**kwargs)
        with patch.object(exports,'_write_file',side_effect=replace_and_fail),self.assertRaises(OSError):
            exports.write_directory(self.snapshot,self.target)
        self.assertEqual((self.target/'result.json').read_text(),'foreign replacement')
        self.assertTrue((self.target/exports.MARKER).exists())
        with self.assertRaisesRegex(exports.ExportError,'未完成'):exports.verify_export(self.target)

    def test_replaced_directory_and_completion_marker_are_not_removed(self):
        write=exports._write_file;original=self.root/'original-export'
        def replace_directory(path,raw,**kwargs):
            if path.name=='events.jsonl':
                self.target.rename(original);self.target.mkdir();(self.target/'keep').write_text('foreign directory')
                raise OSError('injected directory replacement')
            return write(path,raw,**kwargs)
        with patch.object(exports,'_write_file',side_effect=replace_directory),self.assertRaises(OSError):
            exports.write_directory(self.snapshot,self.target)
        self.assertEqual((self.target/'keep').read_text(),'foreign directory');self.assertTrue((original/exports.MARKER).exists())
        target=self.root/'changed-marker'
        def replace_marker(path,raw,**kwargs):
            result=write(path,raw,**kwargs)
            if path.name=='manifest.json':
                replacement=self.root/'marker';replacement.write_text('foreign marker');replacement.replace(target/exports.MARKER)
            return result
        with patch.object(exports,'_write_file',side_effect=replace_marker),self.assertRaisesRegex(exports.ExportError,'标记已被其他进程替换'):
            exports.write_directory(self.snapshot,target)
        self.assertEqual((target/exports.MARKER).read_text(),'foreign marker');self.assertTrue((target/'result.json').is_file())

    def test_rollback_sync_failure_preserves_incomplete_state_and_original_error(self):
        sync=exports._sync_directory;writing=False
        def fail_write(path,raw,**kwargs):
            nonlocal writing
            if path.name=='result.json':writing=True;raise OSError('original write failure')
            return write(path,raw,**kwargs)
        def fail_cleanup(path):
            if writing:raise OSError('cleanup sync failure')
            return sync(path)
        write=exports._write_file
        with patch.object(exports,'_write_file',side_effect=fail_write),patch.object(exports,'_sync_directory',side_effect=fail_cleanup),self.assertRaisesRegex(OSError,'original write failure'):
            exports.write_directory(self.snapshot,self.target)
        self.assertTrue((self.target/exports.MARKER).exists())
        with self.assertRaisesRegex(exports.ExportError,'未完成'):exports.verify_export(self.target)

    def test_process_exit_after_each_sync_leaves_no_export_incomplete_export_or_valid_export(self):
        program='''import os,sys
from pathlib import Path
from agent_framework import exports
from agent_framework.runtime import Runtime
from tests.test_export_publication import sync_phase
runtime=Runtime(sys.argv[1]);target=Path(sys.argv[3]);phase=sys.argv[4];sync=exports._sync_directory
def crash(path):
    sync(path)
    if sync_phase(path,target)==phase:os._exit(77)
exports._sync_directory=crash
exports.write_directory(exports.capture_run(runtime.store,'tenant-demo',sys.argv[2]),target)
'''
        for phase in PHASES:
            target=self.root/('crash-'+phase)
            with self.subTest(phase=phase):
                result=subprocess.run([sys.executable,'-c',program,str(self.root/'source'),self.snapshot['run']['run_id'],str(target),phase],capture_output=True,text=True,timeout=15)
                self.assertEqual(result.returncode,77,result.stderr)
                if phase=='parent-ready':self.assertFalse(target.exists())
                elif phase=='marker-removal':self.assertTrue(exports.verify_export(target)['valid'])
                else:
                    with self.assertRaisesRegex(exports.ExportError,'未完成'):exports.verify_export(target)

    def test_invalid_manifest_is_rejected_before_opening_payloads(self):
        original=exports.bundle_files(self.snapshot);opening=zipfile.ZipFile.open
        cases=[]
        for change in ('hash','size','time','file-list'):
            manifest=json.loads(original['manifest.json'])
            if change=='hash':manifest['files']['result.json']['sha256']='invalid'
            if change=='size':manifest['files']['result.json']['bytes']+=1
            if change=='time':manifest['captured_at']=10**1000
            if change=='file-list':manifest['files']['unknown']={}
            cases.append(json.dumps(manifest).encode())
        cases.extend([b'\xff',b'{not json}'])
        for index,raw_manifest in enumerate(cases):
            archive=self.root/('invalid-'+str(index)+'.zip')
            with zipfile.ZipFile(archive,'w') as writer:
                for name,raw in original.items():writer.writestr(name,raw_manifest if name=='manifest.json' else raw)
            def only_manifest(reader,name,*args,**kwargs):
                self.assertEqual(name,'manifest.json');return opening(reader,name,*args,**kwargs)
            with self.subTest(case=index),patch.object(zipfile.ZipFile,'open',only_manifest),self.assertRaises(exports.ExportError):
                exports.verify_export(archive)

    def test_declared_limits_are_checked_before_reading_zip_or_directory_files(self):
        archive=self.archive();exports.write_directory(self.snapshot,self.target)
        for constant in ('MAX_BYTES','MAX_MANIFEST_BYTES'):
            with self.subTest(constant=constant),patch.object(exports,constant,1):
                with patch.object(zipfile.ZipFile,'open',side_effect=AssertionError('unexpected ZIP payload read')),self.assertRaises(exports.ExportError):exports.verify_export(archive)
                with patch.object(exports.os,'open',side_effect=AssertionError('unexpected directory payload read')),self.assertRaises(exports.ExportError):exports.verify_export(self.target)

    def test_directory_unexpected_files_symlinks_and_pipes_are_rejected_before_reads(self):
        exports.write_directory(self.snapshot,self.target)
        extra=self.target/'unknown';extra.write_text('extra')
        with patch.object(exports.os,'open',side_effect=AssertionError('unexpected read')),self.assertRaises(exports.ExportError):exports.verify_export(self.target)
        extra.unlink();result=self.target/'result.json';result.unlink();result.symlink_to(self.root/'outside')
        with patch.object(exports.os,'open',side_effect=AssertionError('unexpected read')),self.assertRaises(exports.ExportError):exports.verify_export(self.target)
        result.unlink();os.mkfifo(result)
        with patch.object(exports.os,'open',side_effect=AssertionError('pipe must not be opened')),self.assertRaises(exports.ExportError):exports.verify_export(self.target)

    def test_directory_payload_growth_during_verification_is_rejected(self):
        exports.write_directory(self.snapshot,self.target);opening=os.open
        def grow(path,*args,**kwargs):
            if Path(path).name=='result.json':
                with Path(path).open('ab') as stream:stream.write(b'changed after stat')
            return opening(path,*args,**kwargs)
        with patch.object(exports.os,'open',side_effect=grow),self.assertRaisesRegex(exports.ExportError,'校验失败'):
            exports.verify_export(self.target)

    def test_empty_event_file_and_stored_zip_remain_supported(self):
        snapshot={**self.snapshot,'events':[]};target=self.root/'stored.zip'
        with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_STORED) as archive:
            for name,raw in exports.bundle_files(snapshot).items():archive.writestr(name,raw)
        result=exports.verify_export(target)
        self.assertTrue(result['valid']);self.assertEqual(result['manifest']['snapshot']['event_seq'],0)

    def test_fifo_as_top_level_zip_source_is_rejected_without_waiting_for_a_writer(self):
        pipe=self.root/'input.zip';os.mkfifo(pipe)
        result=subprocess.run([sys.executable,'-m','agent_framework','verify-export',str(pipe)],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,1);self.assertIn('非普通文件',result.stderr);self.assertNotIn('Traceback',result.stderr)


if __name__ == '__main__':
    unittest.main()
