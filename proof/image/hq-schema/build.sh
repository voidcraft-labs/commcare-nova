#!/bin/sh
# Builds /opt/hq-schema/hq.sql: HQ's database as HQ's migrations leave it
# (migrate.py), dumped with no owner or privileges so any role can restore it.
set -eu
pg_bin=/usr/lib/postgresql/14/bin
data=/tmp/hq-schema-pgdata
install -d -o postgres "$data"
su postgres -c "$pg_bin/initdb -D $data -U commcarehq --auth=trust --encoding=UTF8 --locale=C.UTF-8" >/dev/null
su postgres -c "$pg_bin/pg_ctl -D $data -o '-c listen_addresses=127.0.0.1' -w start" >/dev/null
trap 'su postgres -c "$pg_bin/pg_ctl -D $data -m fast -w stop" >/dev/null' EXIT
"$pg_bin/createdb" -h 127.0.0.1 -U commcarehq commcarehq
PROOF_POSTGRES_HOST=127.0.0.1 PYTHONPATH=/opt/proof-image/py python /opt/proof-image/hq-schema/migrate.py
mkdir -p /opt/hq-schema
"$pg_bin/pg_dump" -h 127.0.0.1 -U commcarehq --no-owner --no-privileges commcarehq > /opt/hq-schema/hq.sql
test -s /opt/hq-schema/hq.sql
