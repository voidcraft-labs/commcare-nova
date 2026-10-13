"""HQ's local settings for the proof harness.

HQ's ``settings.py`` imports the module named by ``CUSTOMSETTINGS`` in place of
``localsettings`` and copies the names in ``__all__`` into its own settings, so
this module stands where a deployment's ``localsettings.py`` stands. Without
it HQ falls back to ``dev_settings.py``, which adds a development-only app and
points every service at localhost.

HQ's services other than Postgres are never reached at these addresses:
Couch, Redis, Elasticsearch, Kafka, S3 and Formplayer keep them here only
because HQ's settings require them to be named, and ``proof.hq.boot`` refuses
every connection to them. The harness's own Redis, Elasticsearch and
Formplayer are reached at addresses of their own, each admitted as it starts
(``proof.hq.redis``, ``proof.hq.elasticsearch``). The two Redis caches must be django-redis backends while
HQ imports (``corehq/apps/users/device_rate_limiter.py`` builds a Redis client
at import); the boot moves every cache to local memory right after
``django.setup()``.
"""

import os

__all__ = [
    "DATABASES",
    "COUCH_DATABASES",
    "CACHES",
    "CELERY_BROKER_URL",
    "CELERY_TASK_ALWAYS_EAGER",
    "CELERY_TASK_EAGER_PROPAGATES",
    "SHARED_DRIVE_ROOT",
    "ALLOWED_HOSTS",
    "EMAIL_BACKEND",
    "BASE_ADDRESS",
    "DEFAULT_PROTOCOL",
    "MAPBOX_ACCESS_TOKEN",
]


def _required(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"The proof harness could not find {name} in its environment. HQ's "
            "state lives in the lane's Postgres, so the harness needs its host "
            "(PROOF_POSTGRES_HOST) to boot; `npm run proof` and the CI lane set it."
        )
    return value


_POSTGRES_DB = os.environ.get("PROOF_POSTGRES_DB", "commcarehq")

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        # The maintenance database: the session's template is restored and
        # each worker's database cloned from here, and this alias then points
        # at the worker's database (proof.hq.database).
        "NAME": _POSTGRES_DB,
        "USER": os.environ.get("PROOF_POSTGRES_USER", "commcarehq"),
        "PASSWORD": os.environ.get("PROOF_POSTGRES_PASSWORD", "commcarehq"),
        "HOST": _required("PROOF_POSTGRES_HOST"),
        "PORT": os.environ.get("PROOF_POSTGRES_PORT", "5432"),
        # testsettings renames every database to its TEST name; keep this one.
        "TEST": {"NAME": _POSTGRES_DB},
    }
}

# Named only because HQ's settings build their Couch URLs from it; every
# document class reads the harness's in-memory Couch instead (proof.hq.couch).
COUCH_DATABASES = {
    "default": {
        "COUCH_HTTPS": False,
        "COUCH_SERVER_ROOT": "127.0.0.1:5984",
        "COUCH_USERNAME": "proof",
        "COUCH_PASSWORD": "proof",
        "COUCH_DATABASE_NAME": "commcarehq",
    },
}

_REDIS = {
    "BACKEND": "django_redis.cache.RedisCache",
    "LOCATION": "redis://127.0.0.1:6379/0",
    "TEST_LOCATION": "redis://127.0.0.1:6379/0",
}

CACHES = {
    "default": dict(_REDIS),
    "redis": dict(_REDIS),
}

# Tasks run inline (testsettings sets CELERY_TASK_ALWAYS_EAGER too), and an
# exception inside one propagates to the code that started it, so a task a
# save starts (the data dictionary refresh) fails the check instead of being
# logged and swallowed. The old-style CELERY_EAGER_PROPAGATES_EXCEPTIONS that
# dev_settings sets is not read under HQ's CELERY settings namespace.
CELERY_BROKER_URL = "memory://"
CELERY_TASK_ALWAYS_EAGER = True
CELERY_TASK_EAGER_PROPAGATES = True

SHARED_DRIVE_ROOT = None
ALLOWED_HOSTS = ["*"]
EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"

# HQ's own address, which it writes into what it builds: dimagi/utils/web.py::
# get_url_base is DEFAULT_PROTOCOL://BASE_ADDRESS, and it is the base of every
# absolute URL in a build (the profile's update, submission, restore and
# heartbeat URLs through ApplicationBase.url_base and absolute_url_property;
# the suite's search, claim, case-fixture and session-endpoint URLs through
# corehq/util/view_utils.py::absolute_reverse). The corpus is captured from
# Nova's publish to its production server (proof/corpus/publish.ts,
# PROOF_SERVER, lib/commcare/servers.ts), so HQ names that server, as the HQ
# Nova publishes to would. Nothing reaches it: the boot refuses the network.
BASE_ADDRESS = "www.commcarehq.org"
DEFAULT_PROTOCOL = "https"

# The map layer HQ's pages draw maps with (Web Apps' location question, entries.js::GeoPointEntry, which draws
# no map and takes no answer without one). Production names one, so a worker answers a location question on the
# map; the map's pictures come from the layer's host, which the browser does not reach, and the map moves and
# answers all the same.
MAPBOX_ACCESS_TOKEN = "proof-map-layer"
