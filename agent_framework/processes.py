"""Launch framework-owned modules from the parent's explicit code location."""
from pathlib import Path
import os
import signal
import subprocess
import sys
import time
import logging


_BOOTSTRAP=("import runpy,sys;root,module=sys.argv[1:3];del sys.argv[1:3];"
            "sys.path.insert(0,root);runpy.run_module(module,run_name='__main__',alter_sys=True)")


def module_command(module):
    if (not isinstance(module,str) or not all(part.isidentifier() for part in module.split('.'))
            or not(module=='agent_framework' or module.startswith('agent_framework.'))):
        raise ValueError('only framework-owned Python modules may use this launcher')
    # -I ignores the caller's cwd and PYTHON* variables. The explicit root also
    # supports a trusted source checkout which has not been installed into site.
    return [sys.executable,'-I','-c',_BOOTSTRAP,str(Path(__file__).resolve().parents[1]),module]


def stop_process_group(process):
    """Reap an owned session, including children left after its leader exits."""
    # An exited, unreaped leader can make killpg report EPERM instead of ESRCH
    # on the local runtime. Reap it first, but still signal its group: living
    # descendants can retain the pipes after their leader has gone.
    process.poll()
    def signal_group(sig):
        try:os.killpg(process.pid,sig)
        except ProcessLookupError:pass
        except PermissionError:
            # The leader may exit between poll and killpg. Retry only after
            # confirming its exit; never hide denied access to a live group.
            if process.poll() is None:raise
            try:os.killpg(process.pid,sig)
            except ProcessLookupError:pass
            except PermissionError:
                # A group can disappear while its orphaned descendants are
                # being reaped. Probe only; never equate permission denial or
                # a dead leader with the entire group having stopped.
                deadline=time.monotonic()+.2
                while True:
                    try:os.killpg(process.pid,0)
                    except ProcessLookupError:return
                    except PermissionError:pass
                    if time.monotonic()>=deadline:raise
                    time.sleep(.01)
    signal_group(signal.SIGTERM)
    try:process.wait(timeout=1)
    except subprocess.TimeoutExpired:pass
    # The leader may already be gone while an MCP child still holds a pipe.
    # Finish the owned group before callers join readers or close TextIO pipes.
    signal_group(signal.SIGKILL)
    process.wait(timeout=1)


def finish_process(process,pipes,primary,*,stop=stop_process_group):
    """Close local resources even when termination cannot be confirmed."""
    failures=[]
    try:stop(process)
    except Exception as exc:failures.append(exc)
    try:
        if pipes is not None:pipes.close()
        else:
            for pipe in (process.stdin,process.stdout,process.stderr):
                try:pipe.close()
                except Exception as exc:failures.append(exc)
    except Exception as exc:failures.append(exc)
    if not failures:return
    info={'kind':type(failures[0]).__name__,'pid':process.pid,'confirmed':False,
          'pipes_closed':all(pipe.closed for pipe in (process.stdin,process.stdout,process.stderr))}
    logging.getLogger(__name__).error('Model process cleanup unconfirmed: pid=%s kind=%s',info['pid'],info['kind'])
    if primary is not None:
        primary.cleanup_failure=info
        primary.add_note('model_cleanup_failed: '+info['kind'])
        return
    from .llm import ModelError
    error=ModelError('model_cleanup_failed');error.cleanup_failure=info
    raise error from failures[0]
