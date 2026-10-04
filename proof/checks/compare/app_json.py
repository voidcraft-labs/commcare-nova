"""The app JSON's data keys: where an object's keys are the app's data, not HQ's schema.

A JSON comparison (``compare.json_tree``) writes a key of such an object as
``*`` in a difference's structural path, so one symptom on several of the
app's properties, media or languages has one path. Proof 5 compares Nova's
uploaded app JSON with these maps, and proof 4 HQ's stored app.

An object keyed by the app's languages is one of HQ's translated fields: HQ
declares each as a map from a language code to its text
(``app_manager/models/base.py::LabelProperty``, "Stores a {lang_code:
translated_string} dict", and the ``DictProperty`` fields HQ reads the same
way: a module's and a form's ``name``, a column's ``header``...), and HQ's
own saves may hold a language the app does not (``Detail.no_items_text``'s
default is ``{'en': 'List is empty.'}``), so each such field is named by
HQ's schema (``LANGUAGE_MAPS``), wherever it sits, whatever languages it
holds. Any other object keyed only by the app's own languages is one too.
"""

from __future__ import annotations

from proof.checks.differences import pointer_token

# Objects in the app JSON whose keys are the app's data, not HQ's schema, written ``*`` in a structural path:
# media paths (``hqmedia/models.py::ApplicationMediaMixin.multimedia_map``), case property names
# (``app_manager/models/form_actions.py::UpdateCaseAction.update``, ``OpenSubCaseAction.case_properties``) and
# question paths (``PreloadAction.preload``, ``CaseReferences.load`` and ``save``), each where ``FormActions``
# and the form hold it. An object keyed only by the app's language codes is data too (``LANGUAGE_MAPS``).
DATA_MAPS = frozenset(
    {
        "/multimedia_map",
        "/modules/*/forms/*/actions/update_case/update",
        "/modules/*/forms/*/actions/usercase_update/update",
        "/modules/*/forms/*/actions/subcases/*/case_properties",
        "/modules/*/forms/*/actions/case_preload/preload",
        "/modules/*/forms/*/actions/load_from_form/preload",
        "/modules/*/forms/*/actions/usercase_preload/preload",
        "/modules/*/forms/*/case_references_data/load",
        "/modules/*/forms/*/case_references_data/save",
    }
)


def _schema_language_maps():
    """HQ's translated fields as they sit in the app JSON, each from the schema class that declares it.

    - ``Application.translations`` (``models/applications.py``): each language's catalog;
    - ``ModuleBase.name``, ``FormBase.name`` (``models/modules.py``, ``models/forms.py``), and a form's
      ``submit_label`` and ``submit_notification_label`` (``FormBase``, ``LabelProperty``);
    - ``NavMenuItemMediaMixin.media_image`` and ``media_audio`` (``models/mixins.py``), on a module, a form, a
      module's case list, referral list and task list (``CaseList``) and its case list form (``CaseListForm``),
      and each ``CustomIcon.text`` they hold (``custom_icons``);
    - ``CaseList.label`` (``models/case_list.py``) and ``CaseListForm.label`` (``models/modules.py``);
    - on each detail of a module's detail pairs (``case_details``, ``ref_details``, ``product_details``; each
      ``short`` and ``long``, ``models/case_list.py::Detail``): ``no_items_text``, ``select_text``,
      ``lookup_field_header`` (``CaseListLookupMixin``), each column's ``header`` (``DetailColumn``) and its
      enum items' ``value`` and ``alt_text`` (``MappingItem``), each tab's ``header`` (``DetailTab``) and each
      sort element's ``display`` (``SortElement``);
    - a module's ``search_config`` (``models/case_search.py::CaseSearch``): ``search_button_label``,
      ``title_label``, ``description``, and each property's ``label`` and ``hint`` (``CaseSearchProperty``),
      with the ``text`` of its ``required`` and each of its ``validations`` (``models/base.py::Assertion``).
    """
    module, form = "/modules/*", "/modules/*/forms/*"
    found = {"/translations", f"{module}/name", f"{form}/name", f"{form}/submit_label"}
    found.add(f"{form}/submit_notification_label")
    menus = [module, form, *(f"{module}/{name}" for name in ("case_list", "referral_list", "task_list"))]
    menus.append(f"{module}/case_list_form")
    for menu in menus:
        found |= {f"{menu}/media_image", f"{menu}/media_audio", f"{menu}/custom_icons/*/text"}
    found |= {f"{module}/{name}/label" for name in ("case_list", "referral_list", "task_list", "case_list_form")}
    for pair in ("case_details", "ref_details", "product_details"):
        for side in ("short", "long"):
            detail = f"{module}/{pair}/{side}"
            found |= {f"{detail}/{name}" for name in ("no_items_text", "select_text", "lookup_field_header")}
            found |= {f"{detail}/columns/*/header", f"{detail}/columns/*/enum/*/value"}
            found |= {f"{detail}/columns/*/enum/*/alt_text", f"{detail}/tabs/*/header"}
            found.add(f"{detail}/sort_elements/*/display")
    search = f"{module}/search_config"
    found |= {f"{search}/{name}" for name in ("search_button_label", "title_label", "description")}
    found |= {f"{search}/properties/*/{name}" for name in ("label", "hint", "required/text")}
    found.add(f"{search}/properties/*/validations/*/text")
    return frozenset(found)


LANGUAGE_MAPS = _schema_language_maps()


def _walk(value, path, langs, found):
    if isinstance(value, dict):
        keyed = (path or "/") in LANGUAGE_MAPS or (bool(value) and set(value) <= langs)
        if keyed:
            found.add(path or "/")
        for key, item in value.items():
            step = "*" if keyed or (path or "/") in DATA_MAPS else pointer_token(key)
            _walk(item, f"{path}/{step}", langs, found)
    elif isinstance(value, list):
        for item in value:
            _walk(item, f"{path}/*", langs, found)


def language_maps(value, path, langs, found):
    """``found`` with the structural path of every object keyed by languages added: each of HQ's translated
    fields (``LANGUAGE_MAPS``, wherever either side holds it), and any other object in ``value`` (at ``path``)
    keyed only by the app's language codes."""
    found |= LANGUAGE_MAPS
    _walk(value, path, langs, found)
    return found
