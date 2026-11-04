"""Bound model-backed proposal generation without queuing ordinary commands."""
from contextlib import contextmanager
from threading import BoundedSemaphore


class ProposalCapacityBusy(Exception):
    """No proposal was accepted; the original request can be retried explicitly."""


class ProposalCapacity:
    def __init__(self, limit=2):
        if type(limit) is not int or limit < 1:
            raise ValueError('生成并发数量必须为正整数')
        self.limit = limit
        self._slots = BoundedSemaphore(limit)

    @contextmanager
    def reserve(self):
        if not self._slots.acquire(blocking=False):
            raise ProposalCapacityBusy('当前生成任务已满，本次尚未受理，也未调用模型。请等待已有设计、复盘或本体生成结束后重试。')
        try:
            yield
        finally:
            self._slots.release()
