"""Filesystem barriers shared by local maintenance artifact publishers."""
import os


def sync_directory(path):
    """Persist directory entries; unsupported synchronization is an error."""
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
