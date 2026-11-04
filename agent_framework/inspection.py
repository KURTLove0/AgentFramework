"""Read historical runs without starting workers, tools or schema migrations."""
import json
from pathlib import Path
import sqlite3

from .backups import restore_incomplete
from .exports import capture_run, write_directory
from .store import Store

RUNTIME_SCHEMA={
    'runs':{'tenant_id','id','state'},
    'events':{'tenant_id','run_id','seq','time','kind','data'},
    'actions':{'tenant_id','run_id','data'},
    'evidence':{'tenant_id','run_id','data'},
}
BUSINESS_SCHEMA={'calls':{'tenant','run','tool','count'},'drafts':{'tenant','key','data'}}
READ_COMMANDS={'show','events','stats','export'}


class InspectionError(ValueError):pass


def _require_schema(db,expected,label):
    tables={row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for table,fields in expected.items():
        if table not in tables or not fields<={row[1] for row in db.execute('PRAGMA table_info('+table+')')}:
            raise InspectionError(label+'缺少必需的数据结构：'+table+'；未执行初始化或修复')


def read_run(data_dir,tenant,run_id,command,*,directory=None):
    if command not in READ_COMMANDS:raise ValueError('不支持的历史查询命令')
    source=Path(data_dir).resolve()
    if restore_incomplete(source):raise InspectionError('数据恢复尚未完成，不能查询此目录；请将备份重新恢复到新的目录')
    path=source/'runtime.sqlite3'
    if not path.is_file():raise InspectionError('找不到已有的运行数据库，请检查 --data-dir；未创建新工作台')
    try:
        store=Store(path,read_only=True)
        with store.read_snapshot() as db:
            _require_schema(db,RUNTIME_SCHEMA,'运行数据库')
            store.load(tenant,run_id,db=db)
            if command=='show':return store.result(tenant,run_id,db=db)
            if command=='events':return store.events(tenant,run_id,db=db)
        if command=='export':return {'directory':write_directory(capture_run(store,tenant,run_id),directory)}
        business=source/'mock-business.sqlite3'
        if not business.is_file():raise InspectionError('找不到已有的模拟业务数据库，无法确认业务调用及效果；未创建空库')
        with Store(business,read_only=True).read_snapshot() as db:
            _require_schema(db,BUSINESS_SCHEMA,'模拟业务数据库')
            calls={row['tool']:row['count'] for row in db.execute('SELECT tool,count FROM calls WHERE tenant=? AND run=?',(tenant,run_id))}
            prefix=run_id+':report:'
            drafts=[json.loads(row[0]) for row in db.execute('SELECT data FROM drafts WHERE tenant=? AND substr(key,1,?)=?',(tenant,len(prefix),prefix))]
            return {'calls':calls,'drafts':drafts}
    except sqlite3.Error as exc:
        raise InspectionError('无法读取已有数据库，请检查文件权限、锁定状态或数据库完整性；未执行初始化或修复') from exc
    except (json.JSONDecodeError,UnicodeError) as exc:
        raise InspectionError('已有运行记录格式无效；未执行初始化或修复') from exc
