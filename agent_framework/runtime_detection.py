"""Read a CLI version with bounded output and an owned process lifetime."""
import subprocess
import time

from .llm import ModelError
from .process_pipes import ProcessPipes
from .processes import finish_process, stop_process_group


DETECTION_TIMEOUT=5
OUTPUT_LIMIT=64*1024


class RuntimeDetectionError(ValueError):
    pass


def run_version_command(command):
    process=None;pipes=None;primary=None;deadline=time.monotonic()+DETECTION_TIMEOUT
    try:
        process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                                 text=True,encoding='utf-8',start_new_session=True)
        pipes=ProcessPipes(process,limit=OUTPUT_LIMIT);pipes.queue_input('',close=True)
        ended=set();output=[];size=0
        while len(ended)<2 or process.poll() is None:
            remaining=deadline-time.monotonic()
            if remaining<=0:raise RuntimeDetectionError('CLI 检测超时，请在终端检查安装后重试')
            event=pipes.receive(min(.05,remaining))
            if event is None:continue
            label,text=event
            if text is None:ended.add(label)
            else:
                size+=len(text.encode('utf-8'))
                if size>OUTPUT_LIMIT:raise RuntimeDetectionError('CLI 检测输出过大，请在终端检查安装后重试')
                if label=='stdout':output.append(text)
        return subprocess.CompletedProcess(command,process.returncode,''.join(output),'')
    except ModelError as error:
        primary=RuntimeDetectionError('CLI 检测输出无效或过大，请在终端检查安装后重试')
        raise primary from error
    except BaseException as error:
        primary=error
        raise
    finally:
        if process is not None:finish_process(process,pipes,primary,stop=stop_process_group)
