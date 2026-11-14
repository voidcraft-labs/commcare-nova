"""A form's ``form_filter`` ``""``, or null.

Nova writes a form with no display condition with ``form_filter`` null.
HQ's form settings save writes ``""`` there wherever the page shows the
Display Condition field: the field is a textarea named ``form_filter``
(``partials/forms/form_filter.html``, rendered where the app's
``display_conditions`` add-on shows), the save posts the form whole
(``hqwebapp/js/bootstrap5/main.js::SaveButton.initForm``, ``$form.serialize()``),
and ``views/forms.py::_edit_form_attr`` stores what it posts. An advanced
form keeps the ``""`` (``models/forms.py::AdvancedForm.form_filter``); a basic
one stores neither, since ``Form.form_filter`` is ``exclude_if_none`` and
jsonobject leaves out every value that is not truthy
(``base_properties.pyx::JsonProperty.exclude``).

HQ's build, its validator and the add-on that shows the field read the value
only where it is truthy: ``suite_xml/sections/menus.py``
(``getattr(form, 'form_filter', None)``), ``helpers/validators.py``
(``self.form.form_filter``) and ``add_ons.py`` (``used_in_form``). One reader
tells the two apart, and it is no build: the form summary's comparison of two
versions (``views/app_summary.py::FormSummaryDiffView``, through
``app_schemas/form_metadata.py::_AppDiffGenerator._mark_attribute``, which
tests ``first_item[attribute] != second_item[attribute]``) marks a form whose
filter is ``""`` in one version and null in the other as changed, so its
"View Changed Items" filter keeps that form and its menu, while the filter
line itself stays hidden on both sides (``form_summary_base.html``,
``ko if: form_filter``). A version saved in HQ compared with Nova's next
publish shows that form as changed, as ``case-references-load``'s summary
reader does for its field.

The rule makes ``""`` null on every form.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import forms, modules


def normalize(app):
    for module in modules(app):
        for form in forms(module):
            if form.get("form_filter") == "":
                form["form_filter"] = None
    return app


RULE = SpellingRule(
    "form-filter-blank",
    "app.json",
    "A form's form_filter \"\" rather than null, which HQ's build reads as no display condition"
    " (suite_xml/sections/menus.py) and only the form summary's comparison of two versions tells apart.",
    normalize,
)
