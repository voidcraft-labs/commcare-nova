"""Text CommCare HQ's build reads as an instance, and the spellings that keep it text.

HQ's build renders each form whole and reads every ``instance(``, quoted
name, ``)`` in the rendered string as an instance read, labels, titles,
attributes and data nodes alike (``models/forms.py::FormBase.add_stuff_to_xform``
-> ``xform.py::XForm.add_missing_instances`` ->
``suite_xml/post_process/instances.py::get_instance_names``). For a name the
form does not declare, it adds the instance where it knows a source for the
name and refuses the build otherwise.

Contract, over HQ's own functions and HQ's own ``Application.create_all_files``
on hand-written control forms (the first form of HQ's suite test app):

- the pattern: for each row of ``fixtures/hq-instance-scan-vectors.json``, the
  text in an element's text and in an attribute, rendered as
  ``WrappedNode.render`` renders, reads as exactly the row's ``hqReads``, and a
  row HQ reads a name in is one Nova refuses (``hqInstanceScan.ts::instanceScanRead``
  answers exactly the refused rows, ``lib/commcare/__tests__/hqInstanceScan.test.ts``);
- a label: written as one text node, ``instance('nova_absent')`` stops the
  build and ``instance('casedb')`` gains a ``casedb`` declaration; written as
  Nova writes it, the bracket a literal ``<output value="'('"/>`` after the
  word (``xform/builder.ts::literalLabelNodes``), both build with no added
  declaration;
- plain text in the form's source, a learn module's description and the
  form's title with its data root's ``name``: ``instance('nova_absent')``
  stops the build naming ``nova_absent``, ``instance('item-list:nova_absent')``
  builds a form that declares ``item-list:nova_absent`` from
  ``jr://fixture/item-list:nova_absent``, which the source did not, and the
  spelling Nova offers, ``instance ('nova_absent')``, builds a form that
  declares nothing the source did not and holds the text as typed.

The two refused texts are the retained controls of ``FORM_TEXT_READ_AS_INSTANCE``:
Nova's gate refuses each, so no corpus document holds one, and a pin that
changed HQ's pattern or what its build does with a match shows here.
Plausible failures: HQ's pattern reading more than Nova refuses; the reading
of ``add_missing_instances`` being wrong; the offered spelling, or a label as
Nova writes it, still read as an instance.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from lxml import etree

from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import hq_test_app, nova_shaped_upload
from proof.hq.seams import build_seams

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})
VECTORS = json.loads((Path(__file__).parent / "fixtures" / "hq-instance-scan-vectors.json").read_text())["rows"]

XFORMS = "http://www.w3.org/2002/xforms"
XHTML = "http://www.w3.org/1999/xhtml"
CONNECT = "http://commcareconnect.com/data/v1/learn"
BUILT_FORM = "modules-0/forms-0.xml"
LABEL_ID = "plain-label"

ABSENT = "instance('nova_absent')"
FIXTURE = "instance('item-list:nova_absent')"
OFFERED = "instance ('nova_absent')"
CASEDB = "instance('casedb')"


# The pattern -----------------------------------------------------------------


def _vector_id(text):
    """A vector's text as a test id: each character pytest would escape, and the backslash itself, by its code point.

    pytest escapes an id again on every collection of one process, so an id holding a backslash differs between the
    lane server's collection and a forked worker's, and the lane refuses a collection that depends on the process.
    """
    return "".join(
        character if " " <= character <= "~" and character != "\\" else f"U+{ord(character):04X}" for character in text
    )


@pytest.mark.parametrize("row", VECTORS, ids=[_vector_id(row["text"]) for row in VECTORS])
def test_hqs_pattern_reads_each_vector_as_the_fixture_says(hq, row):
    from corehq.apps.app_manager.suite_xml.post_process.instances import get_instance_names
    from corehq.apps.app_manager.xform import WrappedNode

    in_text = etree.Element("data")
    etree.SubElement(in_text, "description").text = row["text"]
    in_attribute = etree.Element("data", name=row["text"])
    for placed, root in (("text", in_text), ("attribute", in_attribute)):
        rendered = WrappedNode(root).render().decode("utf-8")
        assert get_instance_names(rendered) == set(row["hqReads"]), (placed, rendered)
    if row["hqReads"]:
        assert row["refused"], f"HQ reads {row['hqReads']} in {row['text']!r}, which Nova admits"


# The controls ----------------------------------------------------------------


def _first_form(app_json):
    form = app_json["modules"][0]["forms"][0]
    name = f"{form['unique_id']}.xml"
    return name, etree.fromstring(app_json["_attachments"][name].encode())


def _edited(change):
    """HQ's suite test app with its first form's source changed by ``change(tree)``.

    The form's case actions are turned off, so HQ's build writes no case block
    into it and every secondary instance its built form declares is one the
    instance scan added.
    """
    app_json = hq_test_app()
    actions = app_json["modules"][0]["forms"][0]["actions"]
    for action in ("open_case", "update_case"):
        actions[action]["condition"]["type"] = "never"
    name, tree = _first_form(app_json)
    change(tree)
    app_json["_attachments"][name] = etree.tostring(tree, encoding="unicode")
    return app_json


def _label_value(tree):
    (text,) = [el for el in tree.iter(f"{{{XFORMS}}}text") if el.get("id") == LABEL_ID]
    (value,) = list(text.iter(f"{{{XFORMS}}}value"))
    return value


def _label_as_one_text_node(text):
    def change(tree):
        _label_value(tree).text = text

    return change


def _label_as_nova_writes_it(text):
    """The label as ``literalLabelNodes`` writes it: the word, the bracket as a literal output, the rest."""
    word, rest = text.split("(", 1)
    assert word.endswith("instance"), text

    def change(tree):
        value = _label_value(tree)
        value.text = word
        output = etree.SubElement(value, f"{{{XFORMS}}}output", value="'('")
        output.tail = rest

    return change


def _data_root(tree):
    instance = next(tree.iter(f"{{{XFORMS}}}instance"))
    return instance[0]


def _learn_description(text):
    def change(tree):
        data = _data_root(tree)
        namespace = etree.QName(data).namespace
        block = etree.SubElement(data, f"{{{namespace}}}nova_learn")
        module = etree.SubElement(block, f"{{{CONNECT}}}module", id="nova_learn")
        etree.SubElement(module, f"{{{CONNECT}}}name").text = "Learn"
        etree.SubElement(module, f"{{{CONNECT}}}description").text = text
        etree.SubElement(module, f"{{{CONNECT}}}time_estimate").text = "1"

    return change


def _title_and_name(text):
    def change(tree):
        next(tree.iter(f"{{{XHTML}}}title")).text = text
        _data_root(tree).set("name", text)

    return change


def _built(state, record, app_json):
    """HQ's build of the app, or the exception its form rendering raised."""
    from corehq.apps.app_manager.exceptions import XFormException

    app_id, _ = operations.publish(state, [nova_shaped_upload(app_json, "Instance text")])
    with build_seams():
        try:
            return operations.build(operations.held_app(state, app_id), record)
        except XFormException as refused:
            return refused


def _declared(built):
    """The built first form's secondary instances, as ``{id: src}``."""
    tree = etree.fromstring(built.files[BUILT_FORM])
    return {el.get("id"): el.get("src") for el in tree.iter(f"{{{XFORMS}}}instance") if el.get("id") is not None}


def _baseline(built):
    """The declarations of a control holding plain text, which builds clean."""
    assert not isinstance(built, Exception), built
    assert built.errors == [], (
        f"HQ's suite test app, its first form's case actions off, does not build clean: {built.errors}"
    )
    return _declared(built)


def _refused_naming(outcome, name):
    from corehq.apps.app_manager.exceptions import XFormException

    assert isinstance(outcome, XFormException), outcome
    message = str(outcome)
    assert "missing some instance declarations" in message and name in message, message


def test_a_label_reads_as_an_instance_as_one_text_node_and_as_text_as_nova_writes_it(hq, core_runner):
    with hq_check(CONFIGURATION) as (state, record):
        baseline = _baseline(_built(state, record, _edited(_label_as_one_text_node("Plain"))))
        absent_joined = _built(state, record, _edited(_label_as_one_text_node(ABSENT)))
        casedb_joined = _built(state, record, _edited(_label_as_one_text_node(CASEDB)))
        absent_cut = _built(state, record, _edited(_label_as_nova_writes_it(ABSENT)))
        casedb_cut = _built(state, record, _edited(_label_as_nova_writes_it(CASEDB)))

    _refused_naming(absent_joined, "nova_absent")
    assert "casedb" not in baseline, baseline
    assert _declared(casedb_joined) == {**baseline, "casedb": "jr://instance/casedb"}
    for built in (absent_cut, casedb_cut):
        assert not isinstance(built, Exception), built
        assert built.errors == []
        assert _declared(built) == baseline


@pytest.mark.parametrize(
    "site", [_learn_description, _title_and_name], ids=["learn module description", "title and data name"]
)
def test_plain_text_in_a_forms_source_reads_as_an_instance_and_a_space_before_the_bracket_keeps_it_text(
    hq, core_runner, site
):
    with hq_check(CONFIGURATION) as (state, record):
        baseline = _baseline(_built(state, record, _edited(site("Plain"))))
        absent = _built(state, record, _edited(site(ABSENT)))
        fixture = _built(state, record, _edited(site(FIXTURE)))
        offered = _built(state, record, _edited(site(OFFERED)))

    _refused_naming(absent, "nova_absent")

    assert not isinstance(fixture, Exception), fixture
    assert "item-list:nova_absent" not in baseline, baseline
    assert _declared(fixture) == {**baseline, "item-list:nova_absent": "jr://fixture/item-list:nova_absent"}

    assert not isinstance(offered, Exception), offered
    assert offered.errors == []
    assert _declared(offered) == baseline
    tree = etree.fromstring(offered.files[BUILT_FORM])
    if site is _learn_description:
        (description,) = list(tree.iter(f"{{{CONNECT}}}description"))
        assert description.text == OFFERED
    else:
        assert next(tree.iter(f"{{{XHTML}}}title")).text == OFFERED
        assert _data_root(tree).get("name") == OFFERED


def test_missing_instances_follow_hqs_rendered_form_for_each_build_profile(hq):
    from types import SimpleNamespace

    from corehq.apps.app_manager.models.forms import FormBase
    from corehq.apps.app_manager.xform import XForm

    def text(tag):
        return f"instance('item-list:{tag}')"

    xml = f"""<!-- {text("outside")} --><h:html xmlns:h="{XHTML}" xmlns="{XFORMS}"
        xmlns:v="http://commcarehq.org/xforms/vellum"><h:head><model>
        <instance><data xmlns="urn:nova:test" version="{text("version")}"><age/></data></instance>
        <instance id="item-list:stable" src="jr://fixture/item-list:explicit"/>
        <bind nodeset="/data/other" relevant="count({text("executable")}/executable_list/executable) > 0
            and count({text("stable")}/explicit_list/explicit) > 0"/>
        <!-- {text("inside")} --><bind nodeset="/data/age" v:calculate="{text("vellum")}"
            calculate="count(instance((('item-list:missing')))/missing_list/missing)"/>
        <itext><translation lang="en" default="{text("old-default")}">
            <text id="a"><value>First</value></text>
            <text id="z" custom="{text("normalized")}"><value>First</value></text>
            <text id="common"><value>{text("shared")} {text("nested").replace("'", "&amp;apos;")}</value></text>
        </translation><translation lang="fr"><text id="fr">
            <value>instan<!-- removed -->ce('item-list:french')</value></text></translation>
        </itext></model></h:head><h:body/></h:html>"""
    profiles = {None: ["en", "fr"], "english": ["en"]}
    app = SimpleNamespace(get_build_langs=lambda profile_id: profiles[profile_id])
    form = SimpleNamespace(get_app=lambda: app, get_version=lambda: 7)
    for profile, expected in ((None, {"shared", "executable", "french"}), ("english", {"shared", "executable"})):
        xform = XForm(xml.encode())
        FormBase.add_stuff_to_xform(form, xform, profile)
        # add_instance creates an unqualified etree node under the default namespace.
        # The worker receives that namespace when parsing the rendered resource.
        built_form = etree.fromstring(xform.render())
        declarations = {node.get("id"): node.get("src") for node in built_form.iter(f"{{{XFORMS}}}instance")
                        if node.get("id")}
        assert declarations == {"item-list:stable": "jr://fixture/item-list:explicit",
                                **{f"item-list:{tag}": f"jr://fixture/item-list:{tag}" for tag in expected}}


@pytest.mark.parametrize(("earlier", "later", "survives"), [
    ("<value/>", "<value><![CDATA[]]></value>", True),
    ("<value><![CDATA[]]></value>", "<value><![CDATA[]]></value>", False),
    ("<value><![CDATA[note]]></value>", "<value>note</value>", False),
    ("<value><![CDATA[]]><output/></value>", "<value><output/></value>", False),
    ("<value><?p?></value>", "<value><?p ?></value>", True),
    ("<value>no<!-- lost -->te</value>", "<value>note</value>", False),
    ('<value xmlns:s="urn:first">note</value>', '<value xmlns:s="urn:second">note</value>', True),
    ('<value xmlns:xml="http://www.w3.org/XML/1998/namespace" xml:lang="en">note</value>',
     '<value xml:lang="en">note</value>', False),
])
def test_normalizing_itext_retains_only_the_sources_present_in_the_rendered_values(hq, earlier, later, survives):
    from proof.observe.manifest import built_form_instance_names

    form = f"""<h:html xmlns:h="{XHTML}" xmlns="{XFORMS}"><h:head><model>
        <instance><data xmlns="urn:nova:itext"/></instance><itext><translation lang="en">
        <text id="a-control">{earlier}</text>
        <text id="z-control" note="instance('item-list:zones')">{later}</text>
        </translation></itext></model></h:head><h:body/></h:html>"""
    assert built_form_instance_names(form.encode(), ["en"]) == {"names": ["item-list:zones"] if survives else []}


def test_remote_request_factory_scans_a_siblings_xpath_after_one_html_unescape(hq, core_runner):
    from corehq.apps.app_manager.suite_xml.post_process.instances import get_all_instances_referenced_in_xpaths

    grouped = "instance((('item-list:zones')))/zones_list/zones"
    for spelling, available in (("instance('item-list:zones')", True),
                                ("instan&#99;e(&apos;item-list:zones&apos;)", True),
                                ("instance(&amp;apos;item-list:zones&amp;apos;)", False)):
        rule = f'"{spelling}" = "plain"'
        worker, sibling = core_runner.request("xpathParse", deadline=30, expressions=[grouped, rule])["results"]
        assert [path["instance"] for path in worker["instancePaths"]] == ["item-list:zones"]
        assert sibling["instancePaths"] == []  # its literal supplies no executable data read
        instances, unknown = get_all_instances_referenced_in_xpaths(None, [grouped, rule])
        assert not unknown
        assert {(item.id, item.src) for item in instances} == (
            {("item-list:zones", "jr://fixture/item-list:zones")} if available else set())


def test_concrete_form_build_adds_session_and_only_active_preload_sources(hq, core_runner):
    from corehq.apps.app_manager.models import AdvancedModule, Application, Module
    from corehq.apps.app_manager.models.form_actions import LoadUpdateAction
    from corehq.apps.app_manager.xform import XForm

    xml = f"""<h:html xmlns:h="{XHTML}" xmlns="{XFORMS}"><h:head><h:title>Visit</h:title><model>
        <instance><data xmlns="urn:nova:post-scan"><age/></data></instance>{{shadow}}
        <bind nodeset="/data/age" calculate="count(instance((('casedb')))/casedb/case)"/>
        </model></h:head><h:body><input ref="/data/age"><label>Age</label></input></h:body></h:html>"""
    with hq_check(CONFIGURATION) as (state, _):
        app = Application.new_app(state.domain, "Visits")
        for module_cls, requires, preload, user_preload, shadow, expected in (
            (Module, "case", False, False, False, None),
            (Module, "case", True, False, False, "jr://instance/casedb"),
            (Module, "none", True, False, False, None),
            (Module, "none", False, True, False, "jr://instance/casedb"),
            (Module, "case", True, False, True, "jr://fixture/item-list:clinics"),
            (Module, "none", False, True, True, "jr://fixture/item-list:clinics"),
            (AdvancedModule, None, False, False, False, None),
            (AdvancedModule, None, True, False, False, "jr://instance/casedb"),
            (AdvancedModule, None, True, False, True, "jr://fixture/item-list:clinics"),
        ):
            source = xml.format(shadow=(
                '<instance id="casedb" src="jr://fixture/item-list:clinics"/>'
                '<instance id="commcaresession" src="jr://fixture/item-list:sessions"/>'
            ) if shadow else "")
            menu = app.add_module(module_cls.new_module("Visits", "en"))
            menu.case_type = "patient"
            form = menu.new_form("Visit", "en", attachment=source)
            if module_cls is Module:
                form.requires = requires
                if preload:
                    form.actions.case_preload.preload = {"/data/age": "age"}
                if user_preload:
                    form.actions.usercase_preload.preload = {"/data/age": "age"}
            else:
                form.actions.load_update_cases = [
                    LoadUpdateAction(
                        case_type="patient", case_tag="load", preload={"/data/age": "age"} if preload else {}
                    )
                ]
            tree = XForm(source.encode(), domain=app.domain)
            form.add_stuff_to_xform(tree)
            built = etree.fromstring(tree.render())
            instances = {node.get("id"): node.get("src") for node in built.iter(f"{{{XFORMS}}}instance")}
            expected_session = "jr://fixture/item-list:sessions" if shadow else "jr://instance/session"
            assert instances.get("commcaresession") == expected_session
            assert instances.get("casedb") == expected
            values = {node.get("ref"): node.get("value") for node in built.iter(f"{{{XFORMS}}}setvalue")}
            refs = ["/data/meta/userID"]
            if (preload and requires != "none") or user_preload:
                refs.append("/data/age")
            else:
                assert "/data/age" not in values
            parsed = core_runner.request(
                "xpathParse", deadline=30, expressions=[values[ref] for ref in refs]
            )["results"]
            reads = [{path["instance"] for path in result["instancePaths"]} for result in parsed]
            assert reads[0] == {"commcaresession"}
            if len(reads) == 2:
                assert {"casedb", "commcaresession"} <= reads[1]
                assert instances["casedb"] == expected


@pytest.mark.parametrize(("local_id", "argument", "broken"), [
    ("casedb:archive", "'casedb:archive'", True),
    ("registry:", "'registry:'", True),
    ("casedb:archive", "(('casedb:archive'))", False),
    ("clinic-case", "'clinic-case'", False),
    ("casedb", "'casedb'", False),
])
def test_fixed_instance_factory_runs_before_explicit_form_declarations(hq, local_id, argument, broken):
    from types import SimpleNamespace

    from corehq.apps.app_manager.models.forms import FormBase
    from corehq.apps.app_manager.xform import XForm

    xml = f"""<h:html xmlns:h="{XHTML}" xmlns="{XFORMS}"><h:head><model>
        <instance><data xmlns="urn:nova:source"><age/></data></instance>
        <instance id="{local_id}" src="jr://fixture/item-list:clinics"/>
        <bind nodeset="/data/age" calculate="count(instance({argument})/clinics_list/clinics)"/>
        </model></h:head><h:body/></h:html>"""
    app = SimpleNamespace(get_build_langs=lambda _profile: ["en"])
    form = SimpleNamespace(get_app=lambda: app, get_version=lambda: 1)
    tree = XForm(xml.encode())
    if broken:
        with pytest.raises(KeyError) as exc:
            FormBase.add_stuff_to_xform(form, tree)
        assert exc.value.args == (local_id,)
    else:
        FormBase.add_stuff_to_xform(form, tree)
        built = etree.fromstring(tree.render())
        assert [instance.get("src") for instance in built.iter(f"{{{XFORMS}}}instance")
                if instance.get("id") == local_id] == ["jr://fixture/item-list:clinics"]


def test_factories_follow_the_source_project_and_the_apps_own_search_and_report_ids(hq):
    from corehq.apps.app_manager.models import Application, Module, ReportModule
    from corehq.apps.app_manager.models.report_app_config import ReportAppConfig
    from corehq.apps.app_manager.suite_xml.post_process.instances import get_instance_factory
    from corehq.apps.locations.models import LocationFixtureConfiguration

    for flags in (set(), {"HIERARCHICAL_LOCATION_FIXTURE", "MOBILE_UCR", "USER_CONFIGURABLE_REPORTS"}):
        with hq_check(Configuration(privileges={"CLOUDCARE"}, flags=flags)) as (state, _):
            app = Application.new_app(state.domain, "Visits")
            menu = app.add_module(Module.new_module("Visit", "en"))
            menu.search_config.instance_name = "visits"
            reports = app.add_module(ReportModule.new_module("Reports", "en"))
            reports.report_configs = [ReportAppConfig(report_id="proof", report_slug="visits", uuid="report-uuid")]

            # Source reads re-key even an existing report config. Its slug stays stable.
            exported_report = app.scrub_source({**app.to_json(), "_attachments": {}})["modules"][1]["report_configs"][0]
            assert exported_report["report_slug"] == "visits" and exported_report["uuid"] != "report-uuid"

            def src(name):
                result = get_instance_factory(name)(app, name)
                return result.src if result else None

            for flat in (True, False):
                with state.committing():
                    LocationFixtureConfiguration.objects.update_or_create(
                        domain=app.domain, defaults={"sync_flat_fixture": flat}
                    )
                assert src("locations") == (
                    "jr://fixture/commtrack:locations" if flags and not flat else "jr://fixture/locations"
                )
            assert src("results") == "jr://instance/remote/results"
            assert src("results:inline") == "jr://instance/remote/results:inline"
            assert src("results:visits") == "jr://instance/remote/results:visits"
            assert src("results:other") is None
            assert src("search-input:results:visits") == "jr://instance/search-input/results:visits"
            assert src("search-input:results:other") is None
            assert src("reports") == "jr://fixture/commcare:reports"
            assert src("commcare:reports") == ("jr://fixture/commcare:reports" if flags else None)
            for prefix in ("commcare-reports:", "commcare-reports-filters:"):
                assert src(prefix + "visits") == ("jr://fixture/" + prefix + "report-uuid" if flags else None)


def test_working_location_witness_reads_the_source_project_without_saving_or_building(hq, core_runner):
    """The same source in two project spaces with opposite defaults, through HQ's URL resolver
    and an ordinary API-key reader. Each GET leaves the working app and entire build set intact."""
    from corehq.apps.locations.models import LocationFixtureConfiguration
    from proof.hq import redis as hq_redis
    from proof.hq.seams import api_rate_limits, resource_overrides

    observed = {}
    for domain, flat in (("nova-source-space", False), ("nova-other-space", True)):
        configuration = Configuration(
            domain=domain, privileges={"CLOUDCARE", "API_ACCESS"}, flags={"HIERARCHICAL_LOCATION_FIXTURE", "MANAGE_RELEASES_PER_LOCATION"}
        )
        with hq_check(configuration) as (state, _), hq_redis.shared(None):
            app_json = _edited(_label_as_one_text_node("Guide to instance('locations')"))
            app_json["modules"][0]["forms"][0]["form_filter"] = "count(instance('locations')/locations/location) > 0"
            app_id, _ = operations.publish(state, [nova_shaped_upload(app_json, "Visits")])
            with state.committing():
                LocationFixtureConfiguration.objects.update_or_create(
                    domain=domain, defaults={"sync_flat_fixture": flat}
                )
                credential = operations.seed_api_user(state, "reader@example.com")
            with api_rate_limits(state), resource_overrides():
                application = operations.application_read(state, app_id, credential)
                assert application.status == 200
                envelope = json.loads(application.body)
                assert envelope["id"] == app_id and envelope["built_from_app_id"] is None
                assert operations.source_read(state, app_id, credential).status == 200
                apps_before = {
                    key: json.dumps(doc, sort_keys=True)
                    for key, doc in state.couch.mock_docs.items()
                    if doc.get("doc_type") == "Application"
                }
                for resource in ("modules-0/forms-0.xml", "suite.xml"):
                    path = f"/a/{domain}/apps/download/{app_id}/{resource}"
                    gated = operations.api_request(state, "GET", path + "?latest=true&target=save", credential=credential)
                    assert gated.status == 406
                    answer = operations.api_request(state, "GET", path, credential=credential)
                    assert answer.status == 200, (resource, answer.status, answer.body[:150])
                    root = etree.fromstring(answer.body.encode())
                    seen = {
                        n.get("src")
                        for n in root.iter()
                        if isinstance(n.tag, str)
                        and etree.QName(n).localname == "instance"
                        and n.get("id") == "locations"
                    }
                    observed[(domain, resource)] = seen
                missing = operations.api_request(
                    state,
                    "GET",
                    f"/a/{domain}/apps/download/{app_id}/modules-0/forms-999.xml",
                    credential=credential,
                )
                assert missing.status == 404
                assert apps_before == {
                    key: json.dumps(doc, sort_keys=True)
                    for key, doc in state.couch.mock_docs.items()
                    if doc.get("doc_type") == "Application"
                }
    assert observed == {
        (space, resource): {prefix}
        for space, prefix in (
            ("nova-source-space", "jr://fixture/commtrack:locations"),
            ("nova-other-space", "jr://fixture/locations"),
        )
        for resource in ("modules-0/forms-0.xml", "suite.xml")
    }


def test_working_suite_declares_column_sources_on_each_entry_that_reaches_its_detail(hq):
    """Two physical screens and two form commands. Only the selecting command
    reaches the case details. A different command brings in its own fixture."""
    from proof.hq import redis as hq_redis
    from proof.hq.seams import api_rate_limits, resource_overrides

    configuration = Configuration(domain="nova-detail-source", privileges={"API_ACCESS", "CLOUDCARE"})
    with hq_check(configuration) as (state, _), hq_redis.shared(None):
        app = hq_test_app()
        menu = app["modules"][0]
        create, follow = menu["forms"]
        create["custom_instances"] = [{
            "doc_type": "CustomInstance", "instance_id": "item-list:elsewhere",
            "instance_path": "jr://fixture/item-list:elsewhere",
        }]
        grouped = "count(instance((('item-list:zones')))/zones_list/zones)"
        ordinary = "count(instance('item-list:zones')/zones_list/zones)"
        for screen in ("short", "long"):
            detail = menu["case_details"][screen]
            seed = detail["columns"][0]
            detail["columns"] = [
                {**seed, "field": expression, "useXpathExpression": True, "header": {"en": header}}
                for header, expression in (("Zone", grouped), ("Available zones", ordinary))
            ]
        app_id, _ = operations.publish(state, [nova_shaped_upload(app, "Visits")])
        with state.committing():
            credential = operations.seed_api_user(state, "case-list-reader@example.com")
        with api_rate_limits(state), resource_overrides():
            source = operations.source_read(state, app_id, credential)
            assert source.status == 200
            suite = operations.api_request(
                state, "GET", f"/a/{state.domain}/apps/download/{app_id}/suite.xml", credential=credential
            )
            assert suite.status == 200
        root = etree.fromstring(suite.body.encode())
        for detail_id in ("m0_case_short", "m0_case_long"):
            expressions = root.xpath("./detail[@id=$id]/field/template/text/xpath/variable/xpath/@function",
                                     id=detail_id)
            assert set(expressions) >= {ordinary, grouped}
        entries = {entry.findtext("form"): entry for entry in root.findall("entry")}
        choosing = entries[follow["xmlns"]]
        assert {"m0_case_short", "m0_case_long"} <= set(
            choosing.xpath("./session/*/@detail-select | ./session/*/@detail-confirm")
        )
        assert choosing.xpath("./instance[@id='item-list:zones']/@src") == ["jr://fixture/item-list:zones"]
        assert not choosing.xpath("./instance[@id='item-list:elsewhere']")
        creating = entries[create["xmlns"]]
        assert creating.xpath("./instance[@id='item-list:elsewhere']/@src") == ["jr://fixture/item-list:elsewhere"]
        assert not creating.xpath("./instance[@id='item-list:zones']")


@pytest.mark.parametrize("has_search_sibling", [False, True], ids=["without-sibling", "with-sibling"])
def test_working_suite_lookup_instances_follow_their_physical_navigation_scope(
    hq, core_runner, has_search_sibling
):
    """A menu, two form commands, and a search request use the same lookup ID.
    A scanner-visible spelling can supply its own scope; it cannot fix a different scope."""
    from corehq.apps.app_manager.models import CaseSearch, CaseSearchProperty, DefaultCaseSearchProperty
    from proof.hq import redis as hq_redis
    from proof.hq.seams import api_rate_limits, resource_overrides

    configuration = Configuration(
        domain="nova-navigation-source",
        privileges={"API_ACCESS", "CLOUDCARE"},
        flags={"CASE_SEARCH_ADVANCED"},
        case_search_enabled=True,
    )
    lookup_id = "item-list:zones"
    grouped = f"count(instance((('{lookup_id}')))/zones_list/zones)"
    ordinary = f"count(instance('{lookup_id}')/zones_list/zones)"
    canonical = f"jr://fixture/{lookup_id}"
    alternate = "jr://fixture/item-list:other-zones"

    with hq_check(configuration) as (state, _), hq_redis.shared(None):
        app = hq_test_app()
        menu = app["modules"][0]
        create, follow = menu["forms"]
        menu["module_filter"] = f"{ordinary} > 0"
        for form in (create, follow):
            form["form_filter"] = f"{grouped} > 0"
        create["custom_instances"] = [{
            "doc_type": "CustomInstance", "instance_id": lookup_id, "instance_path": alternate,
        }]
        for screen in ("short", "long"):
            detail = menu["case_details"][screen]
            detail["columns"] = [{
                **detail["columns"][0], "field": grouped, "useXpathExpression": True,
                "header": {"en": "Zone count"},
            }]
        menu["search_config"] = CaseSearch(
            properties=[CaseSearchProperty(name="zone", label={"en": "Zone"}, default_value=grouped)],
            default_properties=(
                [DefaultCaseSearchProperty(property="zone_count", defaultValue=ordinary)]
                if has_search_sibling else []
            ),
        ).to_json()
        app_id, _ = operations.publish(state, [nova_shaped_upload(app, "Visits")])
        with state.committing():
            credential = operations.seed_api_user(state, "navigation-reader@example.com")
        with api_rate_limits(state), resource_overrides():
            suite = operations.api_request(
                state, "GET", f"/a/{state.domain}/apps/download/{app_id}/suite.xml", credential=credential
            )
        assert suite.status == 200

    def source(scope):
        return scope.xpath("./instance[@id=$id]/@src", id=lookup_id)

    root = etree.fromstring(suite.body.encode())
    (built_menu,) = root.xpath("./menu[@id='m0']")
    assert ordinary in built_menu.attrib["relevant"]
    assert source(built_menu) == [canonical]
    assert len(built_menu.xpath("./command[contains(@relevant, $grouped)]", grouped=grouped)) == 2
    entries = {entry.findtext("form"): entry for entry in root.findall("entry")}
    assert source(entries[create["xmlns"]]) == [alternate]
    choosing = entries[follow["xmlns"]]
    assert source(choosing) == []
    assert "m0_case_short" in choosing.xpath("./session/*/@detail-select")
    assert grouped in root.xpath("./detail[@id='m0_case_short']//@function")

    (request,) = root.xpath("./remote-request[session/query/prompt[@key='zone']]")
    assert source(request) == ([canonical] if has_search_sibling else [])
    (prompt_default,) = request.xpath("./session/query/prompt[@key='zone']/@default")
    assert prompt_default == grouped
    parsed = core_runner.request("xpathParse", deadline=30, expressions=[prompt_default])["results"]
    assert [path["instance"] for path in parsed[0]["instancePaths"]] == [lookup_id]
