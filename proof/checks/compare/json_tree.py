"""Two JSON values compared as trees, reporting every difference.

Objects are compared member by member, arrays position by position (the
longer array's extra members are ``added`` or ``removed``), and a member whose
JSON type differs is ``changed`` whole. Paths are JSON Pointers: ``at`` holds
every concrete key and index, and ``path`` holds each array index as ``*``
and each key of a map the caller names as data (``data_maps``: the pointer
paths, themselves in structural form, of objects whose keys are values
rather than schema, such as case types or media paths) as ``*`` too. A map
whose keys are the app's data beside a few a reader gives meaning to (a case
block's ``update``, whose ``case_name`` is the case's own name and every
other key a case property) is named with those keys: ``data_maps`` is then a
mapping from each such path to the keys it keeps (empty for a map whose
every key is data), or to a function giving each key's token in ``path``
for a map whose keys the caller writes itself (HQ's case blocks keyed by
where the form holds them, ``proof.checks.proof3``).
"""

from __future__ import annotations

from proof.checks.differences import Difference, pointer_token

_MISSING = object()


def _json_type(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    raise TypeError(f"{type(value).__name__} is not a JSON value")


def _kept_keys(data_maps, path):
    """The keys a data map at ``path`` keeps in a structural path, or the function writing each (None where
    ``path`` is not a data map)."""
    if path not in data_maps:
        return None
    return data_maps[path] if isinstance(data_maps, dict) else frozenset()


def compare_json(before, after, *, check, document, artifact, data_maps=frozenset(), root_path="", root_at=""):
    """Every difference between two JSON values, as ``Difference``s of ``artifact``."""
    found = []

    def report(path, at, kind, a, b):
        found.append(
            Difference(
                check=check,
                document=document,
                artifact=artifact,
                path=path or "/",
                at=at or "/",
                kind=kind,
                before=None if a is _MISSING else a,
                after=None if b is _MISSING else b,
            )
        )

    def walk(a, b, path, at):
        if a is _MISSING:
            report(path, at, "added", a, b)
            return
        if b is _MISSING:
            report(path, at, "removed", a, b)
            return
        kind_a, kind_b = _json_type(a), _json_type(b)
        if kind_a != kind_b:
            report(path, at, "changed", a, b)
            return
        if kind_a == "object":
            kept = _kept_keys(data_maps, path or "/")
            written = kept if callable(kept) else None
            for key in sorted(set(a) | set(b), key=str):
                token = pointer_token(key)
                if written is not None:
                    shown = written(key)
                else:
                    shown = "*" if kept is not None and key not in kept else token
                walk(a.get(key, _MISSING), b.get(key, _MISSING), f"{path}/{shown}", f"{at}/{token}")
        elif kind_a == "array":
            for index in range(max(len(a), len(b))):
                walk(
                    a[index] if index < len(a) else _MISSING,
                    b[index] if index < len(b) else _MISSING,
                    f"{path}/*",
                    f"{at}/{index}",
                )
        elif a != b:
            report(path, at, "changed", a, b)

    walk(before, after, root_path, root_at)
    return found
