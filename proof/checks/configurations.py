"""The privileges a corpus document's content needs, and its configurations as the checks read them.

A corpus document's minimum configuration grants exactly the plan
privileges its content needs: HQ refuses to build, drops, or keeps its
editors from offering that content on a plan without them, so a check that
ran without them would report the plan, not a defect. ``PRIVILEGE_RULES``
holds one rule per privilege row of the research's gates file that content
can need (``lib/commcare/surface/entries/gates.json``, the privilege
entries). Each rule names the HQ reader that makes the content need its
privilege and decides, from HQ's own model of the app, whether the app holds
that content; where HQ has a predicate for the content, the rule calls it.

The rules read the app as HQ's import receives it: each app Nova's publish
sends for the document under its minimum configuration (the create of D,
``export/minimum/create``, and the update to D′,
``edit/export/minimum/update``), wrapped by HQ's own ``Application.wrap``,
and whether either publish pushed a lookup workbook first (its sidecar names
one). The corpus emission never starts HQ, so a document's
``configurations.json`` states only the privileges a reproduction names
(``namedPrivileges``); ``privileges_for`` adds what the content needs, in the
lane, where HQ runs. It boots HQ (``proof.hq.boot``) and reaches no network
and no database, and remembers each document's derivation for the process.

``python -m proof.checks.configurations <corpus> [<output.json>]`` derives
every document's privileges per configuration and writes
``{<id>: {<configuration>: [<privilege constant>...]}}`` (to standard output
without an output file).

``read_configurations`` reads a document's ``configurations.json`` into
``proof.hq.configuration.Configuration`` values, each with the privileges
``privileges_for`` gives it.
"""

from __future__ import annotations

import functools
import json
import sys
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

from proof.hq.configuration import DEFAULT_COMMCARE_VERSION as CORPUS_COMMCARE_VERSION

VELLUM_NS = "http://commcarehq.org/xforms/vellum"
XFORMS_NS = "http://www.w3.org/2002/xforms"


@dataclass(frozen=True)
class AppContent:
    """One app Nova sends, as HQ's import reads it."""

    app: object  # corehq.apps.app_manager.models.Application
    source: dict  # the JSON as sent, before HQ wraps it
    lookup_push: bool


@dataclass(frozen=True)
class PrivilegeRule:
    """One privilege row: the HQ reader that makes content need it, and the content test.

    ``needs`` returns the privilege constants the content needs: the row's
    one privilege, or for the intents row the one of its two that covers the
    content.
    """

    row: str  # the gate entry id in lib/commcare/surface/entries/gates.json
    reader: str  # file::symbol of the HQ reader
    needs: Callable[[AppContent], frozenset[str]]


# The content tests -------------------------------------------------------


def _forms(content):
    return list(content.app.get_forms())


def _modules(content):
    return list(content.app.get_modules())


def _parsed_sources(content):
    """Each form's source, parsed; a form without a source has none."""
    from lxml import etree

    parsed = []
    for form in _forms(content):
        source = form.source
        if source:
            parsed.append(etree.fromstring(source.encode("utf-8")))
    return parsed


def _vellum_attribute_values(content, name):
    attribute = f"{{{VELLUM_NS}}}{name}"
    return [
        element.get(attribute)
        for root in _parsed_sources(content)
        for element in root.iter()
        if attribute in element.attrib
    ]


def _needs_usercase(content):
    """``helpers/validators.py::ApplicationValidator._check_subscription`` fails the build
    when ``any(m.uses_usercase() for m in app.get_modules())`` and the space lacks the
    privilege; ``suite_xml/sections/menus.py::MenuContributor._get_commands`` raises
    ``UsercaseXPathValidationError`` for a form display condition that reads the user
    case (``util.py::xpath_references_usercase``) there."""
    from corehq.apps.app_manager.util import xpath_references_usercase

    if any(module.uses_usercase() for module in _modules(content)):
        return True
    return any(
        xpath_references_usercase(condition)
        for form in _forms(content)
        for condition in [getattr(form, "form_filter", None)]
        if condition
    )


def _needs_lookup_tables(content):
    """``helpers/validators.py::ApplicationValidator._validate_fixtures`` fails the build for
    a form whose source reads a lookup table (``FormBase.has_fixtures``), and HQ's lookup
    upload (``fixtures/views.py::upload_fixture_api``, through
    ``fixtures/dispatcher.py::require_can_edit_fixtures``) refuses Nova's workbook push."""
    return content.lookup_push or any(form.has_fixtures for form in _forms(content))


def _needs_intents(content):
    """``helpers/validators.py::ApplicationValidator._validate_intents``: an app whose forms
    declare ODK intents needs ``custom_intents``, or ``templated_intents`` when every
    intent is one of HQ's callout templates (``util.py::app_callout_templates_ids``)."""
    from corehq import privileges
    from corehq.apps.app_manager.util import app_callout_templates_ids

    intents = {intent for form in _forms(content) for intent in form.wrapped_xform().odk_intents}
    if not intents:
        return frozenset()
    if intents <= app_callout_templates_ids():
        return frozenset({_constant(privileges.TEMPLATED_INTENTS)})
    return frozenset({_constant(privileges.CUSTOM_INTENTS)})


def _needs_child_cases(content):
    """The Case Management page offers a form's child cases only under the privilege
    (``templates/app_manager/partials/forms/case_config.html`` and
    ``static/app_manager/js/forms/case_config_ui.js`` read ``add_ons_privileges.subcases``,
    which ``add_ons.py::get_privileges_dict`` answers from ``_ADD_ONS["subcases"]``, whose
    privilege is ``child_cases``); a form uses them when that add-on's ``used_in_form`` says so."""
    from corehq.apps.app_manager.add_ons import _ADD_ONS

    uses = _ADD_ONS["subcases"].used_in_form
    return any(uses(form) for form in _forms(content))


def _needs_case_sharing(content):
    """``views/apps.py::edit_app_attr`` keeps ``case_sharing`` on an app only when the
    space has the privilege or the app already shares cases."""
    return bool(content.app.case_sharing)


def _needs_locations(content):
    """``locations/fixtures.py::should_sync_flat_fixture`` and
    ``should_sync_hierarchical_fixture`` put the locations fixture in a restore only when
    ``domain/models.py::Domain.uses_locations``, which needs the privilege; an app reads
    that fixture when a form declares the ``jr://fixture/locations`` instance or the app
    asks for the fixture (``const.py::SYNC_FLAT_FIXTURES``, ``SYNC_HIERARCHICAL_FIXTURE``)."""
    from corehq.apps.app_manager.const import SYNC_FLAT_FIXTURES, SYNC_HIERARCHICAL_FIXTURE

    if content.app.location_fixture_restore in (*SYNC_FLAT_FIXTURES, *SYNC_HIERARCHICAL_FIXTURE):
        return True
    return any(
        element.get("src") == "jr://fixture/locations"
        for root in _parsed_sources(content)
        for element in root.iter(f"{{{XFORMS_NS}}}instance")
    )


def _needs_cloudcare(content):
    """``models/applications.py::_create_app_from_doc`` sets ``cloudcare_enabled`` from the
    privilege on create, whatever the app asks, so an app that declares Web Apps needs it."""
    return bool(content.source.get("cloudcare_enabled"))


def _needs_logo_uploader(content):
    """``models/applications.py::ApplicationBase.create_profile`` writes the app's logos
    (``logo_refs`` named in ``const.py::ANDROID_LOGO_PROPERTY_MAPPING``) into the profile
    only under the privilege."""
    from corehq.apps.app_manager.const import ANDROID_LOGO_PROPERTY_MAPPING

    return any(name in ANDROID_LOGO_PROPERTY_MAPPING for name in content.app.logo_refs)


def _needs_app_dependencies(content):
    """``models/applications.py::ApplicationBase.create_profile`` drops
    ``features.dependencies`` from the profile without the privilege, and
    ``app_strings.py::_create_dependencies_app_strings`` writes their names only with it."""
    return bool(content.app.profile.get("features", {}).get("dependencies"))


def _needs_form_link_workflow(content):
    """``views/forms.py::_edit_form_attr`` saves a form's links only under the privilege,
    and ``views/forms.py::get_form_view_context`` offers the "link to other form" workflow
    only with it or where the form already uses it."""
    from corehq.apps.app_manager.const import WORKFLOW_FORM

    return any(
        getattr(form, "post_form_workflow", None) == WORKFLOW_FORM or getattr(form, "form_links", None)
        for form in _forms(content)
    )


def _needs_custom_icon_badges(content):
    """``views/utils.py::handle_custom_icon_edits`` saves a menu's or form's badge only under
    the privilege, and ``views/forms.py::get_form_view_context`` and
    ``views/view_generic.py::_get_multimedia_context`` show badges only with it."""
    return any(getattr(entity, "custom_icons", None) for entity in [*_modules(content), *_forms(content)])


def _needs_save_to_case(content):
    """``tasks.py::_refresh_data_dictionary_from_app`` learns a form's Save to Case
    properties (``FormBase.get_save_to_case_updates``) only under the privilege, and
    ``views/formdesigner.py::_get_vellum_plugins`` loads Vellum's ``saveToCase`` plugin,
    which reads the ``vellum:role="SaveToCase"`` blocks, only with it."""
    if any(form.get_save_to_case_updates() for form in _forms(content) if hasattr(form, "get_save_to_case_updates")):
        return True
    return "SaveToCase" in _vellum_attribute_values(content, "role")


def _needs_locked_questions(content):
    """``views/formdesigner.py::_get_vellum_plugins`` loads Vellum's ``lock`` plugin only
    under the privilege; the plugin (Vellum ``src/lock.js``) reads ``vellum:lock="all"`` on
    a question's bind or data node."""
    return "all" in _vellum_attribute_values(content, "lock")


def _needs_geocoder(content):
    """``views/modules.py::_get_shared_module_view_context`` offers a search prompt's
    address (geocoder) appearance, and ``cloudcare/views.py::has_geocoder_privs`` lets Web
    Apps run the geocoder, only under the privilege; the app uses it where a search
    property's appearance is ``address`` (``suite_xml/post_process/remote_requests.py``)
    or a form control's appearance holds the ``address`` token."""
    for module in _modules(content):
        search = getattr(module, "search_config", None)
        if search is not None and any(prop.appearance == "address" for prop in search.properties):
            return True
    return any(
        "address" in (element.get("appearance") or "").split()
        for root in _parsed_sources(content)
        for element in root.iter()
        if isinstance(element.tag, str) and element.tag.startswith(f"{{{XFORMS_NS}}}")
    )


def _one(symbol_attr, test):
    def needs(content):
        from corehq import privileges

        return frozenset({_constant(getattr(privileges, symbol_attr))}) if test(content) else frozenset()

    return needs


PRIVILEGE_RULES: tuple[PrivilegeRule, ...] = (
    PrivilegeRule(
        "privilege/user_case",
        "corehq/apps/app_manager/helpers/validators.py::ApplicationValidator._check_subscription",
        _one("USERCASE", _needs_usercase),
    ),
    PrivilegeRule(
        "privilege/lookup_tables",
        "corehq/apps/app_manager/helpers/validators.py::ApplicationValidator._validate_fixtures",
        _one("LOOKUP_TABLES", _needs_lookup_tables),
    ),
    PrivilegeRule(
        "privilege/templated_intents+custom_intents",
        "corehq/apps/app_manager/helpers/validators.py::ApplicationValidator._validate_intents",
        _needs_intents,
    ),
    PrivilegeRule(
        "privilege/child_cases",
        "corehq/apps/app_manager/add_ons.py::get_privileges_dict",
        _one("CHILD_CASES", _needs_child_cases),
    ),
    PrivilegeRule(
        "privilege/case_sharing_groups",
        "corehq/apps/app_manager/views/apps.py::edit_app_attr",
        _one("CASE_SHARING_GROUPS", _needs_case_sharing),
    ),
    PrivilegeRule(
        "privilege/locations",
        "corehq/apps/locations/fixtures.py::should_sync_flat_fixture",
        _one("LOCATIONS", _needs_locations),
    ),
    PrivilegeRule(
        "privilege/cloudcare",
        "corehq/apps/app_manager/models/applications.py::_create_app_from_doc",
        _one("CLOUDCARE", _needs_cloudcare),
    ),
    PrivilegeRule(
        "privilege/commcare_logo_uploader",
        "corehq/apps/app_manager/models/applications.py::ApplicationBase.create_profile",
        _one("COMMCARE_LOGO_UPLOADER", _needs_logo_uploader),
    ),
    PrivilegeRule(
        "privilege/app_dependencies",
        "corehq/apps/app_manager/models/applications.py::ApplicationBase.create_profile",
        _one("APP_DEPENDENCIES", _needs_app_dependencies),
    ),
    PrivilegeRule(
        "privilege/form_link_workflow",
        "corehq/apps/app_manager/views/forms.py::_edit_form_attr",
        _one("FORM_LINK_WORKFLOW", _needs_form_link_workflow),
    ),
    PrivilegeRule(
        "privilege/custom_icon_badges",
        "corehq/apps/app_manager/views/utils.py::handle_custom_icon_edits",
        _one("CUSTOM_ICON_BADGES", _needs_custom_icon_badges),
    ),
    PrivilegeRule(
        "privilege/save_to_case",
        "corehq/apps/app_manager/tasks.py::_refresh_data_dictionary_from_app",
        _one("VELLUM_SAVE_TO_CASE", _needs_save_to_case),
    ),
    PrivilegeRule(
        "privilege/locked_admin_questions",
        "corehq/apps/app_manager/views/formdesigner.py::_get_vellum_plugins",
        _one("LOCKED_ADMIN_QUESTIONS", _needs_locked_questions),
    ),
    PrivilegeRule(
        "privilege/geocoder",
        "corehq/apps/app_manager/views/modules.py::_get_shared_module_view_context",
        _one("GEOCODER", _needs_geocoder),
    ),
)


def _constant(slug):
    """The ``corehq/privileges.py`` constant whose value is ``slug``."""
    from corehq import privileges

    names = [name for name, value in vars(privileges).items() if name.isupper() and value == slug]
    if len(names) != 1:
        raise ValueError(
            f"corehq/privileges.py names the privilege {slug!r} {len(names)} times, so the "
            "configuration cannot name it by one constant."
        )
    return names[0]


def wrap(source):
    """The app as HQ's import wraps it (``dbaccessors.py::wrap_app``), from a copy of ``source``.

    HQ's wrap fills a null build spec from the server's default build
    (``ApplicationBase.wrap`` calls ``builds/utils.py::get_default_build_spec``,
    a Couch read); no rule reads the version, so the corpus's own version
    stands in for it.
    """
    from copy import deepcopy
    from unittest import mock

    from corehq.apps.app_manager.dbaccessors import wrap_app
    from corehq.apps.builds.models import BuildSpec

    default = BuildSpec(version=CORPUS_COMMCARE_VERSION, build_number=None, latest=True)
    with mock.patch("corehq.apps.app_manager.models.applications.get_default_build_spec", return_value=default):
        return wrap_app(deepcopy(source))


def required_privileges(sources: Iterable[dict], *, lookup_push: bool = False) -> list[str]:
    """The privilege constants the content of these apps (one document's publishes) needs, sorted."""
    needed: set[str] = set()
    for source in sources:
        content = AppContent(app=wrap(source), source=source, lookup_push=lookup_push)
        for rule in PRIVILEGE_RULES:
            needed |= rule.needs(content)
    return sorted(needed)


# The captured publishes the privilege derivation reads: the minimum
# configuration's create of D, and its update to D′ when the document has an edit.
PRIVILEGE_CAPTURES = (("export/minimum", "create"), ("edit/export/minimum", "update"))


class PrivilegeInputError(ValueError):
    """A corpus document lacks a captured publish the privilege derivation reads."""


def _captured_app(directory: Path, name: str):
    """The app JSON one captured import carries, and whether a lookup workbook was pushed before it."""
    from proof.hq.operations import Upload, upload_field

    sidecar = json.loads((directory / f"{name}.json").read_text(encoding="utf-8"))
    body = (directory / f"{name}.body").read_bytes()
    source = json.loads(upload_field(Upload(body, sidecar["contentType"]), "app_file"))
    return source, sidecar.get("lookups") is not None


@functools.cache
def _content_privileges(root: Path) -> tuple[str, ...]:
    """The privileges a document's content needs, from the apps its minimum configuration's publishes send."""
    from proof.hq.boot import boot

    boot()
    sources, lookup_push = [], False
    for relative, name in PRIVILEGE_CAPTURES:
        directory = root / relative
        if not (directory / f"{name}.json").exists():
            if name == "create":
                raise PrivilegeInputError(
                    f"{root} holds no {relative}/{name}.json, the publish of D under its minimum configuration"
                    " whose app the privileges are derived from; emit the corpus again."
                )
            continue
        source, pushed = _captured_app(directory, name)
        sources.append(source)
        lookup_push = lookup_push or pushed
    return tuple(required_privileges(sources, lookup_push=lookup_push))


def privileges_for(document_root, configuration_name) -> list[str]:
    """The privilege constants the configuration ``configuration_name`` of the document at ``document_root`` grants.

    They are the privileges the document's content needs (derived once per
    document and process, with HQ booted) and those its ``configurations.json``
    names for that configuration (``namedPrivileges``), sorted.
    """
    root = Path(document_root).resolve()
    data = json.loads((root / "configurations.json").read_text(encoding="utf-8"))
    entries = {"minimum": data["minimum"], "maximum": data["maximum"], **data["singleFlag"]}
    if configuration_name not in entries:
        raise PrivilegeInputError(
            f"{root / 'configurations.json'} defines no configuration {configuration_name!r}"
            f" (it defines {sorted(entries)}), so it grants no privileges to derive."
        )
    named = entries[configuration_name]["namedPrivileges"]
    return sorted(set(_content_privileges(root)) | set(named))


def read_configurations(path):
    """A document's ``configurations.json`` as ``{name: Configuration}``, with the privileges each grants.

    Names are ``minimum``, ``maximum`` and each single-flag configuration's
    flag symbol: the directories under ``export/`` that hold each one's
    publish captures. The privileges are ``privileges_for``'s, so this
    boots HQ.
    """
    from proof.hq.configuration import Configuration

    path = Path(path)
    data = json.loads(path.read_text())

    def configuration(name, entry):
        return Configuration(
            flags=frozenset(entry["flags"]),
            privileges=frozenset(privileges_for(path.parent, name)),
            commcare_version=entry["commcareVersion"],
            commtrack=entry["commtrack"],
            sync_cases_on_form_entry=entry["syncCasesOnFormEntry"],
            case_search_enabled=entry["caseSearchEnabled"],
        )

    return {
        "minimum": configuration("minimum", data["minimum"]),
        "maximum": configuration("maximum", data["maximum"]),
        **{flag: configuration(flag, entry) for flag, entry in sorted(data["singleFlag"].items())},
    }


def corpus_privileges(corpus_root) -> dict[str, dict[str, list[str]]]:
    """Every document's privileges per configuration, for the corpus at ``corpus_root``."""
    root = Path(corpus_root)
    index = json.loads((root / "index.json").read_text(encoding="utf-8"))
    return {
        entry["id"]: {name: privileges_for(root / entry["id"], name) for name in entry["configurations"]}
        for entry in index["documents"]
    }


def main(argv):
    if len(argv) not in (1, 2):
        raise SystemExit(
            "Name the corpus and, if you like, the file to write its privileges to: "
            "python -m proof.checks.configurations <corpus> [<output.json>]."
        )
    text = json.dumps(corpus_privileges(argv[0]), indent="\t", sort_keys=True) + "\n"
    if len(argv) == 2:
        Path(argv[1]).write_text(text)
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main(sys.argv[1:])
