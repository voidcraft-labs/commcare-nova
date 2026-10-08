"""A case search's description that holds no text: ``{}``, or ``""`` for each language.

HQ's Case List save writes ``search_config.description`` with the page's
language mapped to ``""`` where no description is given
(``views/modules.py::edit_module_detail_screens``), where Nova writes
``{}``. Each reader of it:

- HQ's build writes the description's text into every language's app
  strings either way (``app_strings.py``, the id
  ``case_search.m<n>.description``, an empty text as a non-breaking space,
  ``commcare_translations.py::dumps``), and gives the search's ``<query>`` a
  ``<description>`` naming that id only where the stored value is not
  ``{}`` (``suite_xml/post_process/remote_requests.py::
  build_remote_request_queries``). So the two builds differ in that element
  alone, and a description that holds text differs in the app strings too;
- Core reads the element's text (``QueryScreen.getDescriptionLocaleString``):
  the non-breaking space with the element, ``""`` without it, and its
  sessions take the same steps either way;
- Formplayer hands the client that text
  (``beans/menus/QueryResponseBean.description``);
- the Web Apps client trims it and shows a description only where text is
  left (``cloudcare/js/formplayer/menus/views/query.js``,
  ``description.trim()``), so it shows none for either;
- CommCare Android's search screen shows no description at all
  (``QueryRequestActivity``).

The rule makes ``search_config.description`` ``{}`` where every value it
holds is ``""`` (the app document); removes a ``<query>``'s ``<description>``
whose text is a locale id and nothing else (a built suite), since the text
it names is the app strings' in both builds and is compared there; and
makes the description of a query response Formplayer hands the client
``""`` where it holds only white space (a Formplayer trace). A description
that holds text is another app to Formplayer and the client, and the rule
leaves its text where it is read: the app document's value, the app
strings' and Formplayer's.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import blank_to_empty, modules

_QUERY = "query"


def _locale_alone(description) -> bool:
    """Whether a ``<description>`` is ``<text><locale id="..."/></text>`` and nothing else."""
    children = [child for child in description if isinstance(child.tag, str)]
    if len(children) != 1 or children[0].tag != "text" or (description.text or "").strip():
        return False
    text = children[0]
    named = [child for child in text if isinstance(child.tag, str)]
    return len(named) == 1 and named[0].tag == "locale" and bool(named[0].get("id")) and not (text.text or "").strip()


def _suite(root):
    for query in root.iter(_QUERY):
        for description in [child for child in query if child.tag == "description"]:
            if _locale_alone(description):
                query.remove(description)
    return root


def _handed(value):
    """Formplayer's JSON with each query response's white-space description made empty, in place."""
    if isinstance(value, dict):
        description = value.get("description")
        if value.get("type") == _QUERY and isinstance(description, str) and not description.strip():
            value["description"] = ""
        for item in value.values():
            _handed(item)
    elif isinstance(value, list):
        for item in value:
            _handed(item)
    return value


def normalize(parsed):
    if hasattr(parsed, "iter"):
        return _suite(parsed) if getattr(parsed, "tag", None) == "suite" else parsed
    if isinstance(parsed, dict) and "runs" in parsed:
        return _handed(parsed)
    for module in modules(parsed):
        blank_to_empty(module.get("search_config"), "description")
    return parsed


RULE = SpellingRule(
    "search-description-empty",
    ("app.json", "suite.xml", "*/suite.xml", "formplayer"),
    "A case search description holding no text, which Formplayer hands the Web Apps client as white space or"
    " nothing, the client trims to nothing either way (menus/views/query.js) and CommCare Android does not show.",
    normalize,
    readers=(
        ("formplayer", "test_formplayer_hands_white_space_for_the_empty_description_and_nothing_else_differs"),
        ("webapps", "test_the_client_shows_no_description_for_either_and_shows_one_that_holds_text"),
        ("android", "test_a_search_description_changes_nothing_a_device_shows"),
    ),
)
