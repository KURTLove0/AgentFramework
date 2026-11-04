"""Skill catalogs keep their full contract with bounded, coherent reads."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from agent_framework.contracts import canonical
from agent_framework.skills import SkillRegistry
from agent_framework import skills as skill_module
from agent_framework.store import Store


def package(name='catalog-method',label='第一版'):
    return {'folder':name,'revision':0,'files':{'SKILL.md':{'encoding':'utf-8','content':'---\nname: '+name+'\ndescription: 资料整理方法\nmetadata:\n  label: "'+label+'"\n---\n\n读取 [资料](references/source.md)。\n'},
            'references/source.md':{'encoding':'utf-8','content':label+'\n'+'x'*8192}}}


class SkillCatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='skill-catalog-',dir='/private/tmp');self.addCleanup(self.tmp.cleanup)
        self.store=Store(Path(self.tmp.name)/'runtime.sqlite3');self.registry=SkillRegistry(self.store,'catalog-tenant','catalog-workspace')
        self.other=SkillRegistry(Store(self.store.path),'catalog-tenant','catalog-workspace')

    def published(self,name='catalog-method'):
        saved=self.registry.save(package(name));return self.registry.lifecycle(saved['id'],saved['revision'],'publish',1)

    def measured(self,operation):
        statements=[];connect=Store.connect;loads=skill_module.json.loads;decoded=[]
        def traced(store):
            db=connect(store);db.set_trace_callback(statements.append);return db
        def decode(value,*args,**kwargs):
            if isinstance(value,str) and '"format":"agent-skills@1"' in value:decoded.append(value)
            return loads(value,*args,**kwargs)
        with patch.object(Store,'connect',traced),patch.object(skill_module.json,'loads',decode):result=operation()
        return result,[sql for sql in statements if sql.lstrip().upper().startswith('SELECT')],decoded

    def test_listing_uses_two_queries_and_decodes_each_selected_package_only_once(self):
        for index in range(12):self.published('catalog-method-'+str(index))
        result,selects,decoded=self.measured(self.registry.list)
        self.assertEqual(len(result),14);self.assertEqual(len(selects),2);self.assertEqual(len(decoded),14)
        self.assertTrue(all('package' not in item for item in result))
        self.assertTrue(all(item['files'] and item['versions'] for item in result))

    def test_detail_history_does_not_decode_unselected_package_bodies(self):
        first=self.published();current=first
        for version in range(2,9):
            data=package(label='版本'+str(version));data['revision']=current['revision'];current=self.registry.save(data,first['id'])
        result,selects,decoded=self.measured(lambda:self.registry.get(first['id'],1))
        self.assertEqual(result['package'],first['package']);self.assertEqual(result['version'],1)
        self.assertEqual([item['version'] for item in result['versions']],list(range(8,0,-1)))
        self.assertEqual(result['versions'][0]['metadata']['metadata']['label'],'版本8')
        self.assertEqual(len(selects),2);self.assertEqual(len(decoded),1)

    def test_compact_detail_has_the_same_fields_and_keeps_binary_file_descriptors(self):
        data=package();data['files']['assets/sample.bin']={'encoding':'base64','content':'/wCB'}
        saved=self.registry.save(data);full=self.registry.get(saved['id']);compact=self.registry.get(saved['id'],include_files=False)
        expected=deepcopy(full);expected.pop('package');self.assertEqual(compact,expected)
        self.assertEqual(set(compact),{'id','name','revision','version','status','archived','builtin','metadata','hash','versions','files'})
        self.assertEqual(next(item for item in compact['files'] if item['path']=='assets/sample.bin')['encoding'],'base64')

    def test_catalog_contains_draft_withdrawn_archived_and_builtin_versions(self):
        first=self.published();data=package(label='草稿');data['revision']=first['revision'];draft=self.registry.save(data,first['id'])
        withdrawn=self.registry.lifecycle(first['id'],draft['revision'],'withdraw',1)
        archived=self.registry.lifecycle(first['id'],withdrawn['revision'],'archive',2)
        result=self.registry.list();row=next(item for item in result if item['id']==first['id'])
        self.assertEqual(row['revision'],archived['revision']);self.assertTrue(row['archived']);self.assertEqual(row['status'],'DRAFT')
        self.assertEqual([item['status'] for item in row['versions']],['DRAFT','WITHDRAWN']);self.assertEqual(sum(item['builtin'] for item in result),2)

    def test_selected_package_integrity_still_blocks_catalog_and_detail_reads(self):
        saved=self.published();corrupt=deepcopy(saved['package']);corrupt['files']['references/source.md']['content']='changed'
        with self.store.transaction() as db:db.execute('UPDATE skill_versions SET data=? WHERE tenant=? AND workspace=? AND id=?',(canonical(corrupt),*self.registry.scope,saved['id']))
        for read in (self.registry.list,lambda:self.registry.get(saved['id']),lambda:self.registry.get(saved['id'],include_files=False)):
            with self.subTest(read=read),self.assertRaises(ValueError):read()

    def test_stored_version_hash_is_still_checked(self):
        saved=self.published()
        with self.store.transaction() as db:db.execute('UPDATE skill_versions SET hash=? WHERE tenant=? AND workspace=? AND id=?',('0'*64,*self.registry.scope,saved['id']))
        for read in (self.registry.list,lambda:self.registry.get(saved['id'])):
            with self.assertRaisesRegex(ValueError,'摘要'):read()

    def test_selecting_old_version_still_checks_its_body_after_history_projection(self):
        first=self.published();data=package(label='当前版本');data['revision']=first['revision'];second=self.registry.save(data,first['id'])
        corrupt=deepcopy(first['package']);corrupt['files']['references/source.md']['content']='corrupt old content'
        with self.store.transaction() as db:db.execute('UPDATE skill_versions SET data=? WHERE tenant=? AND workspace=? AND id=? AND version=1',(canonical(corrupt),*self.registry.scope,first['id']))
        row=next(item for item in self.registry.list() if item['id']==first['id']);self.assertEqual(row['version'],2)
        self.assertEqual(self.registry.get(first['id'],2)['package'],second['package'])
        with self.assertRaises(ValueError):self.registry.get(first['id'],1)

    def test_orphaned_history_does_not_enter_or_break_the_catalog(self):
        with self.store.transaction() as db:db.execute('INSERT INTO skill_versions VALUES(?,?,?,?,?,?,?,?)',(*self.registry.scope,'skill-orphan',1,'DRAFT','0'*64,'not valid json',1))
        self.assertEqual(len(self.registry.list()),2)

    def test_missing_current_version_cannot_silently_disappear_from_the_list(self):
        saved=self.published()
        with self.store.transaction() as db:db.execute('DELETE FROM skill_versions WHERE tenant=? AND workspace=? AND id=?',(*self.registry.scope,saved['id']))
        with self.assertRaises(KeyError):self.registry.list()
        with self.assertRaises(KeyError):self.registry.get(saved['id'])

    def test_get_keeps_head_package_and_version_history_on_one_snapshot(self):
        saved=self.published();connect=Store.connect;fired=False
        def traced(store):
            db=connect(store)
            if store is self.store:
                def trace(sql):
                    nonlocal fired
                    if not fired and 'FROM skill_versions' in sql:
                        fired=True;self.other.lifecycle(saved['id'],saved['revision'],'withdraw',1)
                db.set_trace_callback(trace)
            return db
        with patch.object(Store,'connect',traced):result=self.registry.get(saved['id'])
        self.assertTrue(fired);self.assertEqual(result['revision'],saved['revision']);self.assertEqual(result['status'],'PUBLISHED')
        self.assertEqual(result['versions'][0]['status'],'PUBLISHED');self.assertEqual(self.other.get(saved['id'])['status'],'WITHDRAWN')

    def test_list_cannot_mix_two_heads_across_sequential_withdrawals(self):
        first=self.published('catalog-one');second=self.published('catalog-two');custom={first['name']:first,second['name']:second}
        validate=skill_module.validate_frozen;fired=False
        def changed(package):
            nonlocal fired
            validate(package)
            if not fired and package['name'] in custom:
                fired=True;current=custom[package['name']];other=next(item for name,item in custom.items() if name!=package['name'])
                self.other.lifecycle(current['id'],current['revision'],'withdraw',1)
                self.other.lifecycle(other['id'],other['revision'],'withdraw',1)
        with patch.object(skill_module,'validate_frozen',changed):result=self.registry.list()
        rows=[item for item in result if item['id'] in {first['id'],second['id']}]
        self.assertTrue(fired);self.assertEqual([item['status'] for item in rows],['PUBLISHED','PUBLISHED'])
        self.assertTrue(all(self.other.get(item['id'])['status']=='WITHDRAWN' for item in rows))

    def test_same_skill_identity_in_other_scopes_does_not_leak_history(self):
        saved=self.published()
        for tenant,workspace in (('another-tenant','catalog-workspace'),('catalog-tenant','another-workspace')):
            other=SkillRegistry(Store(self.store.path),tenant,workspace)
            with self.store.transaction() as db:
                db.execute('INSERT INTO skill_heads SELECT ?,?,id,name,revision,version,archived,builtin,updated FROM skill_heads WHERE tenant=? AND workspace=? AND id=?',(tenant,workspace,*self.registry.scope,saved['id']))
                db.execute('INSERT INTO skill_versions SELECT ?,?,id,99,status,hash,data,created FROM skill_versions WHERE tenant=? AND workspace=? AND id=?',(tenant,workspace,*self.registry.scope,saved['id']))
                db.execute('UPDATE skill_heads SET version=99 WHERE tenant=? AND workspace=? AND id=?',(tenant,workspace,saved['id']))
            self.assertEqual(next(row for row in other.list() if row['id']==saved['id'])['version'],99)
        row=next(item for item in self.registry.list() if item['id']==saved['id'])
        self.assertEqual([item['version'] for item in row['versions']],[1]);self.assertEqual(row['version'],1)

    def test_unknown_id_invalid_versions_and_missing_historical_version_keep_errors(self):
        saved=self.published()
        with self.assertRaisesRegex(KeyError,'outside workspace'):self.registry.get('skill-absent')
        with self.assertRaisesRegex(KeyError,'version not found'):self.registry.get(saved['id'],99)
        for version in (0,-1,True,'1'):
            with self.assertRaises(ValueError):self.registry.get(saved['id'],version)
