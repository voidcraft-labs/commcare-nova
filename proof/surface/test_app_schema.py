"""The app schema family.

Contracts and the failures they catch:
- Every class HQ's four dispatchers can choose by ``doc_type`` is in the
  schema: the report filters ``ReportAppFilter.wrap`` chooses are reached only
  through that dispatch, never through a property, so a walk seeded without it
  drops them.
- A key's recorded default is the JSON HQ writes when a document leaves the
  key out. The test holds it against an independent reading: HQ wrapping a
  document that has only its ``doc_type`` and printing it back.
- The legacy ``contents`` spelling ``FormSource.__get__`` migrates is an item
  on every form class, and ``NumericFilter.operator`` (a tuple, not a
  property, at the pin) is not a declared key.
- The pass over wraps and descriptors finds its readers through the booted
  HQ and reads their source from the checkout it is given: a legacy key
  planted in ``FormSource.__get__`` in a temporary copy of ``models/forms.py``
  is read on ``Form``; the unplanted checkout does not have it.
- A key an HQ constructor fills records that constructor instead of passing
  the declared ``default`` off as what HQ writes: ``ReportAppConfig.uuid``'s
  property defaults to ``None``, yet a new ``ReportAppConfig`` holds a fresh
  id.
"""

from __future__ import annotations

import dataclasses

from proof.surface.families.app_schema import _raw_accesses


def test_every_dispatched_class_is_in_the_schema(items, hq):
    from corehq.apps.app_manager.models.report_app_config import get_all_mobile_filter_configs
    from corehq.apps.app_manager.util import app_doc_types

    dispatched = {config.filter_class.__name__ for config in get_all_mobile_filter_configs()}
    dispatched |= {cls.__name__ for cls in app_doc_types().values()}
    dispatched |= {"Module", "AdvancedModule", "ReportModule", "ShadowModule", "Form", "AdvancedForm", "ShadowForm"}
    for name in dispatched:
        assert f"schema:{name}" in items, name
    filters = [
        key for key, facts in items.items() if any(d["by"] == "ReportAppFilter.wrap" for d in facts.get("dispatch", []))
    ]
    assert len(filters) == len(get_all_mobile_filter_configs())


def test_recorded_defaults_are_what_hq_writes_for_a_missing_key(items, hq):
    from corehq.apps.app_manager import models

    for cls in (models.Module, models.Form, models.Detail, models.DetailColumn, models.CaseSearch):
        written = cls.wrap({"doc_type": cls.__name__}).to_json()
        for key, value in written.items():
            facts = items.get(f"schema:{cls.__name__}.{key}")
            assert facts is not None, f"{cls.__name__} writes {key}, which the schema lacks"
            assert facts["declared"] is True and facts["default"] == value, (cls.__name__, key, facts, value)


def test_legacy_and_non_property_keys(items):
    for form in ("Form", "AdvancedForm", "ShadowForm"):
        contents = items[f"schema:{form}.contents"]
        assert contents["declared"] is False
        assert contents["rawReads"] == [
            {
                "access": ["delete", "read"],
                "at": "commcare-hq/corehq/apps/app_manager/models/forms.py::FormSource.__get__",
            }
        ]
    assert items["schema:NumericFilter.operand"]["declared"] is True
    assert "schema:NumericFilter.operator" not in items
    assert items["schema:Detail.display"]["choices"] == ["short", "long"]


def test_the_raw_key_pass_reads_a_planted_migration(plant, sources, hq):
    from corehq.apps.app_manager import models

    forms = "corehq/apps/app_manager/models/forms.py"
    root = plant(
        sources.hq,
        [forms],
        {
            forms: (
                "            old_contents = form['contents']\n",
                "            old_contents = form['contents']\n            form.pop('planted_legacy', None)\n",
            )
        },
    )
    planted = _raw_accesses(dataclasses.replace(sources, hq=root), models.Form)
    assert planted["planted_legacy"] == [
        {"access": ["pop"], "at": "commcare-hq/corehq/apps/app_manager/models/forms.py::FormSource.__get__"}
    ]
    assert "planted_legacy" not in _raw_accesses(sources, models.Form)


def test_a_key_hqs_constructor_fills(items, hq):
    from corehq.apps.app_manager.models import ReportAppConfig

    facts = items["schema:ReportAppConfig.uuid"]
    assert facts["default"] is None and ReportAppConfig._properties_by_key["uuid"].default() is None
    assert ReportAppConfig().uuid
    assert facts["defaultComputedBy"] == "corehq.apps.app_manager.models.report_app_config.ReportAppConfig.__init__"
    assert facts["defaultComputedAs"] == "uuid.uuid4().hex"
    assert facts["defaultComputedWhen"] == ["not self.uuid"]
