"""What Formplayer answered, as canonical JSON that is the same on every run of the same inputs.

Formplayer's answers hold values it generates itself, which no input decides:
each form session's and menu session's id (``java.util.UUID.randomUUID``,
through Hibernate and ``VirtualDataInstanceService``), and the ids an app's
logic draws (``uuid()``, a form's ``instanceID``), which come from Core's
seeded random source in the order the JVM's requests reach it. ``mark``
replaces each with ``@generated:uuid:N``, N counting the generated ids in the
order they first appear in what is marked, as the Core runner marks its traces
(``proof/core/src/nova/proof/core/Generated.java``): an id is generated when
it is shaped as ``UUID.randomUUID`` and Core's ``genUUID`` shape one
(8-4-4-4-12 lowercase hex, version 4, variant 8 to b), is a whole value (a
JSON string, or the text or an attribute of an XML document a JSON string
holds), and occurs nowhere in the inputs. An id an app or a restore authors
stays as it is. Each generated id is then replaced wherever it occurs, also
inside longer text.

``encode`` writes a marked value as the canonical bytes a record keeps: keys
sorted, no insignificant space, non-ASCII text kept as it is.

XML is read with lxml, never by pattern: a string is XML when lxml parses it
whole.
"""

from __future__ import annotations

import json
import zipfile
from collections.abc import Iterable
from io import BytesIO

HEX = frozenset("0123456789abcdef")
DASHES = (8, 13, 18, 23)
TOKEN = "@generated:uuid:"


def is_generated_shape(value: str) -> bool:
    """Whether ``value`` is shaped as a version 4 UUID in lowercase, as the JVM's and Core's generators shape one."""
    if len(value) != 36:
        return False
    for index, character in enumerate(value):
        if index in DASHES:
            if character != "-":
                return False
        elif character not in HEX:
            return False
    return value[14] == "4" and value[19] in "89ab"


def ids_in_text(text: str) -> set[str]:
    """Every id-shaped stretch of an input's text: an id found here was given, not generated."""
    found = set()
    for start in range(0, len(text) - 35):
        if text[start + 8] == "-" and text[start + 13] == "-" and is_generated_shape(text[start : start + 36]):
            found.add(text[start : start + 36])
    return found


def given_ids(texts: Iterable[bytes | str] = (), archives: Iterable[bytes] = ()) -> set[str]:
    """The ids the inputs hold: in each text, and in each text entry of each archive (media is not text)."""
    found: set[str] = set()
    for text in texts:
        if isinstance(text, bytes | bytearray):
            text = bytes(text).decode("utf-8", "replace")
        found |= ids_in_text(text)
    for archive in archives:
        with zipfile.ZipFile(BytesIO(archive)) as zipped:
            for name in zipped.namelist():
                try:
                    found |= ids_in_text(zipped.read(name).decode("utf-8"))
                except UnicodeDecodeError:
                    continue
    return found


def _xml_values(text: str):
    """The text and attribute values of an XML document a string holds, or None where it holds none."""
    stripped = text.strip()
    if not (stripped.startswith("<") and stripped.endswith(">")):
        return None
    from lxml import etree

    try:
        root = etree.fromstring(stripped.encode("utf-8"), etree.XMLParser(resolve_entities=False, no_network=True))
    except (etree.XMLSyntaxError, ValueError):
        return None
    values = []
    for element in root.iter():
        if not isinstance(element.tag, str):
            continue
        values.extend(element.attrib.values())
        if element.text:
            values.append(element.text.strip())
        if element.tail:
            values.append(element.tail.strip())
    return values


def _whole_values(value):
    """Every whole string value of a JSON value in key order, with the values of each XML document a string holds."""
    if isinstance(value, dict):
        for key in sorted(value):
            yield from _whole_values(value[key])
    elif isinstance(value, list):
        for item in value:
            yield from _whole_values(item)
    elif isinstance(value, str):
        held = _xml_values(value)
        if held is None:
            yield value
        else:
            yield from held


def _replaced(value, tokens, longest_first):
    if isinstance(value, dict):
        return {
            _replaced(key, tokens, longest_first): _replaced(item, tokens, longest_first) for key, item in value.items()
        }
    if isinstance(value, list):
        return [_replaced(item, tokens, longest_first) for item in value]
    if isinstance(value, str):
        for generated in longest_first:
            if generated in value:
                value = value.replace(generated, tokens[generated])
        return value
    return value


def mark(value, given: set[str]):
    """``value`` with every generated id replaced by its token, and how many ids were generated."""
    tokens: dict[str, str] = {}
    for held in _whole_values(value):
        if is_generated_shape(held) and held not in given and held not in tokens:
            tokens[held] = f"{TOKEN}{len(tokens) + 1}"
    return _replaced(value, tokens, sorted(tokens, key=len, reverse=True)), len(tokens)


def replace_text(value, replacements: dict[str, str]):
    """``value`` with each key of ``replacements`` written as its value wherever it occurs, also inside longer
    text and in keys: an id HQ drew for a build, which names the same thing in two traces."""
    return _replaced(value, replacements, sorted(replacements, key=len, reverse=True))


def encode(value) -> bytes:
    """The canonical bytes of a JSON value."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
