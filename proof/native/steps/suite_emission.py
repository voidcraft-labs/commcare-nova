"""HQ's suite contributors over Nova's navigation exports.

Each step imports every export of its family (``Application.from_source``),
names it as Nova's runtime target does (app id, version 1, Nova's server as
the app's base URL and as HQ's own address), and writes what HQ's
hand-assembled suite pipeline (``hq_support.hand_assembled_suite``) makes of
it as ``<scenario>.hq-suite.xml``, with the forms and app strings the
family's Core class reads. Each project space turns on the flags its proof
names, and no other: ``CASE_SEARCH_ADVANCED`` (the search defaults Nova
authors) everywhere, ``SESSION_ENDPOINTS`` for endpoints, and
``FOLLOWUP_FORMS_AS_CASE_LIST_FORM`` for nested menus and no-matches
registration.

- ``case_lists``: the case list scenarios, with their app strings
  (``<scenario>.hq.properties``).
- ``endpoints``: session endpoints, with ``SESSION_ENDPOINTS`` on.
- ``searches(family)``: the six search corpora (search, prompt, function,
  quote, static-quote, form-link).
- ``nested_menus`` / ``no_matches``: with endpoints, and the form Core
  opens regenerated (``<scenario>.hq.xml``: the second module's first form
  for nested menus, the last module's first form for no-matches).
- ``localizations(family)``: the localization and worker corpora, each form
  regenerated and, for localization, each language's app strings
  (``<scenario>.hq.<lang>.strings.txt``).
"""

from proof.native.hq_support import (
    NOVA_SERVER_ORIGIN,
    hand_assembled_suite,
    import_source,
    known_app_strings,
    native_check,
    regenerate_form,
    sha256,
)

SEARCH_DOMAIN = "nova-search-evidence"
SEARCH_APP_ID = "search-evidence"
ENDPOINT_DOMAIN = "test-domain"
LOCALIZATION_DOMAIN = "nova-localization-evidence"


def _target(app, app_id):
    app._id = app_id
    app.version = 1
    app.custom_base_url = NOVA_SERVER_ORIGIN
    return app


def _check(session, domain, flags):
    return native_check(domain, validate=session.validate_form, flags=flags, server_origin=NOVA_SERVER_ORIGIN)


def case_lists(session):
    exports = session.family("case-list")
    sources = sorted(exports.glob("*.json"))
    records = []
    with _check(session, SEARCH_DOMAIN, {"CASE_SEARCH_ADVANCED"}):
        for source in sources:
            raw = source.read_bytes()
            app = _target(import_source(raw, SEARCH_DOMAIN), SEARCH_APP_ID)
            (exports / f"{source.stem}.hq.properties").write_text(known_app_strings(app, "en"))
            suite = hand_assembled_suite(app)
            (exports / f"{source.stem}.hq-suite.xml").write_bytes(suite)
            records.append(
                {
                    "scenario": source.stem,
                    "sourceSha256": sha256(raw),
                    "suiteSha256": sha256((exports / f"{source.stem}.suite.xml").read_bytes()),
                    "nativeSuiteSha256": sha256(suite),
                }
            )
    return {"sources": [source.stem for source in sources], "records": records}


def endpoints(session):
    exports = session.family("endpoint")
    records = []
    with _check(session, ENDPOINT_DOMAIN, {"CASE_SEARCH_ADVANCED", "SESSION_ENDPOINTS"}):
        for source in sorted(exports.glob("endpoint-*.json")):
            raw = source.read_bytes()
            app = _target(import_source(raw, ENDPOINT_DOMAIN), "endpoint-evidence")
            suite = hand_assembled_suite(app, endpoints=True)
            source.with_suffix(".hq-suite.xml").write_bytes(suite)
            records.append(
                {
                    "scenario": source.stem,
                    "sourceSha256": sha256(raw),
                    "local": source.with_suffix(".suite.xml").read_bytes(),
                    "native": suite,
                }
            )
    return records


def searches(family):
    def run(session):
        exports = session.family(family)
        sources = sorted(exports.glob("*.json"))
        records = []
        with _check(session, SEARCH_DOMAIN, {"CASE_SEARCH_ADVANCED"}):
            for source in sources:
                raw = source.read_bytes()
                app = _target(import_source(raw, SEARCH_DOMAIN), SEARCH_APP_ID)
                suite = hand_assembled_suite(app)
                (exports / f"{source.stem}.hq-suite.xml").write_bytes(suite)
                records.append(
                    {
                        "scenario": source.stem,
                        "sourceSha256": sha256(raw),
                        "local": (exports / f"{source.stem}.suite.xml").read_bytes(),
                        "native": suite,
                    }
                )
        return {"sources": [source.stem for source in sources], "records": records}

    return run


def _child_menu_step(family, pattern, app_id, form_module):
    def run(session):
        exports = session.family(family)
        records = []
        flags = {"CASE_SEARCH_ADVANCED", "FOLLOWUP_FORMS_AS_CASE_LIST_FORM"}
        with _check(session, ENDPOINT_DOMAIN, flags):
            for source in sorted(exports.glob(pattern)):
                raw = source.read_bytes()
                app = _target(import_source(raw, ENDPOINT_DOMAIN), app_id)
                form = app.get_module(form_module(app)).get_form(0)
                source.with_suffix(".hq.xml").write_bytes(regenerate_form(form, ENDPOINT_DOMAIN))
                suite = hand_assembled_suite(app, endpoints=True)
                source.with_suffix(".hq-suite.xml").write_bytes(suite)
                records.append(
                    {
                        "scenario": source.stem,
                        "sourceSha256": sha256(raw),
                        "local": source.with_suffix(".suite.xml").read_bytes(),
                        "native": suite,
                    }
                )
        return records

    return run


nested_menus = _child_menu_step("nested-menu", "nested-menu-*.json", "nested-menu-evidence", lambda app: 1)
no_matches = _child_menu_step(
    "no-matches", "no-matches-*.json", "no-matches-evidence", lambda app: len(app.modules) - 1
)


def localizations(family):
    def run(session):
        from corehq.apps.app_manager.models.applications import validate_lang

        exports = session.family(family)
        pattern = "locale-*.json" if family == "localization" else "worker-*.json"
        records = []
        with _check(session, LOCALIZATION_DOMAIN, {"CASE_SEARCH_ADVANCED"}):
            for source in sorted(exports.glob(pattern)):
                raw = source.read_bytes()
                app = _target(import_source(raw, LOCALIZATION_DOMAIN), "localization-evidence")
                for lang in app.langs:
                    validate_lang(lang)
                form = app.get_module(0).get_form(0)
                source.with_suffix(".hq.xml").write_bytes(regenerate_form(form, LOCALIZATION_DOMAIN))
                source.with_suffix(".hq-suite.xml").write_bytes(hand_assembled_suite(app))
                # HQ's authored strings and overlay composition, with no stock
                # UI translation catalog (those strings are not Nova's).
                for lang in app.langs if family == "localization" else []:
                    (exports / f"{source.stem}.hq.{lang}.strings.txt").write_text(known_app_strings(app, lang))
                records.append({"scenario": source.stem, "languages": list(app.langs), "sourceSha256": sha256(raw)})
        return records

    return run
