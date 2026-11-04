"""Bound long-lived local SSE handlers without queuing ordinary requests."""
from contextlib import contextmanager
from threading import Lock


class StreamCapacityBusy(Exception):
    pass


class StreamCapacity:
    def __init__(self, limit=4):
        if type(limit) is not int or limit < 1:
            raise ValueError('实时连接数量必须为正整数')
        self.limit = limit
        self._active = 0
        self._lock = Lock()

    @property
    def active(self):
        with self._lock:
            return self._active

    @contextmanager
    def reserve(self):
        with self._lock:
            if self._active >= self.limit:
                raise StreamCapacityBusy('实时连接暂满，请稍后重连；仍可刷新查看任务并继续操作。')
            self._active += 1
        try:
            yield
        finally:
            with self._lock:
                self._active -= 1
