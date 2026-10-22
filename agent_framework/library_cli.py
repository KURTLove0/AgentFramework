"""Local trusted-operator CLI for knowledge, private memory and experience review."""
import argparse
import json
from pathlib import Path

from .contracts import PolicyDenied
from .experience import ExperienceService
from .knowledge import Access, Library
from .memory import episodes
from .store import Store


def main(argv=None):
    parser=argparse.ArgumentParser(description='知识、私有记忆与经验审核（本地模拟身份）')
    parser.add_argument('--data-dir',default='.agent-data')
    parser.add_argument('--tenant',default='tenant-demo')
    parser.add_argument('--principal',default='kurt')
    parser.add_argument('--project',default='project-demo')
    parser.add_argument('--role',action='append',choices=('curator','reviewer'),default=[])
    sub=parser.add_subparsers(dest='command',required=True)
    sub.add_parser('list');sub.add_parser('episodes');sub.add_parser('experiences');sub.add_parser('seed')
    search=sub.add_parser('search');search.add_argument('query')
    create=sub.add_parser('create');create.add_argument('file',type=Path)
    for command in ('review','publish','withdraw','evaluate'):
        p=sub.add_parser(command);p.add_argument('ref')
        if command=='publish':p.add_argument('--evaluation-id')
    args=parser.parse_args(argv)
    access=Access(args.tenant,args.principal,args.project,roles=tuple(args.role))
    store=Store(Path(args.data_dir)/'runtime.sqlite3');library=Library(store)
    service=ExperienceService(store)
    try:
        if args.command=='list':result=library.list(access,include_unpublished=True)
        elif args.command=='seed':result=library.get(access,library.bootstrap(access))
        elif args.command=='search':result=library.search(access,args.query)
        elif args.command=='episodes':result=episodes(store,access)
        elif args.command=='experiences':result=service.list(access)
        elif args.command=='create':result=library.create(access,json.loads(args.file.read_text()))
        elif args.command=='evaluate':result=service.evaluate(access,args.ref)
        elif args.command=='publish' and args.evaluation_id:result=service.publish(access,args.ref,args.evaluation_id)
        else:result=library.transition(access,args.ref,{'review':'REVIEW','publish':'PUBLISHED','withdraw':'WITHDRAWN'}[args.command])
        print(json.dumps(result,ensure_ascii=False,indent=2));return 0
    except (ValueError,KeyError,PolicyDenied) as exc:
        parser.exit(1,str(exc)+'\n')


if __name__=='__main__':raise SystemExit(main())
