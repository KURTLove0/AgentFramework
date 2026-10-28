"""Run browser journeys against disposable synthetic services, with one command."""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

ROOT=Path(__file__).resolve().parents[1]
SUITES={
    'journeys':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_project_journeys.cjs','PROJECT_REVIEW_URL','PROJECT_REVIEW_OUTPUT'),
    'streaming':('serve_streaming_task_fixture.py','TASK_STREAM_PORT','verify_streaming_tasks.cjs','TASK_STREAM_URL','TASK_STREAM_OUTPUT'),
    'conversations':('serve_model_execution_fixture.py','TASK_CHAT_PORT','verify_task_conversations.cjs','TASK_CHAT_TEST_URL','TASK_CHAT_OUTPUT'),
    'ontology':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_ui_review_ontology_form.cjs','AGENT_UI_BASE_URL','AGENT_UI_OUTPUT'),
    'audit-fixes':('serve_audit_fix_fixture.py','PROJECT_REVIEW_PORT','verify_audit_fixes.cjs','AGENT_UI_BASE_URL','AGENT_UI_OUTPUT'),
    'controls':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_control_consistency.cjs','CONTROL_UI_BASE_URL','CONTROL_UI_OUTPUT'),
    'control-routes':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_control_routes.cjs','AGENT_UI_BASE_URL','CONTROL_ROUTES_OUTPUT'),
    'run-filters':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_run_filters.cjs','RUN_FILTER_BASE_URL','RUN_FILTER_OUTPUT'),
    'ui-details':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_ui_details.cjs','UI_DETAILS_BASE_URL','UI_DETAILS_OUTPUT'),
    'legacy-modules':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_ui95_modules.cjs','AGENT_UI_BASE_URL','AGENT_UI_OUTPUT')}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite',action='append',choices=SUITES)
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    output=args.output or Path(tempfile.mkdtemp(prefix='agent-browser-tests-'))
    output.mkdir(parents=True,exist_ok=True)
    results=[]
    for name in args.suite or [s for s in SUITES if s!='legacy-modules']:
        fixture,port_key,script,url_key,output_key=SUITES[name]
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        env={**os.environ,'PYTHONPATH':str(ROOT),port_key:str(port),url_key:f'http://127.0.0.1:{port}',output_key:str(output/name)}
        env['AUDIT_FIX_SEED']=str(output/name/'fixture.json')
        server=None
        with (output/(name+'-server.log')).open('w') as server_log,(output/(name+'.log')).open('w') as test_log:
            try:
                server=subprocess.Popen([sys.executable,str(ROOT/'tests'/fixture)],cwd=ROOT,env=env,stdout=server_log,stderr=subprocess.STDOUT)
                deadline=time.monotonic()+15
                while True:
                    try:
                        with urlopen(env[url_key]+'/api/session',timeout=1) as response:response.read()
                        break
                    except OSError:
                        if server.poll() is not None or time.monotonic()>deadline:raise RuntimeError('fixture did not start')
                        time.sleep(.1)
                result=subprocess.run(['node',str(ROOT/'tests'/script)],cwd=ROOT,env=env,stdout=test_log,stderr=subprocess.STDOUT,timeout=240)
                results.append({'suite':name,'passed':result.returncode==0,'exit_code':result.returncode})
            except (OSError,RuntimeError,subprocess.TimeoutExpired) as exc:
                results.append({'suite':name,'passed':False,'error':str(exc)})
            finally:
                if server and server.poll() is None:
                    server.send_signal(signal.SIGINT)
                    try:server.wait(8)
                    except subprocess.TimeoutExpired:server.kill();server.wait()
        print(('PASS ' if results[-1]['passed'] else 'FAIL ')+name,flush=True)
    (output/'results.json').write_text(json.dumps({'results':results},indent=2))
    print('results='+str(output/'results.json'))
    return 0 if all(r['passed'] for r in results) else 1


if __name__=='__main__':raise SystemExit(main())
