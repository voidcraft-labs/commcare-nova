"""Each privilege rule of ``proof/checks/configurations.py`` finds the content its HQ reader gates.

Contract: a corpus document's minimum configuration grants a privilege
exactly when the app Nova sends holds content HQ gates on it. The plausible
failures: a rule that reads the wrong field (the content is present and the
privilege is left out, so a check reports the plan as a defect), a rule
that fires on every app (the minimum grants more than the content needs,
hiding a refusal the plan would cause), and, where the reader runs on an
app alone, a rule that names a reader which does not in fact read that
content.

Each case starts from one app HQ's own ``AppFactory`` builds, which needs
no privilege, and adds exactly one piece of content. The rules whose cited
reader runs on an app alone are also run through it, with and without the
privilege, which is what makes the privilege part of the minimum:
``ApplicationValidator`` for the user case, lookup tables and both intent
privileges (a callout template accepted under ``TEMPLATED_INTENTS`` alone,
a custom intent refused under it), and ``ApplicationBase.create_profile``
for the logos and the Android app dependencies. The other rules' readers
are HQ's views and editor plugins, its app import, its data dictionary
refresh and its restore, none of which runs on an app alone; for those the
content tests here pin what each rule reads, and each rule cites its reader.
"""

from __future__ import annotations

import pytest

from proof.checks.configurations import PRIVILEGE_RULES, required_privileges
from proof.hq.configuration import Configuration

DOMAIN = "nova-proof"

XHTML = "http://www.w3.org/1999/xhtml"
XFORMS = "http://www.w3.org/2002/xforms"
ODK = "http://opendatakit.org/xforms"
VELLUM = "http://commcarehq.org/xforms/vellum"


def source(*, instances=(), intents=(), role=None, lock=None, appearance=None, itemset=False):
    """A one-question form source holding the content under test."""
    from lxml import etree

    html = etree.Element(
        f"{{{XHTML}}}html",
        nsmap={"h": XHTML, None: XFORMS, "odk": ODK, "vellum": VELLUM, "jr": "http://openrosa.org/javarosa"},
    )
    head = etree.SubElement(html, f"{{{XHTML}}}head")
    etree.SubElement(head, f"{{{XHTML}}}title").text = "form"
    model = etree.SubElement(head, f"{{{XFORMS}}}model")
    instance = etree.SubElement(model, f"{{{XFORMS}}}instance")
    data = etree.SubElement(instance, "{http://openrosa.org/formdesigner/privilege-rule}data")
    question = etree.SubElement(data, "{http://openrosa.org/formdesigner/privilege-rule}name")
    if role is not None:
        question.set(f"{{{VELLUM}}}role", role)
    for instance_id, src in instances:
        etree.SubElement(model, f"{{{XFORMS}}}instance", id=instance_id, src=src)
    bind = etree.SubElement(model, f"{{{XFORMS}}}bind", nodeset="/data/name", type="xsd:string")
    if lock is not None:
        bind.set(f"{{{VELLUM}}}lock", lock)
    for intent in intents:
        etree.SubElement(head, f"{{{ODK}}}intent", id=f"intent-{len(intent)}", **{"class": intent})
    body = etree.SubElement(html, f"{{{XHTML}}}body")
    control = etree.SubElement(body, f"{{{XFORMS}}}{'select1' if itemset else 'input'}", ref="/data/name")
    if appearance is not None:
        control.set("appearance", appearance)
    etree.SubElement(control, f"{{{XFORMS}}}label").text = "Name"
    if itemset:
        choices = etree.SubElement(control, f"{{{XFORMS}}}itemset", nodeset="instance('casedb')/casedb/case")
        etree.SubElement(choices, f"{{{XFORMS}}}label", ref="case_name")
        etree.SubElement(choices, f"{{{XFORMS}}}value", ref="@case_id")
    return etree.tostring(html, encoding="unicode")


def base_app():
    """One module with one form that reads a case, as HQ's AppFactory builds it."""
    from corehq.apps.app_manager.tests.app_factory import AppFactory

    factory = AppFactory(domain=DOMAIN, build_version="2.54.0")
    module, form = factory.new_basic_module("visits", "patient")
    factory.form_requires_case(form, "patient", update={"name": "/data/name"})
    form.source = source()
    return factory, module, form


def _usercase(factory, module, form):
    from corehq.apps.app_manager.models import ConditionalCaseUpdate

    factory.form_uses_usercase(form, update={"last_visit": ConditionalCaseUpdate(question_path="/data/name")})


def _lookup_source(factory, module, form):
    form.source = source(instances=[("regions", "jr://fixture/item-list:regions")])


def _case_instance(factory, module, form):
    form.source = source(instances=[("casedb", "jr://instance/casedb")])


def _case_itemset(factory, module, form):
    form.source = source(instances=[("casedb", "jr://instance/casedb")], itemset=True)


def _custom_intent(factory, module, form):
    form.source = source(intents=["org.example.nova.CUSTOM"])


def _templated_intent(factory, module, form):
    from corehq.apps.app_manager.util import app_callout_templates_ids

    form.source = source(intents=[sorted(app_callout_templates_ids())[0]])


def _child_case(factory, module, form):
    factory.form_opens_case(form, case_type="visit", is_subcase=True)


def _case_sharing(factory, module, form):
    factory.app.case_sharing = True


def _locations_instance(factory, module, form):
    form.source = source(instances=[("locations", "jr://fixture/locations")])


def _locations_fixture(factory, module, form):
    factory.app.location_fixture_restore = "both_fixtures"


def _logo(factory, module, form):
    from corehq.apps.app_manager.const import ANDROID_LOGO_PROPERTY_MAPPING

    name = sorted(ANDROID_LOGO_PROPERTY_MAPPING)[0]
    factory.app.logo_refs = {name: {"path": "jr://file/commcare/logo/data/hq_logo.png", "m_id": "logo"}}


def _dependencies(factory, module, form):
    factory.app.profile = {"features": {"dependencies": ["org.example.dependency"]}}


def _form_link(factory, module, form):
    from corehq.apps.app_manager.const import WORKFLOW_FORM

    form.post_form_workflow = WORKFLOW_FORM


def _badge(factory, module, form):
    from corehq.apps.app_manager.models import CustomIcon

    module.custom_icons = [CustomIcon(xpath="count(instance('casedb')/casedb/case)")]


def _save_to_case(factory, module, form):
    form.source = source(role="SaveToCase")


def _lock(factory, module, form):
    form.source = source(lock="all")


def _geocoder_prompt(factory, module, form):
    from corehq.apps.app_manager.models import CaseSearch, CaseSearchProperty

    module.search_config = CaseSearch(properties=[CaseSearchProperty(name="address", appearance="address")])


def _geocoder_question(factory, module, form):
    form.source = source(appearance="address")


CASES = [
    ("user_case", _usercase, ["USERCASE"], False),
    ("lookup_tables_form", _lookup_source, ["LOOKUP_TABLES"], False),
    ("lookup_tables_push", None, ["LOOKUP_TABLES"], True),
    ("case_itemset", _case_itemset, ["LOOKUP_TABLES"], False),
    ("case_instance_without_itemset", _case_instance, [], False),
    ("custom_intents", _custom_intent, ["CUSTOM_INTENTS"], False),
    ("templated_intents", _templated_intent, ["TEMPLATED_INTENTS"], False),
    ("child_cases", _child_case, ["CHILD_CASES"], False),
    ("case_sharing_groups", _case_sharing, ["CASE_SHARING_GROUPS"], False),
    ("locations_instance", _locations_instance, ["LOCATIONS"], False),
    ("locations_fixture", _locations_fixture, ["LOCATIONS"], False),
    ("commcare_logo_uploader", _logo, ["COMMCARE_LOGO_UPLOADER"], False),
    ("app_dependencies", _dependencies, ["APP_DEPENDENCIES"], False),
    ("form_link_workflow", _form_link, ["FORM_LINK_WORKFLOW"], False),
    ("custom_icon_badges", _badge, ["CUSTOM_ICON_BADGES"], False),
    ("save_to_case", _save_to_case, ["VELLUM_SAVE_TO_CASE"], False),
    ("locked_admin_questions", _lock, ["LOCKED_ADMIN_QUESTIONS"], False),
    ("geocoder_prompt", _geocoder_prompt, ["GEOCODER"], False),
    ("geocoder_question", _geocoder_question, ["GEOCODER"], False),
]


def export(factory):
    return factory.app.export_json(dump_json=False)


def test_the_base_app_needs_no_privilege(hq):
    factory, _, _ = base_app()
    assert required_privileges([export(factory)]) == []


@pytest.mark.parametrize(("name", "add", "expected", "push"), CASES, ids=[case[0] for case in CASES])
def test_each_rule_grants_its_privilege_for_its_content_alone(hq, name, add, expected, push):
    factory, module, form = base_app()
    if add is not None:
        add(factory, module, form)
    assert required_privileges([export(factory)], lookup_push=push) == expected


def test_the_rules_cover_every_privilege_row_a_configuration_names():
    rows = {rule.row for rule in PRIVILEGE_RULES}
    covered = {
        "privilege/user_case",
        "privilege/lookup_tables",
        "privilege/templated_intents+custom_intents",
        "privilege/child_cases",
        "privilege/case_sharing_groups",
        "privilege/locations",
        "privilege/cloudcare",
        "privilege/commcare_logo_uploader",
        "privilege/app_dependencies",
        "privilege/form_link_workflow",
        "privilege/custom_icon_badges",
        "privilege/save_to_case",
        "privilege/locked_admin_questions",
        "privilege/geocoder",
    }
    assert rows == covered


def test_an_app_that_declares_web_apps_needs_cloudcare(hq):
    """HQ's create sets ``cloudcare_enabled`` from the plan, so only the source's request counts."""
    factory, _, _ = base_app()
    sent = export(factory)
    assert required_privileges([sent]) == []
    sent["cloudcare_enabled"] = True
    assert required_privileges([sent]) == ["CLOUDCARE"]


def _validator_errors(app, method, granted):
    from corehq.apps.app_manager.helpers.validators import ApplicationValidator

    from proof.hq.seams import SeamRecord, privileges

    configuration = Configuration(privileges=frozenset(granted), domain=DOMAIN)
    with privileges(configuration, SeamRecord()):
        return getattr(ApplicationValidator(app), method)()


@pytest.mark.parametrize(
    ("add", "method", "privilege"),
    [
        (_usercase, "_check_subscription", "USERCASE"),
        (_lookup_source, "_validate_fixtures", "LOOKUP_TABLES"),
        (_custom_intent, "_validate_intents", "CUSTOM_INTENTS"),
        (_templated_intent, "_validate_intents", "TEMPLATED_INTENTS"),
    ],
    ids=["user_case", "lookup_tables", "custom_intents", "templated_intents"],
)
def test_the_cited_build_reader_refuses_the_content_without_the_privilege(hq, add, method, privilege):
    factory, module, form = base_app()
    assert _validator_errors(factory.app, method, set()) == []
    add(factory, module, form)
    assert required_privileges([export(factory)]) == [privilege]
    assert _validator_errors(factory.app, method, {privilege}) == []
    assert _validator_errors(factory.app, method, set()) != []


def test_the_templated_privilege_alone_refuses_a_custom_intent(hq):
    """The intents rule names ``CUSTOM_INTENTS`` for an intent HQ has no callout template for."""
    factory, module, form = base_app()
    _custom_intent(factory, module, form)
    assert required_privileges([export(factory)]) == ["CUSTOM_INTENTS"]
    assert _validator_errors(factory.app, "_validate_intents", {"TEMPLATED_INTENTS"}) != []


def _profile(app, granted):
    """The profile HQ's build writes for ``app`` on a plan granting ``granted``, every flag off."""
    from lxml import etree

    from proof.hq.seams import SeamRecord, flags, privileges

    configuration = Configuration(privileges=frozenset(granted), domain=DOMAIN)
    record = SeamRecord()
    with flags(configuration, record), privileges(configuration, record):
        return etree.fromstring(app.create_profile())


def _logo_properties(profile):
    from corehq.apps.app_manager.const import ANDROID_LOGO_PROPERTY_MAPPING

    keys = set(ANDROID_LOGO_PROPERTY_MAPPING.values())
    return {node.get("key"): node.get("value") for node in profile.iter("property") if node.get("key") in keys}


def _profile_dependencies(profile):
    return [node.get("id") for node in profile.findall("features/dependencies/android_package")]


@pytest.mark.parametrize(
    ("add", "privilege", "read", "expected"),
    [
        (
            _logo,
            "COMMCARE_LOGO_UPLOADER",
            _logo_properties,
            {"brand-banner-home-demo": "jr://file/commcare/logo/data/hq_logo.png"},
        ),
        (_dependencies, "APP_DEPENDENCIES", _profile_dependencies, ["org.example.dependency"]),
    ],
    ids=["commcare_logo_uploader", "app_dependencies"],
)
def test_the_profile_carries_the_content_only_with_the_privilege(hq, add, privilege, read, expected):
    """``ApplicationBase.create_profile`` writes the content under the privilege and drops it without."""
    factory, module, form = base_app()
    assert not read(_profile(factory.app, {privilege}))
    add(factory, module, form)
    assert required_privileges([export(factory)]) == [privilege]
    assert read(_profile(factory.app, {privilege})) == expected
    assert not read(_profile(factory.app, set()))
