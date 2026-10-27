"""Install a built wheel into a temporary directory and smoke-test its local UI."""
import argparse
import json
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('wheel',type=Path)
    args=parser.parse_args();wheel=args.wheel.resolve()
    with tempfile.TemporaryDirectory(prefix='agent-release-smoke-') as temp:
        root=Path(temp);target=root/'installed'
        subprocess.run([sys.executable,'-m','pip','install','--no-deps','--no-compile','--target',str(target),str(wheel)],check=True)
        code="""import importlib,pkgutil,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import agent_framework
for item in pkgutil.walk_packages(agent_framework.__path__,'agent_framework.'):
 if item.name.endswith('.__main__'):continue
 module=importlib.import_module(item.name)
 assert Path(module.__file__).is_relative_to(Path(sys.argv[1])),item.name
print('PASS all package modules import from the installed wheel')
"""
        subprocess.run([sys.executable,'-I','-c',code,str(target)],cwd=root,check=True)
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        launch="import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('agent_framework',run_name='__main__')"
        with (root/'server.log').open('w') as log:
            process=subprocess.Popen([sys.executable,'-I','-c',launch,str(target),'--data-dir',str(root/'data'),'serve','--port',str(port)],cwd=root,stdout=log,stderr=subprocess.STDOUT)
            try:
                deadline=time.monotonic()+15
                while True:
                    try:
                        with urlopen(f'http://127.0.0.1:{port}/api/session',timeout=1) as response:session=json.load(response)
                        break
                    except OSError:
                        if process.poll() is not None or time.monotonic()>deadline:raise RuntimeError((root/'server.log').read_text())
                        time.sleep(.1)
                for resource in ['ontology_model.js','ontology_evidence.js','task_conversation.js','operations.js']:
                    with urlopen(f'http://127.0.0.1:{port}/'+resource,timeout=3) as response:assert response.status==200 and response.read()
                with urlopen(f'http://127.0.0.1:{port}/api/runs',timeout=3) as response:assert json.load(response)['counts']['total']==0
                print('PASS installed UI resources, empty runtime and session')
            finally:
                if process.poll() is None:
                    process.send_signal(signal.SIGINT)
                    try:process.wait(8)
                    except subprocess.TimeoutExpired:process.kill();process.wait()


if __name__=='__main__':main()
