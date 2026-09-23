"""A small LRU cache."""
from collections import OrderedDict


class LruCache:
    """Keeps the most recently used entries."""

    def __init__(self, capacity: int):
        self.capacity = capacity
        self._items = OrderedDict()

    def get(self, key):
        if key not in self._items:
            return None
        self._items.move_to_end(key)
        return self._items[key]

    def put(self, key, value):
        self._items[key] = value
        if len(self._items) > self.capacity:
            self._items.popitem(last=False)


def make_cache(capacity=128):
    return LruCache(capacity)


class Stats: pass
