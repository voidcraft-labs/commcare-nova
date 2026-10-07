"""Local memory in place of HQ's Redis caches, with the calls HQ makes of them beyond Django's cache API.

The boot moves every cache alias to local memory (``proof.hq.boot``). The
aliases HQ's settings give a Redis backend (``django_redis.cache.RedisCache``)
are read through Django's cache API almost everywhere, which a
``LocMemCache`` answers as Redis does. HQ's rate counters are the exception
on the paths the lane runs (``project_limits/rate_counter/rate_counter.py::
CounterCache``, which HQ's receiver counts each submission and each case
in): they call two methods only django-redis has, and ``RedisShaped``
answers each as django-redis does over Redis:

- ``incr(key, delta, ignore_key_check=True)``: Redis's ``INCRBY``, which
  counts a key it does not hold from zero and gives it no expiry
  (``django_redis/client/default.py::DefaultClient._incr``);
- ``expire(key, timeout)``: Redis's ``EXPIRE``, the key's expiry set from
  now (``DefaultClient.expire``).

The counts live where every other cached value of a unit lives, so a unit's
restore empties them with the rest (``proof.hq.boot.clear_caches``).
"""

from django.core.cache.backends.locmem import LocMemCache


class RedisShaped(LocMemCache):
    def incr(self, key, delta=1, version=None, ignore_key_check=False, **kwargs):
        if ignore_key_check:
            self.add(key, 0, timeout=None, version=version)
        return super().incr(key, delta, version=version)

    def expire(self, key, timeout, version=None):
        return self.touch(key, timeout, version=version)
