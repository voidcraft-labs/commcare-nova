"""HQ's Register action and its return frames equal Nova's, and HQ refuses a form with two registrations.

Contract: for each document of registration from the case list, and for each again with every list's other
``afterSubmit`` wherever Nova's gate admits it, the ``<detail>/<action>`` of every short
detail and every ``<entry>/<stack>`` HQ's suite contributors build equal the ones Nova's local suite writes,
compared whole as ``test_no_matches_emission.py`` compares them (the health shape's action carries its media
locales). ``RegisterFromListRuntimeTest`` then runs the action and the frames on both suites in Core. The
negative control, built past Nova's gate, is a registration form that also creates a child of its own type at
its root, offered from a list: HQ's own module validator must refuse it as ``case list form not registration``
(``helpers/validators.py::ModuleValidator.validate_case_list_form``, ``Form.is_registration_form`` counting
``open_case`` and every root subcase of the type through ``Form.get_registration_actions``), which is the
refusal Nova's reason ``several-registrations`` stands for. The plausible failures: an action, a guard or a
frame Nova writes differently from HQ's build (``details.py::get_case_list_form_action``,
``workflow.py::CaseListFormWorkflow``), and a refusal Nova keeps that HQ's build does not make.
"""

from lxml import etree

from proof.native.hq_support import hq_commit, parse_xml_xpaths, sha256, shape, write_evidence

FAMILIES = ("menu-screens",)

DOCUMENTS = (
    "register-from-case-list",
    "register-from-case-list-web-apps",
    "register-from-case-list-other-returns",
    "register-from-case-list-web-apps-other-returns",
)
SELECTORS = ("detail/action", "entry/stack")


def test_hq_register_action_and_return_frames_equal_novas(native):
    records = {record["scenario"]: record for record in native.step("menu-screens")}
    suites = [
        (name, etree.fromstring(records[name]["local"]), etree.fromstring(records[name]["native"]))
        for name in DOCUMENTS
    ]
    parsed = parse_xml_xpaths(
        *(
            element
            for _, local, hq in suites
            for root in (local, hq)
            for selector in SELECTORS
            for element in root.findall(selector)
        )
    )
    for name, local, native_suite in suites:
        actions = local.findall("detail/action")
        # Every host's case list carries its Register action.
        assert actions, name
        for selector in SELECTORS:
            assert [shape(e, parsed) for e in local.findall(selector)] == [
                shape(e, parsed) for e in native_suite.findall(selector)
            ], (name, selector)
        assert records[name]["caseListFormErrors"] == [], name
    write_evidence(
        native.family("menu-screens"),
        "register-from-list-emission",
        {
            "results": [
                {
                    "scenario": name,
                    "sourceSha256": records[name]["sourceSha256"],
                    "nativeSha256": sha256(records[name]["native"]),
                }
                for name in DOCUMENTS
            ],
            "hqCommit": hq_commit(),
            "limits": "Actual imported HQ model and suite contributors. Complete action and post-entry stack trees "
            "retain all text/attributes/children, comparing known XPath carriers through HQ's parser. No whole "
            "HQ build, resource installation or search HTTP.",
        },
    )


def test_hq_refuses_a_listed_form_that_registers_two_cases_of_the_type(native):
    records = {record["scenario"]: record for record in native.step("menu-screens")}
    assert records["two-registrations-control"]["caseListFormErrors"] == ["case list form not registration"]
    # Its counterpart, a form registering one case of the type, is refused nowhere.
    assert records["register-from-case-list"]["caseListFormErrors"] == []
