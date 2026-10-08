"""The HQ steps: what HQ's own classes regenerate from each family's corpus.

Each step imports the family's exports into HQ inside a ``native_check`` and
runs the HQ classes its proof names, writes each regenerated artifact beside
its input (``<scenario>.hq.xml``, ``<scenario>.hq-suite.xml`` and the like,
which the family's Core classes read), and returns what the family's
``test_*`` module asserts. ``NativeSession.step`` runs each once per session.
"""

from collections.abc import Callable
from dataclasses import dataclass

from proof.native.steps import (
    case_emission,
    expander_emission,
    form_emission,
    location_emission,
    lookup_workbook,
    media_emission,
    suite_emission,
    tile_emission,
)


@dataclass(frozen=True)
class Step:
    # The family whose directory the step reads and writes.
    family: str
    run: Callable


STEPS = {
    "case": Step("case", case_emission.cases),
    "case-choice": Step("case-choice", form_emission.case_choices),
    "relation-instance": Step("relation-instance", case_emission.relation_instances),
    "case-list": Step("case-list", suite_emission.case_lists),
    "connect": Step("connect", form_emission.connect_forms),
    "container": Step("container", form_emission.containers),
    "endpoint": Step("endpoint", suite_emission.endpoints),
    "expander": Step("expander", expander_emission.expander_corpus),
    "localization": Step("localization", suite_emission.localizations("localization")),
    "worker": Step("worker", suite_emission.localizations("worker")),
    "location": Step("location", location_emission.locations),
    "lookup": Step("lookup", lookup_workbook.lookups),
    "media-validation": Step("media", media_emission.validation_sources),
    "media": Step("media", media_emission.media),
    "navigation": Step("navigation", form_emission.navigations),
    "nested-menu": Step("nested-menu", suite_emission.nested_menus),
    "no-matches": Step("no-matches", suite_emission.no_matches),
    "search": Step("search", suite_emission.searches("search")),
    "prompt": Step("prompt", suite_emission.searches("prompt")),
    "function": Step("function", suite_emission.searches("function")),
    "quote": Step("quote", suite_emission.searches("quote")),
    "static-quote": Step("static-quote", suite_emission.searches("static-quote")),
    "form-link": Step("form-link", suite_emission.searches("form-link")),
    "tile": Step("tile", tile_emission.tiles),
    "xml": Step("xml", form_emission.xml_text),
}
