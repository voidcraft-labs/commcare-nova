"""A form's ``case_references_data.load``, which only HQ's app summary reads.

Every Vellum save posts the form's case references anew from what its
expressions read of cases (``Vellum/src/core.js`` sends
``logic.js::caseReferences()`` as ``case_references``), and HQ's form save
stores them (``views/forms.py::_get_case_references``), so a form Nova
writes gains and loses entries in ``load``. HQ reads ``load`` in one place,
``app_schemas/app_case_metadata.py::_FormCaseMetadataBuilder.
_add_load_references`` (through ``CaseReferences.get_load_references``),
which builds the case metadata the app summary and the form metadata show
(``Application.get_case_metadata``); every other reader of
``case_references_data`` reads ``save`` (``models/forms.py::FormBase.
get_save_to_case_updates``, ``helpers/validators.py::IndexedFormBaseValidator.
check_save_to_case_references``), and no build step reads ``load``.

The rule removes ``load`` from every form's ``case_references_data`` in
HQ's app document.
"""

from __future__ import annotations

from proof.rules import SpellingRule


def normalize(app):
    if not isinstance(app, dict):
        return app
    for module in app.get("modules") or []:
        for form in (module or {}).get("forms") or []:
            references = (form or {}).get("case_references_data")
            if isinstance(references, dict):
                references.pop("load", None)
    return app


RULE = SpellingRule(
    "case-references-load",
    "app.json",
    "A form's case_references_data.load, which only the app summary reads"
    " (app_case_metadata.py::_FormCaseMetadataBuilder._add_load_references).",
    normalize,
)
