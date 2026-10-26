"""Optional interoperability check; requires rdflib and pyshacl in the test environment.

Usage: python scripts/verify_ontology_export.py docs/ontology-v2/example.jsonld
These libraries are not needed to run the workbench.
"""
import argparse
import json
from pathlib import Path


def main():
    from rdflib import Graph
    from pyshacl import validate
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input',type=Path)
    parser.add_argument('--report',type=Path)
    args=parser.parse_args()
    document=json.loads(args.input.read_text())
    if not isinstance(document.get('@context'),dict) or '@import' in document['@context']:
        raise ValueError('expected an inline export context; remote contexts are not accepted')
    graph=Graph().parse(data=json.dumps(document),format='json-ld')
    conforms,_,text=validate(graph,shacl_graph=graph,meta_shacl=True)
    if args.report:args.report.write_text(text)
    print(text)
    return 0 if conforms else 1


if __name__=='__main__':
    raise SystemExit(main())
