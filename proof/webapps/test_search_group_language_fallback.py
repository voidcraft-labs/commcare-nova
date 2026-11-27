"""Compare the actual bilingual native labels before and after a Search group is rekeyed."""

import pytest
from lxml import etree

from proof.checks.compare.app_strings import parse_app_strings
from proof.hq import operations
from proof.matrix import ops, registry
from proof.matrix.authoring import Authoring
from proof.observe.search_address import enable_address_search
from proof.webapps import hq as webapps_hq

OLD = "search_property.m0.g"
CANONICAL = "search_property.m0.group_header_0"


@pytest.mark.parametrize("spanish_override", [False, True], ids=["english-only", "english-and-spanish"])
def test_bilingual_legacy_search_group_uses_the_same_words_after_rekey(
    hq, webapps_documents, evidence, spanish_override,
):
    document = webapps_documents["hq-search"]
    with webapps_hq.authored_project(document, "A", configure=enable_address_search) as project:
        authoring = Authoring(project.unit, {}, document.id, operation=project.unit.operation)
        app_id = project.app_id
        variant = registry.named_change(
            "a_legacy_search_group_competes_with_a_second_language_override" if spanish_override
            else "translation_competes_with_a_legacy_heading_in_two_languages"
        )
        variant(authoring, app_id)

        def observe():
            app = operations.held_app(project.unit, app_id)
            suite = etree.fromstring(app.create_suite())
            active, = [
                key for key in suite.xpath("//group/display/text/locale/@id")
                if key in {OLD, CANONICAL}
            ]
            tables = {
                code: parse_app_strings(app.create_app_strings(code))
                for code in ["en", "es", "default"]
            }
            return {
                "key": active,
                "stored": app.translations,
                "active": {code: table.get(active) for code, table in tables.items()},
                "headings": {
                    code: {key: table.get(key) for key in [OLD, CANONICAL]}
                    for code, table in tables.items()
                },
            }

        before = observe()
        app = operations.held_app(project.unit, app_id)
        rows = [row.to_json() for row in app.modules[0].search_config.properties]
        for row in rows:
            if row.get("group_key") == "g":
                row["group_key"] = "group_header_0"
                if row.get("is_group"):
                    row["name"] = "group_header_0"
        ops.set_json(authoring, app_id, "/modules/0/search_config/properties", rows)
        stock = observe()
        translations = {
            code: dict(entries)
            for code, entries in operations.held_app(project.unit, app_id).translations.items()
        }
        translations["en"][CANONICAL] = translations["en"].pop(OLD)
        if spanish_override:
            assert translations["es"].pop(CANONICAL) == "Otros datos"
            assert stock["active"]["es"] == "Otros datos"
        ops.set_json(authoring, app_id, "/translations", translations)
        after = observe()
        evidence("bilingual-search-group-fallback", {"legacy": before, "stock": stock, "rekeyed": after})
        assert before["key"] == OLD and after["key"] == CANONICAL
        assert stock["active"]["en"] == "Other saved words"
        assert before["active"]["en"] == after["active"]["en"] == "Find a client"
        assert before["active"] == after["active"]
