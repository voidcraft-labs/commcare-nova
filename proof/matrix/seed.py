"""The case seed of an app made in HQ: what its case database is generated from, read from A alone.

``case_seed(state, app, core_runner)`` reads the app HQ holds (A) and nothing of the
document Nova read from it, so a reader that drops a type, a property or a
literal cannot empty the lists A's walk and B's walk both show
(``proof/observe/casedata.py::seeded_case_database`` generates the database
from it). It is written as ``proof/hq-apps/<base>/seed.json``:

- ``catalog``: each case type of ``Application.get_case_types`` but
  ``commcare-user`` (the worker's user case, which the case database makes
  itself) and the empty type a survey menu gives, parents first. Those are
  the types HQ's menus name (``models/modules.py::ModuleBase.get_case_types``):
  a type a form opens and no menu names is none of them, and HQ's own
  property and parent maps, which filter by them
  (``app_schemas/case_properties.py::get_all_case_properties``,
  ``get_parent_type_map``), say nothing of it either. A type's properties are the names
  ``get_all_case_properties(app, exclude_invalid_properties=False)`` gives it
  (the call HQ's application resource makes), less every name holding ``/``
  (``ParentCasePropertyBuilder`` adds ``parent/<property>`` for each parent
  property, which no case property element can name) and less ``name``
  (its ``defaults``, which every generated case holds as its ``case_name``).
  Its ``parent_type`` and ``index_identifier`` are ``get_parent_type_map``'s
  (the identifier each form's index names, ``reference_id or 'parent'``,
  ``models/forms.py::get_contributed_case_relationships``), and its
  ``relationship`` is the opening action's (``OpenSubCaseAction.relationship``
  in a basic form, the opening ``CaseIndex.relationship`` in an advanced one,
  ``models/form_actions.py``). A type with two parents, two identifiers, two
  relationships, or a relationship a question answers is refused by name.
- each property's ``data_type`` is read from HQ's own summary of the
  questions that write it (``Form.get_questions``), by its type
  (``xform.py::VELLUM_TYPES``): ``Date`` is ``date``, ``Time`` ``time``,
  ``DateTime`` ``datetime``, ``Int`` and ``Long`` ``int``, ``Double``
  ``decimal``, ``Select`` ``single_select`` and ``MSelect`` ``multi_select``
  with the summary's option values, ``Geopoint`` ``geopoint``, anything else
  ``text``; a property questions of two types write is ``text``.
- ``values``: every string literal A's expressions compare with a case
  property, by ``<type>/<property>``: a literal beside ``=``, ``!=``,
  ``<``, ``<=``, ``>`` or ``>=``, or the second argument of ``selected(...)``,
  whose other operand is a path whose last step names a property of the type.
  The expressions are each form's binds and setvalues and each menu's case
  list filter, calculated columns, sort calculations and search
  expressions, and the CSQL a search's ``_xpath_query`` default property
  sends where its value is one string literal (that literal's text, the
  query HQ's case search reads: a property its row compares with a literal
  is found only where some case holds that literal, so a walk past the
  search reaches the menu's forms). Each is parsed by Core (the Core runner's ``xpathParse``); one
  Core refuses compares nothing. The comparison is read over Core's own
  tokens (``proof/rules/_xpath.py::tokens``, the port of Core's lexer its
  test holds to Core): the operand beside the operator is the run of path
  tokens to the operator's side, bounded by a token that binds more loosely
  than a comparison (``and``, ``or``, ``(``, ``,``, ``[``, or the
  expression's end), so ``a + b = 'x'`` compares no property. Never a regular
  expression.
- ``userData``: every name read under
  ``instance('commcaresession')/session/user/data/`` (Core's
  ``instancePaths``), and the user case properties
  ``get_usercase_properties`` gives.
- ``worker``: ``{"location": <the site code of the place the base names as
  the worker's, or null>}``.
"""

from __future__ import annotations

from proof.rules import _xpath

USERCASE_TYPE = "commcare-user"
# The key of a search's default property whose value is the CSQL HQ's case search reads
# (``case_search/const.py::CASE_SEARCH_XPATH_QUERY_KEY``).
XPATH_QUERY = "_xpath_query"
COMPARISONS = frozenset({"EQ", "NEQ", "LT", "LTE", "GT", "GTE"})
# The tokens a path is made of, outside its predicates and its root call's arguments.
PATH_TOKENS = frozenset({"QNAME", "SLASH", "DBL_SLASH", "DOT", "DBL_DOT", "AT", "WILDCARD", "NSWILDCARD"})
# The tokens that bind more loosely than a comparison, or end the operand: what may stand just outside an operand
# of one.
BOUNDARIES = frozenset({"AND", "OR", "LPAREN", "COMMA", "LBRACK", "RPAREN", "RBRACK"})

VELLUM_DATA_TYPES = {
    "Date": "date",
    "Time": "time",
    "DateTime": "datetime",
    "Int": "int",
    "Long": "int",
    "Double": "decimal",
    "Select": "single_select",
    "MSelect": "multi_select",
    "Geopoint": "geopoint",
}


class SeedRefused(ValueError):
    """A base holds a case structure the seed cannot write as one parent, identifier and relationship a type."""


# Reading comparisons over Core's tokens ---------------------------------------------------------------------------


def _matching(found, index, step):
    """The index of the bracket or parenthesis matching the one at ``index``, walking by ``step`` (-1 or 1)."""
    opening = {"LBRACK": "RBRACK", "LPAREN": "RPAREN"}
    closing = {value: key for key, value in opening.items()}
    pair = closing if step < 0 else opening
    own = found[index].kind
    other = pair[own]
    depth = 0
    i = index
    while 0 <= i < len(found):
        if found[i].kind == own:
            depth += 1
        elif found[i].kind == other:
            depth -= 1
            if depth == 0:
                return i
        i += step
    return None


def _path_before(found, end):
    """``(name, first)``: the last step's name of the path whose last token is ``end - 1``, and the index of its
    first token; None where the tokens there are no path ending in a named step. A path is its steps
    (``PATH_TOKENS``), each step's predicates (``[...]``), and a root call before its first step
    (``instance('casedb')``, ``current()``)."""
    if end <= 0 or found[end - 1].kind != "QNAME":
        return None
    i = end - 1
    while i > 0:
        previous = found[i - 1]
        if previous.kind in PATH_TOKENS:
            i -= 1
        elif previous.kind == "RBRACK":
            opened = _matching(found, i - 1, -1)
            if opened is None:
                return None
            i = opened
        elif previous.kind == "RPAREN" and found[i].kind in ("SLASH", "DBL_SLASH"):
            opened = _matching(found, i - 1, -1)
            if opened is None or opened == 0 or found[opened - 1].kind != "QNAME":
                return None
            return found[end - 1].text, opened - 1
        else:
            break
    return found[end - 1].text, i


def _path_after(found, start):
    """``(name, after)``: the last step's name of the path whose first token is ``start``, and the index after its
    last token; None where the tokens there are no path ending in a named step (``_path_before``'s path)."""
    i = start
    if i + 1 < len(found) and found[i].kind == "QNAME" and found[i + 1].kind == "LPAREN":
        closed = _matching(found, i + 1, 1)
        if closed is None or closed + 1 >= len(found) or found[closed + 1].kind not in ("SLASH", "DBL_SLASH"):
            return None
        i = closed + 1
    last = None
    while i < len(found):
        token = found[i]
        if token.kind in PATH_TOKENS:
            last = i
            i += 1
        elif token.kind == "LBRACK":
            closed = _matching(found, i, 1)
            if closed is None:
                return None
            i = closed + 1
        else:
            break
    if last is None or last != i - 1 or found[last].kind != "QNAME":
        return None
    return found[last].text, i


def _bounded_before(found, index):
    return index == 0 or found[index - 1].kind in BOUNDARIES


def _bounded_after(found, index):
    return index >= len(found) or found[index].kind in BOUNDARIES


def compared_literals(text):
    """``[(property name, literal)]``: each string literal ``text`` compares with a path whose last step names a
    property (the module's docstring), read over Core's tokens; ``[]`` where the port reads no token of it."""
    found = _xpath.tokens(text)
    if not found:
        return []
    pairs = []
    for index, token in enumerate(found):
        if token.kind in COMPARISONS:
            left_literal = index >= 1 and found[index - 1].kind == "STR" and _bounded_before(found, index - 1)
            right_literal = index + 1 < len(found) and found[index + 1].kind == "STR"
            if right_literal and _bounded_after(found, index + 2):
                path = _path_before(found, index)
                if path is not None and _bounded_before(found, path[1]):
                    pairs.append((path[0], found[index + 1].text[1:-1]))
            if left_literal:
                path = _path_after(found, index + 1)
                if path is not None and _bounded_after(found, path[1]):
                    pairs.append((path[0], found[index - 1].text[1:-1]))
        elif token.kind == "QNAME" and token.text == "selected" and index + 1 < len(found):
            if found[index + 1].kind != "LPAREN":
                continue
            path = _path_after(found, index + 2)
            if path is None:
                continue
            after = path[1]
            if (
                after + 2 < len(found)
                and found[after].kind == "COMMA"
                and found[after + 1].kind == "STR"
                and found[after + 2].kind == "RPAREN"
            ):
                pairs.append((path[0], found[after + 1].text[1:-1]))
    return pairs


def session_user_data(parsed):
    """Each name a Core ``xpathParse`` result reads under ``instance('commcaresession')/session/user/data/``."""
    names = []
    for instance_path in parsed.get("instancePaths") or []:
        steps = instance_path.get("steps") or []
        if (
            instance_path.get("instance") == "commcaresession"
            and len(steps) >= 4
            and steps[:3] == ["session", "user", "data"]
            and isinstance(steps[3], str)
            and not steps[3].startswith("@")
        ):
            names.append(steps[3])
    return names


# Reading A ------------------------------------------------------------------------------------------------------


XFORMS = "http://www.w3.org/2002/xforms"
# The bind attributes that hold an expression.
BIND_EXPRESSIONS = ("relevant", "constraint", "calculate", "required", "readonly")


def _form_expressions(source):
    """Every expression of a form's binds and setvalues, parsed with lxml."""
    from lxml import etree

    if not source:
        return []
    root = etree.fromstring(source.encode("utf-8"))
    found = []
    for element in root.iter(f"{{{XFORMS}}}bind"):
        for name in BIND_EXPRESSIONS:
            value = element.get(name)
            if value and value not in ("true()", "false()"):
                found.append(value)
    for element in root.iter(f"{{{XFORMS}}}setvalue"):
        if element.get("value"):
            found.append(element.get("value"))
    return found


def _module_expressions(module):
    """A menu's case list filter, its calculated columns, its sort calculations and its search expressions."""
    found = []
    details = getattr(module, "case_details", None)
    if details is not None:
        if details.short.filter:
            found.append(details.short.filter)
        for detail in (details.short, details.long):
            for column in detail.columns:
                if column.useXpathExpression and column.field:
                    found.append(column.field)
            for element in detail.sort_elements:
                if element.sort_calculation:
                    found.append(element.sort_calculation)
    search = getattr(module, "search_config", None)
    if search is not None:
        # ``models/case_search.py::CaseSearch``: each prompt's default, required test and validations, the search
        # button's display condition and each default property's value.
        if search.search_button_display_condition:
            found.append(search.search_button_display_condition)
        for prop in search.properties:
            for value in (prop.default_value, prop.required.test, *(assertion.test for assertion in prop.validations)):
                if value:
                    found.append(value)
        for default in search.default_properties:
            if default.defaultValue:
                found.append(default.defaultValue)
                if default.property == XPATH_QUERY:
                    found.extend(_sent_query(default.defaultValue))
    return found


def _sent_query(value):
    """``[the CSQL text]`` a ``_xpath_query`` default property's value sends whatever a run gives it: the text of
    the one string literal it is, read over Core's tokens; ``[]`` for a value that works anything out at run time."""
    found = _xpath.tokens(value)
    if found is None or len(found) != 1 or found[0].kind != "STR":
        return []
    return [_xpath.string_value(found[0])]


def _writes(app):
    """``[(case type, property, question path, form)]``: every write of a form to a case property."""
    writes = []
    for module in app.get_modules():
        for form in module.get_forms():
            actions = form.actions
            if form.form_type == "module_form":
                for prop, update in actions.update_case.update.items():
                    writes.append((module.case_type, prop, update.question_path, form))
                for subcase in actions.subcases:
                    for prop, update in subcase.case_properties.items():
                        writes.append((subcase.case_type, prop, update.question_path, form))
            elif form.form_type == "advanced_form":
                for action in (*actions.load_update_cases, *actions.open_cases):
                    for prop, update in action.case_properties.items():
                        writes.append((action.case_type, prop, update.question_path, form))
    return writes


def _relationships(app):
    """``{child type: {(identifier, relationship)}}`` from every action that opens a case under an index."""
    found = {}
    for module in app.get_modules():
        for form in module.get_forms():
            actions = form.actions
            if form.form_type == "module_form":
                for subcase in actions.subcases:
                    found.setdefault(subcase.case_type, set()).add(
                        (subcase.reference_id or "parent", subcase.relationship)
                    )
            elif form.form_type == "advanced_form":
                for action in actions.open_cases:
                    for index in action.case_indices:
                        found.setdefault(action.case_type, set()).add(
                            (index.reference_id or "parent", index.relationship)
                        )
    return found


def _ordered(catalog):
    """The catalog with every type after its parent."""
    by_name = {entry["name"]: entry for entry in catalog}
    ordered, placed = [], set()

    def place(name, seen=()):
        if name in placed or name not in by_name:
            return
        if name in seen:
            raise SeedRefused(
                f"The case types {list(seen)} name each other as parents, so no order puts parents first."
            )
        parent = by_name[name]["parent_type"]
        if parent is not None:
            place(parent, (*seen, name))
        placed.add(name)
        ordered.append(by_name[name])

    for name in sorted(by_name):
        place(name)
    return ordered


def case_seed(state, app, core_runner, *, worker_location=None) -> dict:
    """The seed of A's case database, read from the app HQ holds (the module's docstring)."""
    from corehq.apps.app_manager.app_schemas.case_properties import (
        get_all_case_properties,
        get_parent_type_map,
        get_usercase_properties,
    )

    # A menu that holds no case type (a survey menu) gives ``""`` (``models/modules.py::ModuleBase.get_case_types``
    # returns ``{self.case_type}`` whatever it holds), which names no type a case can have.
    types = sorted(case_type for case_type in set(app.get_case_types()) - {USERCASE_TYPE} if case_type)
    properties = get_all_case_properties(app, exclude_invalid_properties=False)
    parents = get_parent_type_map(app)
    relationships = _relationships(app)

    questions = {}
    for module in app.get_modules():
        for form in module.get_forms():
            if form.source:
                questions[form.unique_id] = {
                    question["value"]: question for question in form.get_questions(app.langs, include_groups=True)
                }
    typed = {}
    for case_type, prop, path, form in _writes(app):
        question = questions.get(form.unique_id, {}).get(path)
        if question is None:
            continue
        data_type = VELLUM_DATA_TYPES.get(question.get("type"), "text")
        options = [option["value"] for option in question.get("options") or []]
        key = (case_type, prop)
        if key not in typed:
            typed[key] = (data_type, options)
        elif typed[key][0] != data_type:
            typed[key] = ("text", [])
        else:
            held = typed[key][1]
            typed[key] = (data_type, held + [value for value in options if value not in held])

    catalog = []
    for case_type in types:
        parent_map = parents.get(case_type) or {}
        identifiers = sorted(parent_map)
        parent_types = sorted({parent for identifier in identifiers for parent in parent_map[identifier]})
        kinds = sorted(relationships.get(case_type, set()))
        if len(identifiers) > 1 or len(parent_types) > 1 or len(kinds) > 1:
            raise SeedRefused(
                f"The case type {case_type} is indexed under {identifiers} to {parent_types} as {kinds}; a base keeps"
                " one parent, one identifier and one relationship a type, which the case database writes."
            )
        relationship = kinds[0][1] if kinds else None
        if relationship == "question":
            raise SeedRefused(
                f"The case type {case_type} is indexed with a relationship a question answers"
                " (CaseIndex.relationship: question), which no seed can write as one relationship."
            )
        names = sorted(name for name in properties.get(case_type, []) if "/" not in name and name != "name")
        catalog.append(
            {
                "name": case_type,
                "parent_type": parent_types[0] if parent_types else None,
                "relationship": relationship if parent_types else None,
                "index_identifier": identifiers[0] if identifiers else None,
                "properties": [
                    {
                        "name": name,
                        "data_type": typed.get((case_type, name), ("text", []))[0],
                        "options": list(typed.get((case_type, name), ("text", []))[1]),
                    }
                    for name in names
                ],
            }
        )

    expressions = []
    for module in app.get_modules():
        expressions.extend(_module_expressions(module))
        for form in module.get_forms():
            expressions.extend(_form_expressions(form.source))
    expressions = sorted(set(expressions))
    parsed = (
        core_runner.request("xpathParse", deadline=120.0, expressions=expressions)["results"] if expressions else []
    )

    holders = {}
    for entry in catalog:
        for prop in entry["properties"]:
            holders.setdefault(prop["name"], []).append(entry["name"])
    values = {}
    user_data = set()
    for text, result in zip(expressions, parsed, strict=True):
        if "error" in result:
            continue
        user_data.update(session_user_data(result))
        for name, literal in compared_literals(text):
            for case_type in holders.get(name, []):
                found = values.setdefault(f"{case_type}/{name}", [])
                if literal not in found:
                    found.append(literal)
    user_data.update(get_usercase_properties(app).get(USERCASE_TYPE, []))

    return {
        "catalog": _ordered(catalog),
        "values": {key: sorted(found) for key, found in sorted(values.items())},
        "userData": sorted(user_data),
        "worker": {"location": worker_location},
    }
