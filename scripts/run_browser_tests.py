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
    'dynamic-pages':('serve_dynamic_pages_fixture.py','PROJECT_REVIEW_PORT','verify_dynamic_pages.cjs','DYNAMIC_PAGES_URL','DYNAMIC_PAGES_OUTPUT'),
    'task-opening':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_task_opening.cjs','TASK_OPENING_URL','TASK_OPENING_OUTPUT'),
    'agent-management':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_agent_management.cjs','AGENT_MANAGEMENT_URL','AGENT_MANAGEMENT_OUTPUT'),
    'agent-domain-creation':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_agent_domain_creation.cjs','AGENT_DOMAIN_CREATION_URL','AGENT_DOMAIN_CREATION_OUTPUT'),
    'task-reply-copy':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_task_reply_copy.cjs','TASK_REPLY_COPY_URL','TASK_REPLY_COPY_OUTPUT'),
    'runtime-values':('serve_runtime_values_fixture.py','RUNTIME_VALUES_PORT','verify_runtime_values.cjs','RUNTIME_VALUES_URL','RUNTIME_VALUES_OUTPUT'),
    'model-freshness':('serve_runtime_settings_fixture.py','RUNTIME_SETTINGS_PORT','verify_model_freshness.cjs','MODEL_FRESHNESS_URL','MODEL_FRESHNESS_OUTPUT'),
    'task-draft-ownership':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_task_draft_ownership.cjs','TASK_DRAFT_OWNERSHIP_URL','TASK_DRAFT_OWNERSHIP_OUTPUT'),
    'task-editing':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_task_editing.cjs','TASK_EDITING_URL','TASK_EDITING_OUTPUT'),
    'task-receipts':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_task_receipts.cjs','TASK_RECEIPTS_URL','TASK_RECEIPTS_OUTPUT'),
    'agent-opening':('serve_runtime_settings_fixture.py','RUNTIME_SETTINGS_PORT','verify_agent_opening.cjs','AGENT_OPENING_URL','AGENT_OPENING_OUTPUT'),
    'agent-models':('serve_runtime_settings_fixture.py','RUNTIME_SETTINGS_PORT','verify_agent_models.cjs','AGENT_MODELS_URL','AGENT_MODELS_OUTPUT'),
    'runtime-detection':('serve_runtime_detection_fixture.py','RUNTIME_DETECTION_PORT','verify_runtime_detection.cjs','RUNTIME_DETECTION_URL','RUNTIME_DETECTION_OUTPUT'),
    'runtime-lifecycle':('serve_runtime_lifecycle_fixture.py','RUNTIME_SETTINGS_PORT','verify_runtime_lifecycle.cjs','RUNTIME_LIFECYCLE_URL','RUNTIME_LIFECYCLE_OUTPUT'),
    'runtime-feedback':('serve_runtime_settings_fixture.py','RUNTIME_SETTINGS_PORT','verify_runtime_feedback.cjs','RUNTIME_FEEDBACK_URL','RUNTIME_FEEDBACK_OUTPUT'),
    'model-discovery':('serve_model_discovery_fixture.py','MODEL_DISCOVERY_PORT','verify_model_discovery.cjs','MODEL_DISCOVERY_URL','MODEL_DISCOVERY_OUTPUT'),
    'runtime-settings':('serve_runtime_settings_fixture.py','RUNTIME_SETTINGS_PORT','verify_runtime_settings.cjs','RUNTIME_SETTINGS_URL','RUNTIME_SETTINGS_OUTPUT'),
    'task-relations':('serve_task_relations_fixture.py','TASK_RELATIONS_PORT','verify_task_relations.cjs','TASK_RELATIONS_URL','TASK_RELATIONS_OUTPUT'),
    'task-reuse':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_task_reuse.cjs','TASK_REUSE_URL','TASK_REUSE_OUTPUT'),
    'task-exports':('serve_message_edits_fixture.py','MESSAGE_EDITS_PORT','verify_task_exports.cjs','MESSAGE_EDITS_URL','MESSAGE_EDITS_OUTPUT'),
    'task-text-search':('serve_task_text_search_fixture.py','TASK_TEXT_SEARCH_PORT','verify_task_text_search.cjs','TASK_TEXT_SEARCH_URL','TASK_TEXT_SEARCH_OUTPUT'),
    'task-message-history':('serve_message_edits_fixture.py','MESSAGE_EDITS_PORT','verify_task_message_history.cjs','MESSAGE_EDITS_URL','MESSAGE_EDITS_OUTPUT'),
    'task-message-edits':('serve_message_edits_fixture.py','MESSAGE_EDITS_PORT','verify_task_message_edits.cjs','MESSAGE_EDITS_URL','MESSAGE_EDITS_OUTPUT'),
    'task-favorites':('serve_run_history_fixture.py','PROJECT_REVIEW_PORT','verify_task_favorites.cjs','RUN_HISTORY_URL','RUN_HISTORY_OUTPUT'),
    'task-archive':('serve_run_history_fixture.py','PROJECT_REVIEW_PORT','verify_task_archive.cjs','RUN_HISTORY_URL','RUN_HISTORY_OUTPUT'),
    'task-names':('serve_run_history_fixture.py','PROJECT_REVIEW_PORT','verify_task_names.cjs','RUN_HISTORY_URL','RUN_HISTORY_OUTPUT'),
    'cleanup-failures':('serve_cleanup_failures_fixture.py','PROCESS_CLEANUP_PORT','verify_cleanup_failures.cjs','PROCESS_CLEANUP_URL','PROCESS_CLEANUP_OUTPUT'),
    'cleanup-review':('serve_cleanup_failures_fixture.py','PROCESS_CLEANUP_PORT','verify_cleanup_review.cjs','PROCESS_CLEANUP_URL','PROCESS_CLEANUP_OUTPUT'),
    'cleanup-recovery':('serve_cleanup_recovery_fixture.py','CLEANUP_RECOVERY_PORT','verify_cleanup_recovery.cjs','CLEANUP_RECOVERY_URL','CLEANUP_RECOVERY_OUTPUT'),
    'turn-retries':('serve_turn_retries_fixture.py','TURN_RETRIES_PORT','verify_turn_retries.cjs','TURN_RETRIES_URL','TURN_RETRIES_OUTPUT'),
    'run-history-restore':('serve_run_history_fixture.py','PROJECT_REVIEW_PORT','verify_run_history_restore.cjs','RUN_HISTORY_URL','RUN_HISTORY_OUTPUT'),
    'run-review':('serve_run_review_fixture.py','RUN_REVIEW_PORT','verify_run_review.cjs','RUN_REVIEW_URL','RUN_REVIEW_OUTPUT'),
    'conversation-review':('serve_conversation_review_fixture.py','CONVERSATION_REVIEW_PORT','verify_conversation_review.cjs','CONVERSATION_REVIEW_URL','CONVERSATION_REVIEW_OUTPUT'),
    'run-inspector':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_run_inspector.cjs','RUN_INSPECTOR_URL','RUN_INSPECTOR_OUTPUT'),
    'task-messages':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_task_messages.cjs','TASK_MESSAGE_URL','TASK_MESSAGE_OUTPUT'),
    'history-context':('serve_history_context_fixture.py','HISTORY_CONTEXT_PORT','verify_history_context.cjs','HISTORY_CONTEXT_URL','HISTORY_CONTEXT_OUTPUT'),
    'history-dependencies':('serve_history_context_fixture.py','HISTORY_CONTEXT_PORT','verify_history_dependencies.cjs','HISTORY_DEPENDENCY_URL','HISTORY_DEPENDENCY_OUTPUT'),
    'source-exposure':('serve_history_context_fixture.py','HISTORY_CONTEXT_PORT','verify_source_exposure.cjs','SOURCE_EXPOSURE_URL','SOURCE_EXPOSURE_OUTPUT'),
    'model-context-refresh':('serve_history_context_fixture.py','HISTORY_CONTEXT_PORT','verify_model_context_refresh.cjs','MODEL_CONTEXT_REFRESH_URL','MODEL_CONTEXT_REFRESH_OUTPUT'),
    'long-messages':('serve_history_context_fixture.py','HISTORY_CONTEXT_PORT','verify_long_messages.cjs','LONG_MESSAGE_URL','LONG_MESSAGE_OUTPUT'),
    'chat-drafts':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_chat_drafts.cjs','CHAT_DRAFT_URL','CHAT_DRAFT_OUTPUT'),
    'task-permissions':('serve_task_permission_fixture.py','TASK_PERMISSION_PORT','verify_task_permissions.cjs','TASK_PERMISSION_URL','TASK_PERMISSION_OUTPUT'),
    'workflow-grants':('serve_workflow_grant_fixture.py','WORKFLOW_GRANT_PORT','verify_workflow_grants.cjs','WORKFLOW_GRANT_URL','WORKFLOW_GRANT_OUTPUT'),
    'workflow-starts':('serve_asset_draft_fixture.py','PROJECT_REVIEW_PORT','verify_workflow_starts.cjs','WORKFLOW_START_URL','WORKFLOW_START_OUTPUT'),
    'workflow-drafts':('serve_asset_draft_fixture.py','PROJECT_REVIEW_PORT','verify_workflow_drafts.cjs','WORKFLOW_DRAFT_URL','WORKFLOW_DRAFT_OUTPUT'),
    'workflow-saves':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_workflow_saves.cjs','WORKFLOW_SAVE_URL','WORKFLOW_SAVE_OUTPUT'),
    'attention':('serve_attention_fixture.py','PROJECT_REVIEW_PORT','verify_attention.cjs','ATTENTION_URL','ATTENTION_OUTPUT'),
    'run-history':('serve_run_history_fixture.py','PROJECT_REVIEW_PORT','verify_run_history.cjs','RUN_HISTORY_URL','RUN_HISTORY_OUTPUT'),
    'operation-settings':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_operation_settings.cjs','OPERATION_SETTINGS_URL','OPERATION_SETTINGS_OUTPUT'),
    'evaluation-catalog':('serve_evaluation_catalog_fixture.py','PROJECT_REVIEW_PORT','verify_evaluation_catalog.cjs','EVALUATION_CATALOG_URL','EVALUATION_CATALOG_OUTPUT'),
    'workflow-catalog':('serve_workflow_catalog_fixture.py','PROJECT_REVIEW_PORT','verify_workflow_catalog.cjs','WORKFLOW_CATALOG_URL','WORKFLOW_CATALOG_OUTPUT'),
    'commands':('serve_command_fixture.py','PROJECT_REVIEW_PORT','verify_commands.cjs','COMMAND_UI_URL','COMMAND_UI_OUTPUT'),
    'reading-interactions':('serve_alert_inbox_fixture.py','PROJECT_REVIEW_PORT','verify_reading_interactions.cjs','READING_UI_URL','READING_UI_OUTPUT'),
    'alert-inbox':('serve_alert_inbox_fixture.py','PROJECT_REVIEW_PORT','verify_alert_inbox.cjs','ALERT_INBOX_URL','ALERT_INBOX_OUTPUT'),
    'memory-catalog':('serve_memory_catalog_fixture.py','PROJECT_REVIEW_PORT','verify_memory_catalog.cjs','MEMORY_CATALOG_URL','MEMORY_CATALOG_OUTPUT'),
    'library-search':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_library_search.cjs','LIBRARY_SEARCH_URL','LIBRARY_SEARCH_OUTPUT'),
    'asset-versions':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_asset_versions.cjs','ASSET_VERSION_URL','ASSET_VERSION_OUTPUT'),
    'asset-drafts':('serve_asset_draft_fixture.py','PROJECT_REVIEW_PORT','verify_asset_drafts.cjs','ASSET_DRAFT_URL','ASSET_DRAFT_OUTPUT'),
    'asset-saves':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_asset_saves.cjs','ASSET_SAVE_URL','ASSET_SAVE_OUTPUT'),
    'learning-catalog':('serve_learning_catalog_fixture.py','PROJECT_REVIEW_PORT','verify_learning_catalog.cjs','LEARNING_CATALOG_URL','LEARNING_CATALOG_OUTPUT'),
    'learning-reads':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_learning_reads.cjs','LEARNING_READ_URL','LEARNING_READ_OUTPUT'),
    'learning-generation':('serve_learning_generation_fixture.py','LEARNING_GENERATION_PORT','verify_learning_generation.cjs','LEARNING_GENERATION_URL','LEARNING_GENERATION_OUTPUT'),
    'learning-requests':('serve_proposal_capacity_fixture.py','PROPOSAL_CAPACITY_PORT','verify_learning_requests.cjs','LEARNING_REQUEST_URL','LEARNING_REQUEST_OUTPUT'),
    'learning-writes':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_learning_writes.cjs','LEARNING_WRITE_URL','LEARNING_WRITE_OUTPUT'),
    'ontology-saves':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_ontology_saves.cjs','ONTOLOGY_SAVE_URL','ONTOLOGY_SAVE_OUTPUT'),
    'asset-writes':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_asset_writes.cjs','ASSET_WRITE_URL','ASSET_WRITE_OUTPUT'),
    'workspace-history':('serve_workspace_history_fixture.py','WORKSPACE_HISTORY_PORT','verify_workspace_history.cjs','WORKSPACE_HISTORY_URL','WORKSPACE_HISTORY_OUTPUT'),
    'workspace-sync':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_workspace_sync.cjs','WORKSPACE_SYNC_URL','WORKSPACE_SYNC_OUTPUT'),
    'journeys':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_project_journeys.cjs','PROJECT_REVIEW_URL','PROJECT_REVIEW_OUTPUT'),
    'task-drafts':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_task_drafts.cjs','TASK_DRAFT_URL','TASK_DRAFT_OUTPUT'),
    'exports':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_exports.cjs','EXPORT_URL','EXPORT_OUTPUT'),
    'agent-retries':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_agent_retries.cjs','AGENT_RETRY_URL','AGENT_RETRY_OUTPUT'),
    'agent-drafts':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_agent_drafts.cjs','AGENT_DRAFT_URL','AGENT_DRAFT_OUTPUT'),
    'agent-saves':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_agent_saves.cjs','AGENT_SAVE_URL','AGENT_SAVE_OUTPUT'),
    'agent-catalog':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_agent_catalog.cjs','AGENT_CATALOG_URL','AGENT_CATALOG_OUTPUT'),
    'skill-saves':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_skill_saves.cjs','SKILL_SAVE_URL','SKILL_SAVE_OUTPUT'),
    'task-submissions':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_task_submissions.cjs','TASK_SUBMISSION_URL','TASK_SUBMISSION_OUTPUT'),
    'workflow-agents':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_workflow_agents.cjs','PROJECT_REVIEW_URL','PROJECT_REVIEW_OUTPUT'),
    'workflow-chat-requests':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_workflow_chat_requests.cjs','WORKFLOW_CHAT_URL','WORKFLOW_CHAT_OUTPUT'),
    'proposal-capacity':('serve_proposal_capacity_fixture.py','PROPOSAL_CAPACITY_PORT','verify_proposal_capacity.cjs','PROPOSAL_CAPACITY_URL','PROPOSAL_CAPACITY_OUTPUT'),
    'workflow-queue':('serve_workflow_queue_fixture.py','WORKFLOW_QUEUE_PORT','verify_workflow_queue.cjs','WORKFLOW_QUEUE_URL','WORKFLOW_QUEUE_OUTPUT'),
    'workflow-controls':('serve_workflow_queue_fixture.py','WORKFLOW_QUEUE_PORT','verify_workflow_controls.cjs','WORKFLOW_CONTROL_URL','WORKFLOW_CONTROL_OUTPUT'),
    'workflow-history-consistency':('serve_workflow_queue_fixture.py','WORKFLOW_QUEUE_PORT','verify_workflow_history_consistency.cjs','FLOW_HISTORY_SYNC_URL','FLOW_HISTORY_SYNC_OUTPUT'),
    'workflow-sync':('serve_workflow_queue_fixture.py','WORKFLOW_QUEUE_PORT','verify_workflow_sync.cjs','WORKFLOW_SYNC_URL','WORKFLOW_SYNC_OUTPUT'),
    'workspace-safety':('serve_workflow_queue_fixture.py','WORKFLOW_QUEUE_PORT','verify_workspace_safety.cjs','WORKSPACE_SAFETY_URL','WORKSPACE_SAFETY_OUTPUT'),
    'daily-recovery':('serve_daily_recovery_fixture.py','DAILY_RECOVERY_PORT','verify_daily_recovery.cjs','DAILY_RECOVERY_URL','DAILY_RECOVERY_OUTPUT'),
    'worker-recovery':('serve_worker_recovery_fixture.py','WORKER_RECOVERY_PORT','verify_worker_recovery.cjs','WORKER_RECOVERY_URL','WORKER_RECOVERY_OUTPUT'),
    'cancellations':('serve_cancellation_fixture.py','CANCELLATION_PORT','verify_cancellation.cjs','CANCELLATION_URL','CANCELLATION_OUTPUT'),
    'native-read-cancellation':('serve_native_read_cancellation_fixture.py','NATIVE_STOP_PORT','verify_native_read_cancellation.cjs','NATIVE_STOP_URL','NATIVE_STOP_OUTPUT'),
    'workflow-model-cancellation':('serve_workflow_model_cancellation_fixture.py','WORKFLOW_MODEL_STOP_PORT','verify_workflow_model_cancellation.cjs','WORKFLOW_MODEL_STOP_URL','WORKFLOW_MODEL_STOP_OUTPUT'),
    'cognition-lease-loss':('serve_cognition_lease_loss_fixture.py','COGNITION_LEASE_PORT','verify_cognition_lease_loss.cjs','COGNITION_LEASE_URL','COGNITION_LEASE_OUTPUT'),
    'codex-rpc-writes':('serve_codex_rpc_writes_fixture.py','RPC_WRITE_PORT','verify_codex_rpc_writes.cjs','RPC_WRITE_URL','RPC_WRITE_OUTPUT'),
    'process-cleanup':('serve_process_cleanup_fixture.py','PROCESS_CLEANUP_PORT','verify_process_cleanup.cjs','PROCESS_CLEANUP_URL','PROCESS_CLEANUP_OUTPUT'),
    'model-failure-messages':('serve_model_failure_messages_fixture.py','MODEL_FAILURE_PORT','verify_model_failure_messages.cjs','MODEL_FAILURE_URL','MODEL_FAILURE_OUTPUT'),
    'task-search':('serve_reply_markdown_fixture.py','REPLY_MARKDOWN_PORT','verify_task_search.cjs','TASK_SEARCH_URL','TASK_SEARCH_OUTPUT'),
    'reply-markdown':('serve_reply_markdown_fixture.py','REPLY_MARKDOWN_PORT','verify_reply_markdown.cjs','REPLY_MARKDOWN_URL','REPLY_MARKDOWN_OUTPUT'),
    'conversation-ui':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_conversation_ui.cjs','PROJECT_REVIEW_URL','PROJECT_REVIEW_OUTPUT'),
    'conversation-details':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_conversation_details.cjs','PROJECT_REVIEW_URL','PROJECT_REVIEW_OUTPUT'),
    'streaming':('serve_streaming_task_fixture.py','TASK_STREAM_PORT','verify_streaming_tasks.cjs','TASK_STREAM_URL','TASK_STREAM_OUTPUT'),
    'stream-lifecycle':('serve_streaming_task_fixture.py','TASK_STREAM_PORT','verify_stream_lifecycle.cjs','TASK_STREAM_URL','TASK_STREAM_OUTPUT'),
    'conversations':('serve_model_execution_fixture.py','TASK_CHAT_PORT','verify_task_conversations.cjs','TASK_CHAT_TEST_URL','TASK_CHAT_OUTPUT'),
    'model-runtime':('serve_model_execution_fixture.py','TASK_CHAT_PORT','verify_model_runtime.cjs','MODEL_RUNTIME_TEST_URL','MODEL_RUNTIME_OUTPUT'),
    'simple-tasks':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_simple_tasks.cjs','SIMPLE_TASK_BASE_URL','SIMPLE_TASK_OUTPUT'),
    'ontology':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_ui_review_ontology_form.cjs','AGENT_UI_BASE_URL','AGENT_UI_OUTPUT'),
    'audit-fixes':('serve_audit_fix_fixture.py','PROJECT_REVIEW_PORT','verify_audit_fixes.cjs','AGENT_UI_BASE_URL','AGENT_UI_OUTPUT'),
    'controls':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_control_consistency.cjs','CONTROL_UI_BASE_URL','CONTROL_UI_OUTPUT'),
    'control-routes':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_control_routes.cjs','AGENT_UI_BASE_URL','CONTROL_ROUTES_OUTPUT'),
    'run-filters':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_run_filters.cjs','RUN_FILTER_BASE_URL','RUN_FILTER_OUTPUT'),
    'ui-details':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_ui_details.cjs','UI_DETAILS_BASE_URL','UI_DETAILS_OUTPUT'),
    'multica':('serve_project_review_fixture.py','PROJECT_REVIEW_PORT','verify_multica_agents.cjs','AGENT_UI_BASE_URL','MULTICA_REVIEW_OUTPUT'),
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
                result=subprocess.run(['node',str(ROOT/'tests'/script)],cwd=ROOT,env={**env,'AGENT_TEST_PYTHON':sys.executable},stdout=test_log,stderr=subprocess.STDOUT,timeout=240)
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
