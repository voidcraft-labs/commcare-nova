"""The value expectations written by hand for each base hold the rules that make them positive controls.

Each base holds ``proof/matrix/hand/<base>/expectations.json`` and the
``restore.xml`` its expectations run over, written by hand from what the
base's builder authors and never from a reading. An expectation is
``proof/targeted/expected.ts::Expectation`` less ``export``, with ``form`` as
HQ's ``{menu, form}``, and ``entry`` and ``exports`` beside it. The rules,
each failing by base with what is missing:

1. the restore parses; a form's expectation gives every datum HQ's build of
   the form reads from its session (``_session_datums``: a case the form
   creates, the worker's own case, the cases a several-case list chose); every
   datum value an expectation's session names is a case of the restore, but a
   case the form creates, which is one the restore lacks, and the worker's own
   case, which is its ``commcare-user`` case; a case list's values are
   expected only of a request that opens the list, a form's only of one that
   opens the form; every case type it writes is in the base's ``seed.json``
   catalog, and every property it writes is one the catalog gives the type
   (what the app's forms write) or one a form of the app loads into a
   question for it (a ``case_preload`` or an advanced load's ``preload``), so
   a hand restore cannot drift from its app; an expectation that opens a case
   list runs on the local archive alone, the only installed one;
2. every form of the base has at least one expectation;
3. every HELD entry the base exhibits whose claim sits in a form
   (``form:<m>.<f>``) has an expectation naming it on that form;
4. every HELD entry the base exhibits whose claim sits in the app's JSON under
   a case list or a case detail has a ``caseList`` expectation naming it, run
   on the local archive alone, and the base is read under a declaration that
   includes Android;
5. every first-publish id of the base whose entry holds a ``proof3`` row in
   ``proof/first-publish-changes.json`` has a ``<id>:before`` expectation run
   on A alone and an ``<id>:after`` one run on B and the archive, whose values
   differ, but for a row that names a media reference a trace read, which no
   value Core's evaluate answers can show (``_shows_a_value``);
6. a multi-select question an expression tests has an expectation answering
   it with two choices;
7. a base whose app holds more than one language is read under a declaration
   that includes Android.

Where a claim sits is read from the base's claim log, which the reader bundle
gives for its committed answers (``proof.matrix.lane_input``). The plausible
failures: a datum naming a case the restore lacks; a registration form's
expectation that gives no id for the case it creates, which Core raises on at
A; a hand restore writing a
property the app does not hold; a held entry with no value fixed by hand, in a
form or on a case list; a declared change with no before and after; a base of
several languages, or one with a case list expectation, read as Web Apps only.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from proof.matrix import lane_input
from proof.matrix.registry import BASES, HAND, HQ_APPS

PROOF = Path(__file__).resolve().parents[1]
ENTRIES = PROOF.parent / "lib" / "commcare" / "surface" / "entries"
FIRST_PUBLISH_CHANGES = PROOF / "first-publish-changes.json"
CASE_XMLNS = "http://commcarehq.org/case/transaction/v2"
XFORMS = "http://www.w3.org/2002/xforms"
EXPORTS = ("A", "B", "local")


def _held_entries():
    found = set()
    for path in sorted(ENTRIES.glob("*.json")):
        if path.name == "gates.json":
            continue
        found.update(
            entry["id"] for entry in json.loads(path.read_text(encoding="utf-8")) if entry["disposition"] == "HELD"
        )
    return found


# The last step of a trace path that names a media reference Core read for a screen (a question's, a choice's or a
# menu entry's picture, sound or video), not a value.
MEDIA_REFERENCES = frozenset({"image", "audio", "video"})


def _shows_a_value(row):
    """Whether a ``proof3`` row names something Core's evaluate can fix by hand: anything but a media reference a
    trace read. Core's evaluate, which runs an expectation, answers expressions, answers and a case list's rows, and
    reads no question's or menu's media (``proof/core/src/nova/proof/core/Evaluate.java``), so a change whose
    behavior is a media reference moving or going (``media-files-renamed``, ``broken-pictures-removed``) is shown
    before and after by proof 3's own comparison of A's trace with B's and the archive's, each side's reference."""
    return row.get("check") == "proof3" and row.get("path", "").rsplit("/", 1)[-1] not in MEDIA_REFERENCES


def _proof3_changes():
    """The changes whose rows hold a ``proof3`` row a value expectation can show (``_shows_a_value``)."""
    if not FIRST_PUBLISH_CHANGES.is_file():
        return set()
    return {
        change["change"]
        for change in json.loads(FIRST_PUBLISH_CHANGES.read_text(encoding="utf-8"))
        if any(_shows_a_value(row) for row in change.get("rows") or [])
    }


def _restore_cases(text):
    """``{case id: (case type, {property})}`` of a restore's cases, parsed with lxml."""
    from lxml import etree

    root = etree.fromstring(text)
    cases = {}
    for case in root.iter(f"{{{CASE_XMLNS}}}case"):
        create = case.find(f"{{{CASE_XMLNS}}}create")
        case_type = create.findtext(f"{{{CASE_XMLNS}}}case_type") if create is not None else None
        update = case.find(f"{{{CASE_XMLNS}}}update")
        written = {etree.QName(child).localname for child in update} if update is not None else set()
        cases[case.get("case_id")] = (case_type, written)
    return cases


def _loaded_properties(app):
    """``{case type: {property}}`` each form of the app loads into a question by name: a basic form's
    ``case_preload`` of its menu's case type, and an advanced form's load (``load_update_cases``) of the load's own.
    HQ's property map counts a case's writes alone (``get_all_case_properties``, which ``seed.json``'s catalog is), so
    a property the app only reads is in no catalog and still one the app holds."""
    loaded = {}
    for module in app.get("modules", []):
        for form in module.get("forms", []):
            actions = form.get("actions") or {}
            preload = (actions.get("case_preload") or {}).get("preload") or {}
            if preload and module.get("case_type"):
                loaded.setdefault(module["case_type"], set()).update(preload.values())
            for load in actions.get("load_update_cases") or []:
                if load.get("case_type"):
                    loaded.setdefault(load["case_type"], set()).update((load.get("preload") or {}).values())
    return loaded


def _forms(app):
    return [(m, f) for m, module in enumerate(app.get("modules", [])) for f, _ in enumerate(module.get("forms", []))]


def _active(action):
    return ((action or {}).get("condition") or {}).get("type") in ("always", "if")


def _session_datums(app, m, f):
    """``{datum id: kind}``: each datum HQ's suite gives the form at ``(m, f)`` that HQ's build of the form reads
    from its session, beyond the case its menu selects. ``new`` is a case the form creates, whose id the suite
    computes with ``uuid()`` (``suite_xml/sections/entries.py::EntriesHelper.get_new_case_id_datums_meta``, named
    by ``models/forms.py::FormBase.session_var_for_action`` and ``form_actions.py::AdvancedOpenCaseAction.
    case_session_var``; one inside a repeat is the form's own ``uuid()``); ``worker`` is the worker's own case, for a
    form that loads or saves it (``get_extra_case_id_datums``, ``util.py::actions_use_usercase``), which
    ``xform.py::SESSION_USERCASE_ID`` reads; ``several`` is the cases a several-case list chose
    (``suite_xml/utils.py::get_select_chain_with_sessions``), whose instance the form declares
    (``xform.py::XForm._create_casexml``). Core raises on a form that reads a datum its session lacks, so a request
    that leaves one out asks a question of a form that cannot open."""
    module = app["modules"][m]
    form = module["forms"][f]
    actions = form.get("actions") or {}
    datums = {}
    if form.get("doc_type") == "Form":
        opens = _active(actions.get("open_case"))
        if opens:
            datums[f"case_id_new_{module['case_type']}_0"] = "new"
        for index, subcase in enumerate(actions.get("subcases") or []):
            if _active(subcase) and not subcase.get("repeat_context"):
                datums[f"case_id_new_{subcase['case_type']}_{index + (1 if opens else 0)}"] = "new"
        if (actions.get("usercase_update") or {}).get("update") or (actions.get("usercase_preload") or {}).get(
            "preload"
        ):
            datums["usercase_id"] = "worker"
    elif form.get("doc_type") in ("AdvancedForm", "ShadowForm"):
        for index, opened in enumerate(actions.get("open_cases") or []):
            if not opened.get("repeat_context"):
                datums[f"case_id_new_{opened['case_type']}_{index}"] = "new"
    if ((module.get("case_details") or {}).get("short") or {}).get("multi_select") and form.get("requires") == "case":
        datums["selected_cases"] = "several"
    return datums


def _languages(app):
    return list(app.get("langs") or [])


def _multi_selects_tested(app):
    """``[(m, f, path)]``: each multi-select question of a form that one of the form's own expressions reads, its
    path read over Core's tokens (``proof/rules/_xpath.py``)."""
    from lxml import etree

    from proof.rules import _xpath

    found = []
    attachments = app.get("_attachments") or {}
    for m, module in enumerate(app.get("modules", [])):
        for f, form in enumerate(module.get("forms", [])):
            source = attachments.get(f"{form.get('unique_id')}.xml")
            if not source:
                continue
            root = etree.fromstring(source.encode("utf-8"))
            refs = [select.get("ref") for select in root.iter(f"{{{XFORMS}}}select") if select.get("ref")]
            texts = [
                value
                for element in (*root.iter(f"{{{XFORMS}}}bind"), *root.iter(f"{{{XFORMS}}}setvalue"))
                for name, value in element.attrib.items()
                if name in ("relevant", "constraint", "calculate", "required", "value") and value
            ]
            for ref in refs:
                tested = False
                for text in texts:
                    tokens = _xpath.tokens(text) or ()
                    joined = "".join(token.text for token in tokens if token.kind in ("SLASH", "QNAME"))
                    if ref in joined:
                        tested = True
                        break
                if tested:
                    found.append((m, f, ref))
    return found


def _claim_records(text):
    """The claim log's records, one JSON object a line (``serializeClaimLog``)."""
    return [json.loads(line) for line in (text or "").splitlines() if line.strip()]


@pytest.fixture(scope="module")
def claim_logs():
    """Each committed base's claim log, read by the reader bundle over its retained answers, by base."""
    from proof.checks import readerbundle

    requests = [
        {"id": base.id, "mode": "claims", "input": lane_input.first_read_input(HQ_APPS / base.id, claims="full")}
        for base in BASES
        if (HQ_APPS / base.id / "base.json").is_file()
    ]
    answers = readerbundle.run_reader(requests) if requests else []
    return {answer["id"]: _claim_records(answer.get("claims")) for answer in answers}


def _problems(base, claim_log, held, proof3):
    directory = HQ_APPS / base.id
    hand = HAND / base.id
    problems = []
    if not (directory / "app.json").is_file():
        return [f"proof/hq-apps/{base.id}/ holds no app.json; author the base and adopt what it wrote first"]
    app = json.loads((directory / "app.json").read_text(encoding="utf-8"))
    expected = json.loads((directory / "expected.json").read_text(encoding="utf-8"))
    seed = json.loads((directory / "seed.json").read_text(encoding="utf-8"))
    runs_only_on = expected["declaration"]["runsOnlyOn"]
    if not (hand / "expectations.json").is_file():
        problems.append(f"proof/matrix/hand/{base.id}/expectations.json is missing")
    if not (hand / "restore.xml").is_file():
        problems.append(f"proof/matrix/hand/{base.id}/restore.xml is missing")
    if problems:
        return problems
    expectations = json.loads((hand / "expectations.json").read_text(encoding="utf-8"))

    # 1. The restore against the expectations and the seed.
    try:
        cases = _restore_cases((hand / "restore.xml").read_bytes())
    except Exception as error:  # noqa: BLE001 (any parse failure is the rule's)
        return [f"restore.xml does not parse ({error})"]
    catalog = {entry["name"]: {prop["name"] for prop in entry["properties"]} for entry in seed["catalog"]}
    for case_type, loaded in _loaded_properties(app).items():
        if case_type in catalog:
            catalog[case_type] |= loaded
    for case_id, (case_type, written) in sorted(cases.items()):
        if case_type is not None and case_type not in catalog and case_type != "commcare-user":
            problems.append(f"restore.xml's case {case_id} is of the type {case_type}, which seed.json's catalog lacks")
        elif case_type in catalog and written - catalog[case_type]:
            problems.append(
                f"restore.xml's case {case_id} writes {sorted(written - catalog[case_type])}, which seed.json gives"
                f" {case_type} no property of"
            )
    for expectation in expectations:
        restore = expectation.get("restore")
        if restore != "restore.xml":
            problems.append(f"{expectation.get('id')} names the restore {restore!r}, and a base's is restore.xml")
        request = expectation.get("request") or {}
        data = (request.get("session") or {}).get("data") or {}
        form = expectation.get("form") or {}
        needed = (
            _session_datums(app, form["menu"], form["form"])
            if "caseList" not in request and (form.get("menu"), form.get("form")) in _forms(app)
            else {}
        )
        for datum, kind in sorted(needed.items()):
            if datum not in data:
                problems.append(
                    f"{expectation.get('id')} gives no {datum}, which HQ's build of form {form['menu']}.{form['form']}"
                    f" reads from its session ({kind})"
                )
        for datum, value in sorted(data.items()):
            kind = needed.get(datum)
            if kind == "several":
                if not isinstance(value, list) or not value or any(one not in cases for one in value):
                    problems.append(
                        f"{expectation.get('id')} names {value} for {datum}, which takes the cases restore.xml holds"
                        " that a several-case list chose, as a list"
                    )
            elif kind == "new":
                if not isinstance(value, str) or value in cases:
                    problems.append(
                        f"{expectation.get('id')} names {value} for {datum}, the case the form creates, which is"
                        " one id restore.xml holds no case of"
                    )
            elif kind == "worker":
                if not isinstance(value, str) or (cases.get(value) or (None,))[0] != "commcare-user":
                    problems.append(
                        f"{expectation.get('id')} names {value} for {datum}, which is the worker's own case"
                        " (commcare-user) restore.xml holds"
                    )
            elif not isinstance(value, str) or value not in cases:
                problems.append(
                    f"{expectation.get('id')} names {value} for {datum}, which restore.xml holds no case of"
                )
        opens_list = "caseList" in request
        for expected in expectation.get("expect") or []:
            if str(expected.get("pointer", "")).startswith("/caseList/") != opens_list:
                problems.append(
                    f"{expectation.get('id')} expects {expected.get('pointer')} of a request that"
                    f" {'opens a case list' if opens_list else 'opens the form'}, and Core's evaluate gives a case"
                    " list's values only where the request holds caseList, a form's only where it does not"
                )
        exports = expectation.get("exports", list(EXPORTS))
        if not set(exports) <= set(EXPORTS):
            problems.append(f"{expectation.get('id')} runs at {exports}, and an expectation runs at {list(EXPORTS)}")
        elif "caseList" in (expectation.get("request") or {}) and exports != ["local"]:
            # A case list needs an installed archive (``proof/observe/intent.py`` refuses one on A or B).
            problems.append(f"{expectation.get('id')} opens a case list at {exports}, and a case list runs on local")

    # 2. An expectation for every form.
    on = {}
    for expectation in expectations:
        form = expectation.get("form") or {}
        on.setdefault((form.get("menu"), form.get("form")), []).append(expectation)
    for m, f in _forms(app):
        if (m, f) not in on:
            problems.append(f"form {m}.{f} has no expectation")

    # 3 and 4. Each held entry the base exhibits, where its claim sits.
    for entry in sorted(set(base.exhibits) & held):
        places = {record.get("artifact") for record in claim_log if record.get("entry") == entry}
        for artifact in sorted(place for place in places if isinstance(place, str) and place.startswith("form:")):
            m, f = (int(part) for part in artifact.split(":", 1)[1].split("."))
            if not any(expectation.get("entry") == entry for expectation in on.get((m, f), [])):
                problems.append(f"the held entry {entry}, claimed in {artifact}, has no expectation on that form")
        listed = [
            record
            for record in claim_log
            if record.get("entry") == entry
            and record.get("artifact") == "app.json"
            and any(part in (record.get("where") or "") for part in ("/case_details/", "/case_list"))
        ]
        if listed:
            case_lists = [
                expectation
                for expectation in expectations
                if expectation.get("entry") == entry
                and "caseList" in (expectation.get("request") or {})
                and expectation.get("exports") == ["local"]
            ]
            if not case_lists:
                problems.append(f"the held entry {entry}, claimed on a case list, has no caseList expectation on local")
            if runs_only_on == "web-apps":
                problems.append(
                    f"the held entry {entry} is fixed on a case list, and the base is read as Web Apps only"
                )

    # 5. Each declared change that touches workers, shown before and after.
    by_id = {expectation.get("id"): expectation for expectation in expectations}
    for change in sorted(set(expected.get("firstPublish") or []) & proof3):
        before, after = by_id.get(f"{change}:before"), by_id.get(f"{change}:after")
        if before is None or after is None:
            problems.append(f"the first-publish change {change} has no {change}:before and {change}:after pair")
            continue
        if before.get("exports") != ["A"] or "A" in (after.get("exports") or EXPORTS):
            problems.append(f"{change}:before runs on A alone and {change}:after on B and the archive")
        if before.get("expect") == after.get("expect"):
            problems.append(f"{change}:before and {change}:after expect the same values")

    # 6. A multi-select an expression tests, answered with two choices.
    for m, f, path in _multi_selects_tested(app):
        answered = [
            expectation
            for expectation in on.get((m, f), [])
            for answer in ((expectation.get("request") or {}).get("answers") or [])
            if answer.get("path") == path and len(str(answer.get("value", "")).split()) >= 2
        ]
        if not answered:
            problems.append(f"the multi-select {path} of form {m}.{f} is tested and no expectation answers it twice")

    # 7. Several languages are read where an archive is made.
    if len(_languages(app)) > 1 and runs_only_on == "web-apps":
        problems.append(f"the app holds {_languages(app)}, and the base is read as Web Apps only")
    return problems


def test_each_bases_hand_written_expectations_hold_their_rules(claim_logs):
    held = _held_entries()
    proof3 = _proof3_changes()
    failing = {}
    for base in BASES:
        problems = _problems(base, claim_logs.get(base.id, []), held, proof3)
        if problems:
            failing[base.id] = problems
    assert not failing, "\n".join(f"{base_id}: {'; '.join(problems)}." for base_id, problems in sorted(failing.items()))
