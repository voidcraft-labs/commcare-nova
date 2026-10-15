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
- ``profile-feature:<name>``: each child of the template's ``<features>`` HQ
  writes for every app whatever its settings: a child with a constant name,
  outside every ``{% if %}`` and ``{% for %}``, whose ``active`` reads no
  template variable (``checkoff``, ``reminders`` and ``package`` at the
  pins). Each records ``active`` as the template writes it, one part per
  branch of a block tag inside the attribute, each with the blocks it is
  written under (``checkoff`` is ``true`` under ``if is_odk`` and ``false``
  under its ``else``). ``users``, ``dependencies``, ``credentials`` and the
  loop over ``app_profile.features`` are the ``setting`` family's.
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
    features: dict[str, dict] = {}
    for feature, facts in template_features(sources, sources.hq / TEMPLATE):
        features.setdefault(feature, {"source": set(), "written": []})
        features[feature]["source"].add(facts.pop("at"))
        features[feature]["written"].append(facts)
    return [
        *(
            item(f"profile-property:{name(key)}", sorted(facts["source"]), written=facts["written"])
            for key, facts in sorted(found.items())
        ),
        *(
            item(f"profile-feature:{name(feature)}", sorted(facts["source"]), written=facts["written"])
            for feature, facts in sorted(features.items())
        ),
    ]


def _flattened(path: Path) -> tuple[str, dict[str, str], dict[str, tuple[str, ...]], list]:
    """The template's markup flattened from its own Django tokens (``django.template.base.Lexer``).

    Each variable is a placeholder (``novavar<n>x``, mapped to the variable it renders). A block tag is a marker
    (``novablock<n>x``, mapped to the blocks open after it) where expat parses the markup with that marker in
    place, which is inside an attribute's value or between elements, so a value can be read back by the parts its
    block tags divide it into; a block tag between a tag's attributes is dropped. ``marks`` holds each block
    tag's byte offset in the flat text with the blocks open after it."""
    from django.template.base import Lexer, TokenType

    tokens = Lexer(path.read_text(encoding="utf-8")).tokenize()
    variables: dict[str, str] = {}
    blocks: list[str] = []
    pieces: list[tuple[str, tuple[str, ...] | None]] = []
    for token in tokens:
        if token.token_type == TokenType.TEXT:
            pieces.append((token.contents, None))
        elif token.token_type == TokenType.VAR:
            text = f"novavar{len(variables)}x"
            variables[text] = "{{ " + token.contents + " }}"
            pieces.append((text, None))
        elif token.token_type == TokenType.BLOCK:
            words = token.split_contents()
            if words[0] in ("if", "for", "with"):
                blocks.append(token.contents)
            elif words[0] in ("elif", "else", "empty") and blocks:
                blocks[-1] = f"{blocks[-1]} / {token.contents}"
            elif words[0] in ("endif", "endfor", "endwith") and blocks:
                blocks.pop()
            pieces.append((f"novablock{len(pieces)}x", tuple(blocks)))

    def markup(kept: set[int]) -> str:
        return "".join(text for at, (text, stack) in enumerate(pieces) if stack is None or at in kept)

    def parses(text: str) -> bool:
        try:
            expat.ParserCreate().Parse(text.encode("utf-8"), True)
        except expat.ExpatError:
            return False
        return True

    kept = {at for at, (_, stack) in enumerate(pieces) if stack is not None and parses(markup({at}))}
    block_markers: dict[str, tuple[str, ...]] = {}
    marks: list[tuple[int, tuple[str, ...]]] = [(0, ())]
    length = 0
    for at, (text, stack) in enumerate(pieces):
        if stack is not None:
            marks.append((length, stack))
            if at not in kept:
                continue
            block_markers[text] = stack
        length += len(text.encode("utf-8"))
    return markup(kept), variables, block_markers, marks


def template_properties(sources: Sources, path: Path) -> list[tuple[str, dict]]:
    """Each `<property>` the template writes, with its key, value, force and the blocks around it.

    The template's markup is flattened (``_flattened``), parsed with expat, and each `<property>` is matched to
    the blocks open where its start tag begins."""
    flat, variables, block_markers, marks = _flattened(path)

    def rendered(value: str) -> str:
        for marker in block_markers:
            value = value.replace(marker, "")
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
    parser.Parse(flat.encode("utf-8"), True)
    if not found:
        raise SurfaceError(f"The surface extractor found no constant <property> in {where}.")
    return found


def template_features(sources: Sources, path: Path) -> list[tuple[str, dict]]:
    """Each child of the template's `<features>` HQ writes for every app whatever its settings.

    That is a child with a constant name, outside every block, whose ``active`` reads no template variable.
    Its ``active`` is recorded as the template writes it: one part per branch of a block tag inside the
    attribute, each with the blocks it is written under, so ``checkoff`` is ``true`` under ``if is_odk`` and
    ``false`` under its ``else``. A child under an ``{% if %}`` or ``{% for %}``, one whose name or ``active``
    the template renders from a variable (``users``, ``dependencies``, ``credentials`` and the loop over
    ``app_profile.features``) is an app's setting, the ``setting`` family's."""
    flat, variables, block_markers, marks = _flattened(path)
    found: list[tuple[str, dict]] = []
    where = sources.relative(path)
    parser = expat.ParserCreate()
    depth: list[str] = []

    def parts(value: str, outer: tuple[str, ...]) -> list[dict]:
        written = []
        stack = outer
        for piece in _split_markers(value, block_markers):
            if piece in block_markers:
                stack = block_markers[piece]
            elif piece:
                written.append({"value": piece, "when": list(stack[len(outer) :])})
        return written

    def start(tag, attributes):
        parent = depth[-1] if depth else None
        depth.append(tag)
        if parent != "features":
            return
        offset = parser.CurrentByteIndex
        open_blocks = [stack for at, stack in marks if at <= offset][-1]
        active = attributes.get("active")
        if (
            open_blocks
            or any(marker in tag for marker in (*variables, *block_markers))
            or active is None
            or any(marker in active for marker in variables)
        ):
            return
        found.append((tag, {"at": where, "active": parts(active, open_blocks)}))

    def end(tag):
        depth.pop()

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.Parse(flat.encode("utf-8"), True)
    if not found:
        raise SurfaceError(f"The surface extractor found no constant child of <features> in {where}.")
    return found


def _split_markers(value: str, markers: dict[str, tuple[str, ...]]) -> list[str]:
    """``value`` as its text pieces and the block markers between them, in order."""
    pieces: list[str] = []
    rest = value
    while rest:
        found = [(rest.find(marker), marker) for marker in markers if marker in rest]
        if not found:
            pieces.append(rest)
            break
        at, marker = min(found)
        pieces.extend([rest[:at], marker])
        rest = rest[at + len(marker) :]
    return pieces


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
