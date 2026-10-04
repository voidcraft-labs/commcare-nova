"""The profile properties HQ's build writes from the target rather than from the app's settings.

Keys:

- ``profile-property:<key>``: each ``<property>`` HQ's profile template
  (``templates/app_manager/profile.xml``) writes with a constant ``key``, read
  by walking the template's own Django tokens (``django.template.base.Lexer``)
  and parsing its markup with ``xml.parsers.expat``, each with its ``value``
  (a constant, or the template variable it renders), its ``force`` as the
  template writes it, and the ``{% if %}`` / ``{% for %}`` it sits in; and each
  property ``Application.create_profile`` adds to the profile's properties
  itself (``app_profile['properties'][<key>] = ...``: a literal key, or each
  value of the constant table it indexes, ``const.ANDROID_LOGO_PROPERTY_MAPPING``),
  with the conditions it is added under and its ``force`` as the template's
  ``{% if value.force %} force="true"{% endif %}`` writes it (``"true"`` for a
  true value, no ``force`` for a false one). The properties the template writes
  from the app's settings (its ``{% for %}`` over ``app_profile.properties``)
  are the ``setting`` family's.
"""

from __future__ import annotations

import ast
from pathlib import Path
from xml.parsers import expat

from proof.surface import pyast
from proof.surface.families.data import name
from proof.surface.model import Item, Sources, SurfaceError, item

TEMPLATE = "corehq/apps/app_manager/templates/app_manager/profile.xml"
CREATE_PROFILE = ("corehq/apps/app_manager/models/applications.py", "Application.create_profile")


def extract(sources: Sources) -> list[Item]:
    found: dict[str, dict] = {}
    for key, facts in template_properties(sources, sources.hq / TEMPLATE):
        found.setdefault(key, {"source": set(), "written": []})
        found[key]["source"].add(facts.pop("at"))
        found[key]["written"].append(facts)
    for key, facts in created_properties(sources, sources.hq / CREATE_PROFILE[0]):
        found.setdefault(key, {"source": set(), "written": []})
        found[key]["source"].add(facts.pop("at"))
        found[key]["written"].append(facts)
    if not found:
        raise SurfaceError("The surface extractor found no profile property HQ's build writes.")
    return [
        item(f"profile-property:{name(key)}", sorted(facts["source"]), written=facts["written"])
        for key, facts in sorted(found.items())
    ]


def template_properties(sources: Sources, path: Path) -> list[tuple[str, dict]]:
    """Each `<property>` the template writes, with its key, value, force and the blocks around it.

    The template's markup is flattened from its own Django tokens (each variable a placeholder, each block
    tag dropped and noted at its byte offset), parsed with expat, and each `<property>` is matched to the
    blocks open where its start tag begins."""
    from django.template.base import Lexer, TokenType

    tokens = Lexer(path.read_text(encoding="utf-8")).tokenize()
    variables: dict[str, str] = {}
    blocks: list[str] = []
    marks: list[tuple[int, tuple[str, ...]]] = [(0, ())]
    flat: list[str] = []
    length = 0
    for token in tokens:
        if token.token_type == TokenType.TEXT:
            text = token.contents
        elif token.token_type == TokenType.VAR:
            text = f"novavar{len(variables)}x"
            variables[text] = "{{ " + token.contents + " }}"
        elif token.token_type == TokenType.BLOCK:
            words = token.split_contents()
            if words[0] in ("if", "for", "with"):
                blocks.append(token.contents)
            elif words[0] in ("elif", "else", "empty") and blocks:
                blocks[-1] = f"{blocks[-1]} / {token.contents}"
            elif words[0] in ("endif", "endfor", "endwith") and blocks:
                blocks.pop()
            marks.append((length, tuple(blocks)))
            continue
        else:
            continue
        flat.append(text)
        length += len(text.encode("utf-8"))

    def rendered(value: str) -> str:
        for marker, expression in variables.items():
            value = value.replace(marker, expression)
        return value

    found: list[tuple[str, dict]] = []
    where = sources.relative(path)
    parser = expat.ParserCreate()

    def start(tag, attributes):
        if tag != "property":
            return
        key = attributes.get("key", "")
        if any(marker in key for marker in variables):
            # A key the template takes from a setting or a custom property: not a constant property.
            return
        offset = parser.CurrentByteIndex
        open_blocks = [stack for at, stack in marks if at <= offset][-1]
        found.append(
            (
                key,
                {
                    "at": where,
                    "value": rendered(attributes.get("value", "")),
                    "force": attributes.get("force"),
                    "when": list(open_blocks),
                },
            )
        )

    parser.StartElementHandler = start
    parser.Parse("".join(flat).encode("utf-8"), True)
    if not found:
        raise SurfaceError(f"The surface extractor found no constant <property> in {where}.")
    return found


def created_properties(sources: Sources, path: Path) -> list[tuple[str, dict]]:
    """Each property `create_profile` adds itself: `app_profile['properties'][<key>] = {...}`."""
    from corehq.apps.app_manager.models import applications

    function = pyast.find_in(path, CREATE_PROFILE[1])
    where = f"{sources.relative(path)}::{CREATE_PROFILE[1]}"
    namespace = vars(applications)

    def wanted(statement):
        return isinstance(statement, ast.Assign) and any(_properties_key(t) is not None for t in statement.targets)

    found = []
    for statement, conditions in pyast.guarded(function.body, wanted):
        for target in statement.targets:
            key = _properties_key(target)
            if key is None:
                continue
            value = statement.value
            facts = {"at": where, "value": ast.unparse(value), "when": conditions}
            if isinstance(value, ast.Dict):
                for dict_key, dict_value in zip(value.keys, value.values, strict=True):
                    if pyast.string(dict_key) == "force":
                        force = _force(dict_value)
                        if force is not None:
                            facts["force"] = force
                    elif pyast.string(dict_key) == "value":
                        facts["value"] = ast.unparse(dict_value)
            literal = pyast.string(key)
            if literal is not None:
                found.append((literal, facts))
            elif isinstance(key, ast.Subscript) and isinstance(key.value, ast.Name):
                table = namespace.get(key.value.id)
                if not isinstance(table, dict):
                    raise SurfaceError(f"{where} adds a profile property keyed by {ast.unparse(key)}, not a table.")
                for property_key in table.values():
                    found.append((property_key, {**facts, "keyFrom": ast.unparse(key)}))
            else:
                raise SurfaceError(
                    f"{where} adds a profile property keyed by {ast.unparse(key)}, which is not a constant."
                )
    if not found:
        raise SurfaceError(f"The surface extractor found no property {where} adds.")
    return found


def _force(value: ast.expr) -> str | None:
    """The ``force`` attribute the template writes for a property ``create_profile`` adds: its
    ``{% if value.force %} force="true"{% endif %}`` writes ``"true"`` for a true value and nothing for a
    false one; a value only known when HQ runs is ``"true" when <expression>``."""
    try:
        literal = ast.literal_eval(value)
    except ValueError:
        return f'"true" when {ast.unparse(value)}'
    return "true" if literal else None


def _properties_key(target: ast.expr) -> ast.expr | None:
    """`<key>` of a target `app_profile['properties'][<key>]`."""
    if (
        isinstance(target, ast.Subscript)
        and isinstance(target.value, ast.Subscript)
        and isinstance(target.value.value, ast.Name)
        and target.value.value.id == "app_profile"
        and pyast.string(target.value.slice) == "properties"
    ):
        return target.slice
    return None
