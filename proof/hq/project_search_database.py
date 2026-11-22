"""A real project-space case search database and its domain's read-only SQL role."""
from contextlib import contextmanager
from urllib.parse import urlsplit, urlunsplit
from unittest.mock import patch

from proof.hq.database import fresh_database


@contextmanager
def visit_database(rows):
    from django.test import override_settings
    from sqlalchemy import text
    from sqlalchemy.pool import QueuePool

    from corehq.apps.project_db.table_ddl import DomainSchema, get_domain_query_engine, get_project_db_engine, setup_project_db
    from corehq.apps.project_db.tests.util import project_db_table
    from corehq.sql_db.connections import connection_manager

    # The setup SQL provisions functions, and the domain role is cluster-wide.
    # Each caller owns its database and a unique role until every reader closes.
    with fresh_database() as database:
        domain = "nova-search-" + database.name.rsplit("_", 1)[-1]
        original = connection_manager.get_connection_string
        cloned_url = urlunsplit(urlsplit(original("default"))._replace(path=f"/{database.name}"))

        def connection_string(engine):
            return cloned_url if engine == "project_db" else original(engine)

        with (
            override_settings(PROJECTDB_USERS_PASSWORD="synthetic-search-proof"),
            patch.dict(connection_manager.engine_id_django_db_map, {"project_db": "default"}),
            patch.object(connection_manager, "get_connection_string", connection_string),
        ):
            # Production delegates pooling to PgBouncer. This proof has only
            # PostgreSQL. Hold its two authenticated connections before HQ's
            # unit opens and starts refusing fresh DBAPI connections.
            with patch("corehq.sql_db.connections.NullPool", QueuePool):
                admin = get_project_db_engine()
            try:
                assert admin.url.database == database.name
                setup_project_db()
                columns = ["case_id", "owner_id", "case_name", "parent_id"]
                with project_db_table(domain, "visit", {}, data=(columns, rows)):
                    with patch("corehq.sql_db.connections.NullPool", QueuePool):
                        reader = get_domain_query_engine(domain)
                    try:
                        with reader.connect() as conn:
                            identity = conn.execute(text("SELECT current_database(), current_user")).one()
                            assert tuple(identity) == (database.name, DomainSchema(domain).role_name)
                        yield domain
                    finally:
                        reader.dispose()
                        get_domain_query_engine.cache_clear()
            finally:
                connection_manager.dispose_engine("project_db")
