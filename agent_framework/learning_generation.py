"""Read-only interruption projection and fenced completion of accepted proposals."""
import math
import time

from .runtime_config import ConfigConflict


GENERATION_SECONDS = 240  # Shared model/Skill budget <= 180s, plus completion margin.
DEADLINE_SQL = "COALESCE(json_extract(data,'$.generation_claim.expires_at'),json_extract(data,'$.created_at')+240,0)"


class LearningGenerationExpired(ConfigConflict):
    pass


def projection(status, expires_at, created_at):
    if status != 'GENERATING': return {}
    if expires_at is None:
        expires_at = created_at + GENERATION_SECONDS if type(created_at) in (int, float) else 0
    if type(expires_at) not in (int, float) or not math.isfinite(expires_at): expires_at = 0
    active = expires_at > time.time()
    return {'status': 'GENERATING' if active else 'INTERRUPTED', 'generation_expires_at': expires_at,
            'generation_message': '该请求仍在生成，可以稍后核对状态。' if active else
                '本次处理期限已结束，尚未保存可审阅的结果。不会自动调用模型；请核对原要求与当前来源后，明确发起新的生成。'}
