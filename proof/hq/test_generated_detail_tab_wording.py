"""HQ emits separate case details and Search details tab titles."""

from lxml import etree

from proof.checks.compare.app_strings import parse_app_strings
from proof.rules.conftest import edited, published


def test_standalone_search_can_word_the_same_detail_tab_independently(hq, documents):
    from corehq.apps.app_manager.util import module_offers_search, module_uses_inline_search

    with published(documents["targeted-search-workflow"], None, configuration="maximum") as app:
        module = next(one for one in app._app().get_modules()
                      if module_offers_search(one) and not module_uses_inline_search(one)
                      and one.case_details.long.columns)
        index = module.id
        case_key = f"m{index}.case_long.tab.1.title"
        search_key = f"m{index}.search_long.tab.1.title"

        def add_tab(body):
            body["modules"][index]["case_details"]["long"]["tabs"] = [
                {"doc_type": "DetailTab", "header": {"en": "Patient"}, "starting_index": 0, "has_nodeset": False},
            ]
            body["translations"].setdefault("en", {})[search_key] = "Matched patient"

        with app.unit.fork():
            app._write(edited(add_tab))
            native = app._app()
            strings = parse_app_strings(native.create_app_strings("en"))
            assert strings[case_key] == "Patient"
            assert strings[search_key] == "Matched patient"
            suite = etree.fromstring(native.create_suite())
            for kind, key in (("case", case_key), ("search", search_key)):
                xpath = f"./detail[@id='m{index}_{kind}_long']/detail/title/text/locale[@id='{key}']"
                assert len(suite.xpath(xpath)) == 1
