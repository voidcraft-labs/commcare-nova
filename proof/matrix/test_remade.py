"""A made again from its retained document (``proof/hq/operations.py::save_authored_app``) is the app HQ made.

The unit makes an ``hq-authored`` document's A from ``proof/hq-apps/<base>/``
alone: its lookup tables and places with HQ's models
(``save_authored_tables``, ``save_authored_places``), then the app from its
stored document through ``from_source`` and ``save_attachments``, with each
mapped file attached as HQ's template loader attaches one. The contract: the
app so made, as ``retain.stored_document`` writes it, is the retained
``app.json`` but for what every save of an app writes and no author does:
``Application._meta_fields`` (its id, revision, domain, version and the
three fields a build fills) and ``last_modified``
(``models/applications.py::ApplicationBase.save`` sets it from the clock on
every save). Its menu ids, form ids and ``xmlns`` are compared first, by
name, since the emission read those. The plausible failure: A in the unit
holding other ids or other content than the emission read, so every check of
the hop compares Nova's publish with an app the reading never saw. Where a
field differs because HQ's model rewrites it on wrap, ``app.json`` is
written after one wrap round (``retain.stored_document``) and is a fixed
point; where one differs for another reason, this test names it. The places,
their levels and the project space's location fields made again are the
retained ``places.json`` (``retain.places_of``), so a base whose fields the
unit left out, and whose workers' restores on A then hold no place's
``location_data``, fails here by name.
"""

from __future__ import annotations

import json

import pytest

from proof.matrix.registry import BASES, HQ_APPS

# What every save of an app writes and no author does (``Application._meta_fields`` and ``last_modified``).
SAVE_WRITES = ("_id", "_rev", "domain", "copy_of", "version", "short_odk_url", "short_odk_media_url", "last_modified")


def _identities(document):
    return {
        "menus": [module.get("unique_id") for module in document.get("modules", [])],
        "forms": [
            [form.get("unique_id") for form in module.get("forms", [])] for module in document.get("modules", [])
        ],
        "xmlns": [[form.get("xmlns") for form in module.get("forms", [])] for module in document.get("modules", [])],
    }


def _differences(left, right, path=""):
    if isinstance(left, dict) and isinstance(right, dict):
        found = []
        for key in sorted(set(left) | set(right)):
            if key not in left or key not in right:
                found.append(f"{path}/{key}")
            else:
                found.extend(_differences(left[key], right[key], f"{path}/{key}"))
        return found
    if isinstance(left, list) and isinstance(right, list) and len(left) == len(right):
        pairs = enumerate(zip(left, right, strict=True))
        return [found for index, (a, b) in pairs for found in _differences(a, b, f"{path}/{index}")]
    return [] if left == right else [path or "/"]


def _media(directory):
    from proof.hq.operations import AuthoredMedia

    rows = (
        json.loads((directory / "media.json").read_text(encoding="utf-8"))
        if (directory / "media.json").is_file()
        else []
    )
    return [
        AuthoredMedia(
            path=row["path"],
            data=(directory / row["file"]).read_bytes(),
            original_filename=row["path"].rsplit("/", 1)[-1],
        )
        for row in rows
    ]


@pytest.mark.parametrize("base", BASES, ids=[base.id for base in BASES])
def test_an_authored_app_is_remade_with_its_ids(hq, base):
    from proof.hq import operations
    from proof.hq.check import hq_check
    from proof.matrix.retain import places_of, stored_document

    directory = HQ_APPS / base.id
    if not (directory / "app.json").is_file():
        pytest.fail(
            f"proof/hq-apps/{base.id}/ holds no app.json, so no A can be made of it. Author the base"
            " (proof/matrix/test_retained.py) and adopt what it wrote (python3 -m proof.matrix.adopt <output>)."
        )
    document = json.loads((directory / "app.json").read_text(encoding="utf-8"))
    places = (
        json.loads((directory / "places.json").read_text("utf-8")) if (directory / "places.json").is_file() else None
    )
    with hq_check(base.configuration) as (state, _):
        with state.operation("remade", base.id.encode()):
            if (directory / "tables.json").is_file():
                operations.save_authored_tables(state, json.loads((directory / "tables.json").read_text("utf-8")))
            if places is not None:
                operations.save_authored_places(state, places)
            app_id = operations.save_authored_app(state, document, _media(directory))
            remade = json.loads(json.dumps(stored_document(operations.held_app(state, app_id))))
            remade_places = places_of(state)
    # The places, their levels and the location fields made again are the ones retained: without the fields HQ's
    # flat location list writes no location_data, and a worker's restore on A holds none of a place's properties.
    assert remade_places == places, (
        f"The places made again from proof/hq-apps/{base.id}/places.json are not the ones retained there: HQ holds"
        f" {remade_places}."
    )
    assert _identities(remade) == _identities(document), (
        f"The app made again from proof/hq-apps/{base.id}/app.json holds other menu ids, form ids or xmlns than"
        " the app HQ made, which the emission read."
    )
    differing = _differences(
        {key: value for key, value in remade.items() if key not in SAVE_WRITES},
        {key: value for key, value in document.items() if key not in SAVE_WRITES},
    )
    assert not differing, (
        f"The app made again from proof/hq-apps/{base.id}/app.json differs from it at {differing}. Where HQ's model"
        " rewrites a field on wrap, app.json is written after one wrap round; where it does not, the unit makes A"
        " otherwise than HQ made it."
    )
