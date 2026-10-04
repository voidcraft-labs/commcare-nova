"""Undeclared keys, descriptor attributes and the dispatchers of the app schema.

Contracts and the failures they catch:
- ``schema:<Class>.<undeclared>`` says what HQ's wrapping does with a key the
  class does not declare, and a descriptor attribute says whether a key
  naming it is refused: HQ's own ``wrap`` (on classes whose ``wrap`` reads
  nothing outside the document) keeps an undeclared key and refuses
  ``can_edit_in_vellum`` with ``WrappingAttributeError``, as the items say. An
  extractor that listed a declared key, a method or a ``_``-prefixed name as a
  descriptor, or got the setter wrong, fails.
- A form's source is ``schema:Form.source``, a ``FormSource`` descriptor with a
  setter, not a declared key.
- Each dispatcher item names the doc types HQ's dispatcher accepts and the
  refusal it raises otherwise: running ``ModuleBase.wrap``, ``FormBase.wrap``
  and ``get_correct_app_class`` on an unknown doc type raises what the item
  records. A refusal planted in a temporary copy of ``get_correct_app_class``
  is read into its item's ``otherwise``, and the unplanted surface has none.
"""

from __future__ import annotations

import dataclasses

import pytest

from proof.surface.families.app_schema import DISPATCHERS, _dispatchers


def test_undeclared_keys_and_descriptors_behave_as_hq_wraps_them(items, hq):
    from corehq.apps.app_manager import models
    from jsonobject.exceptions import WrappingAttributeError

    for cls in (models.Module, models.Form, models.AdvancedForm, models.Detail, models.CaseSearch):
        undeclared = items[f"schema:{cls.__name__}.<undeclared>"]
        wrapped = cls.wrap({"doc_type": cls.__name__, "surface_undeclared_probe": "x"}).to_json()
        assert undeclared["kept"] is ("surface_undeclared_probe" in wrapped), cls.__name__
    refused = items["schema:AdvancedForm.can_edit_in_vellum"]
    assert refused["declared"] is False and refused["setter"] is False
    with pytest.raises(WrappingAttributeError):
        models.AdvancedForm.wrap({"doc_type": "AdvancedForm", "can_edit_in_vellum": True})
    for key, facts in items.items():
        if key.startswith("schema:") and facts.get("descriptor"):
            assert facts["declared"] is False and not key.rsplit(".", 1)[1].startswith("_"), key
    source = items["schema:Form.source"]
    assert source["descriptor"] == "FormSource" and source["setter"] is True


def test_dispatchers_refuse_what_the_items_say(items, hq):
    from corehq.apps.app_manager import models
    from corehq.apps.app_manager.util import get_correct_app_class
    from couchdbkit.exceptions import DocTypeError

    for by, call, refusal in (
        ("ModuleBase.wrap", lambda: models.ModuleBase.wrap({"doc_type": "SurfaceProbe"}), ValueError),
        ("FormBase.wrap", lambda: models.FormBase.wrap({"doc_type": "SurfaceProbe"}), ValueError),
        ("get_correct_app_class", lambda: get_correct_app_class({"doc_type": "SurfaceProbe"}), DocTypeError),
    ):
        facts = items[f"schema:dispatch({by})"]
        assert facts["accepts"] and "SurfaceProbe" not in facts["accepts"]
        assert any(refusal.__name__ in exit["exit"] for exit in facts["otherwise"]), (by, facts["otherwise"])
        with pytest.raises(refusal):
            call()
    for doc_type in items["schema:dispatch(get_correct_app_class)"]["accepts"]:
        assert get_correct_app_class({"doc_type": doc_type}).__name__ in doc_type


def test_a_planted_refusal_in_a_dispatcher_is_read(plant, sources, items, hq):
    util = DISPATCHERS[2][1]
    root = plant(
        sources.hq,
        sorted({relative for _, relative, _ in DISPATCHERS}),
        {
            util: (
                "def get_correct_app_class(doc):\n    try:\n",
                "def get_correct_app_class(doc):\n    if doc.get('planted'):\n"
                "        raise PlantedRefusal(doc['planted'])\n    try:\n",
            )
        },
    )
    accepted = {object: [{"by": by, "docType": "Planted"} for by, _, _ in DISPATCHERS]}
    planted = {one.key: one.facts for one in _dispatchers(dataclasses.replace(sources, hq=root), accepted)}
    refusals = [exit["exit"] for exit in planted["schema:dispatch(get_correct_app_class)"]["otherwise"]]
    assert "raise PlantedRefusal(doc['planted'])" in refusals
    unplanted = [exit["exit"] for exit in items["schema:dispatch(get_correct_app_class)"]["otherwise"]]
    assert unplanted and "raise PlantedRefusal(doc['planted'])" not in unplanted
