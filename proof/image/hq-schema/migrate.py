"""Migrates an empty Postgres database to HQ's schema, for the image to ship.

HQ's state in every check is a clone of the database HQ's own migrations
create (proof/README.md), so every table, function, trigger and constraint a
path reaches exists exactly as HQ deploys it. This runs once, at image build
time, against a Postgres the build starts: HQ boots through the harness's own
boot (``proof.hq.boot``), then ``manage.py migrate`` runs every app's
migrations. HQ's Elasticsearch index migrations create search indexes, not
database objects, and are skipped as HQ skips them when no matching
Elasticsearch answers
(``corehq/apps/es/migration_operations.py::BaseElasticOperation._should_skip_operation``).
"""

from unittest import mock

from proof.hq.boot import GUARD, boot

boot()

from django.core.management import call_command  # noqa: E402

with mock.patch(
    "corehq.apps.es.migration_operations.BaseElasticOperation._should_skip_operation",
    lambda self, *args: True,
):
    call_command("migrate", interactive=False, verbosity=1, should_reindex=False)

refused = [attempt for attempt in GUARD.attempts if not attempt.allowed]
if refused:
    raise SystemExit(
        "HQ's migrations reached for a service other than Postgres, which the image build refuses:\n"
        + "\n".join(f"  {attempt.kind} {attempt.address}" for attempt in refused)
    )
