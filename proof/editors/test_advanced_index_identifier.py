"""HQ's advanced Case Management editor and native index names."""

import base64
from contextlib import ExitStack
from copy import deepcopy

import pytest
from lxml import etree

from proof.connect import hq as connect_hq
from proof.core.artifacts import TEMPLATE_RESTORE, XFORMS
from proof.core.client import load_answer_table
from proof.core.test_session import form_step, person_cases, screens
from proof.editors import compare, pages
from proof.editors.conftest import ADVANCED_APP, publish_hq_app
from proof.editors.hq import HQAnswers, editor_build
from proof.formplayer import hq as formplayer_hq
from proof.formplayer.client import HqRequest
from proof.hq import operations
from proof.hq import redis as hq_redis
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.test_case_processing import _case, _create, _submission
from proof.hq.test_publish import _ask
from proof.observe import casedata
from proof.observe.build import arrange
from proof.observe.sessions import admitted, unmarked_submission

CASE = "http://commcarehq.org/case/transaction/v2"
PARENT = "chosen-clinic"
CHILD_NAME = "One requisition"
SYNTHETIC_DATE = "2025-12-01T08:00:00.000Z"
NEIGHBOR = "unrelated-requisition"
OTHER_WORKER_CASE = "another-worker-requisition"
LOOKUP_FORM = f"""<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="{XFORMS}">
    <h:head><h:title>Read a case index</h:title><model>
      <instance><data xmlns="http://example.org/check-index"/></instance>
      <instance id="casedb" src="jr://instance/casedb"/>
    </model></h:head><h:body/>
    </h:html>""".encode()


def _restore():
    root = etree.fromstring(person_cases(TEMPLATE_RESTORE.read_bytes(), [PARENT]))
    case = root.find(f"{{{CASE}}}case[@case_id='{PARENT}']")
    case.find(f"{{{CASE}}}create/{{{CASE}}}case_type").text = "clinic"
    return etree.tostring(root)


def _worker_database(*cases):
    return casedata.CaseDatabase(casedata.USER_ID, casedata.USERNAME, (), cases)


def _worker_case(case_id, case_type, name, *, owner=None, indices=()):
    return casedata.CaseRecord(
        case_id, case_type, name, owner or casedata.USER_ID,
        SYNTHETIC_DATE, SYNTHETIC_DATE, None, (), indices,
    )


def _authenticated_restore(state, app_id, worker, device):
    credentials = base64.b64encode(
        f"{worker.username}:{formplayer_hq.PASSWORD}".encode(),
    ).decode("ascii")
    request = HqRequest(
        "GET", f"/a/{state.domain}/phone/restore/{app_id}/",
        f"version=2.0&device_id={device}", (("Authorization", f"Basic {credentials}"),), b"",
    )
    status, body = _ask(state, request, device)
    assert status == 200, status
    return body


def _edit_connections(editor_driver, state, app_id, form_id, reference, bindings):
    page = pages.ADVANCED_CASE_MANAGEMENT
    path, save_path = pages._urls(state, page, app_id, form_id)
    steps = pages._steps(page, path, save_path)
    steps[2:2] = [
        {
            "until": "webapps/fill",
            "arg": {"selector": f'#case-config-ko input[data-bind="value: {binding}"]', "value": reference},
        }
        for binding in bindings
    ]
    editor_build()
    answers = HQAnswers(state)
    editor_driver.run(steps, answer=answers, deadline=120)
    answers.check()
    save, = [exchange for exchange in answers.exchanges if exchange.method == "POST" and exchange.path == save_path]
    assert save.status == 200, save.response


@pytest.mark.parametrize(
    "reference",
    ["my-parent", "my.parent", "my.", "my..parent", "my.2parent", "_parent", "métrique", "mé-trique"],
    ids=["hyphen", "dot", "trailing-dot", "two-dots", "digit-after-dot", "leading-underscore", "accented", "accented-hyphen"],
)
def test_advanced_case_management_keeps_an_index(editor_driver, hq, core_runner, tmp_path, reference):
    with hq_check(Configuration(privileges={"CHILD_CASES"})) as (state, record), ExitStack() as mobile:
        app_id = publish_hq_app(state, ADVANCED_APP)
        app = operations.held_app(state, app_id)
        form = app.modules[1].forms[1]
        _edit_connections(editor_driver, state, app_id, form.unique_id, reference, ["reference_id"])
        current = operations.held_app(state, app_id).get_form(form.unique_id)
        index, = current.actions.open_cases[0].case_indices
        assert (index.tag, index.reference_id, index.relationship) == ("load_clinic0", reference, "child")

        # Each call opens a fresh browser view and posts the native editor's model.
        for _ in range(2):
            saved = pages.fresh_section_save(
                editor_driver, state, pages.ADVANCED_CASE_MANAGEMENT, app_id, form.unique_id,
            )
            assert saved.save is not None and not saved.refused, (saved.unsent, saved.alerts, saved.response)
            current = operations.held_app(state, app_id).get_form(form.unique_id)
            index, = current.actions.open_cases[0].case_indices
            assert (index.tag, index.reference_id, index.relationship) == ("load_clinic0", reference, "child")

        built = compare.build(state, app_id, record)
        assert not built.errors, built.errors
        emitted = etree.fromstring(built.files["modules-1/forms-1.xml"])
        link, = emitted.xpath("//*[local-name()='index']/*[local-name()=$name]", name=reference)
        assert link.get("case_type") == "clinic"
        bind, = emitted.xpath("//*[local-name()='bind'][contains(@nodeset, $path)]", path=f"/index/{reference}")
        assert bind.get("calculate").endswith("/case_id_load_clinic0")
        worker = None
        initial = _restore()
        if not reference.isascii():
            mobile.enter_context(hq_redis.shared(None))
            mobile.enter_context(state.committing())
            hq_redis.flush()
            database = _worker_database(_worker_case(PARENT, "clinic", "Chosen clinic"))
            formplayer_hq.default_roles(state)
            worker = formplayer_hq.create_worker(state, database)
            formplayer_hq.save_cases(state, database, worker)
            initial = _authenticated_restore(state, app_id, worker, "advanced-before-create")
            assert etree.fromstring(initial).find(f"{{{CASE}}}case[@case_id='{PARENT}']") is not None

        with admitted(core_runner, arrange(built.files, tmp_path)) as admission:
            assert admission["admitted"], admission["problems"]
            table = load_answer_table()
            table["novaKinds"]["requisition-name"] = [CHILD_NAME]
            trace = core_runner.session(
                admission["app"], restore=initial, answer_table=table,
                question_kinds={"/data/req_name": "requisition-name"},
            )

        run, = (
            run for run in trace["runs"]
            if (step := form_step(run)) and step.get("xmlns") == form.xmlns
        )
        assert run["end"] == "submitted", run.get("refusal")
        submission, tokens = unmarked_submission(run)
        payload = etree.fromstring(submission)
        transaction, = [block for block in payload.iter(f"{{{CASE}}}case") if block.find(f"{{{CASE}}}create") is not None]
        case_id = transaction.get("case_id")
        assert case_id and case_id != PARENT
        index, = transaction.find(f"{{{CASE}}}index")
        assert (etree.QName(index).localname, index.get("case_type"), index.text) == (reference, "clinic", PARENT)
        snapshot = etree.fromstring(form_step(run)["caseDb"].encode())
        local_case_id = next((token for token, value in tokens.items() if value == case_id), case_id)
        created = snapshot.find(f"case[@case_id='{local_case_id}']")
        assert (created.get("case_type"), created.findtext("case_name")) == ("requisition", CHILD_NAME)
        retained, = created.find("index")
        assert (retained.tag, retained.get("case_type"), retained.text) == (reference, "clinic", PARENT)

        seeded = operations.process_case_blocks(state, _submission(_case(PARENT, _create("clinic", "Chosen clinic"))))
        assert seeded.refusal is None
        read = operations.process_case_blocks(state, submission, cases=[seeded.touched[PARENT].case])
        assert read.refusal is None
        child = read.touched[case_id].case
        assert (child.type, child.name) == ("requisition", CHILD_NAME)
        link, = child.indices
        assert (link.identifier, link.referenced_id, link.referenced_type) == (reference, PARENT, "clinic")

        if worker is None:
            restore = etree.fromstring(initial)
            restore.append(transaction)
            read_restore = etree.tostring(restore, encoding="utf-8")
        else:
            from corehq.form_processor.models import CommCareCase

            # Post the instance Core actually generated from the initial
            # worker restore, and let HQ store it for the fresh device.
            request = connect_hq.device_request(
                connect_hq.receiver_url(state.domain, app_id),
                worker.username, formplayer_hq.PASSWORD, submission,
            )
            status, _ = _ask(state, request, "advanced-submit-index")
            assert status == 201, status
            saved = CommCareCase.objects.get_case(case_id, state.domain)
            assert (saved.case_id, saved.owner_id, saved.name) == (case_id, worker.user_id, CHILD_NAME)
            saved_index, = saved.indices
            assert (saved_index.identifier, saved_index.referenced_id) == (reference, PARENT)
            unaccented = reference.replace("é", "e")
            formplayer_hq.save_cases(state, _worker_database(
                _worker_case(
                    NEIGHBOR, "requisition", "Unrelated requisition",
                    indices=((unaccented, "clinic", PARENT, "child"),),
                ),
                _worker_case(
                    OTHER_WORKER_CASE, "requisition", "Unavailable requisition",
                    owner="another-worker",
                    indices=((reference, "clinic", PARENT, "child"),),
                ),
            ), worker)
            read_restore = _authenticated_restore(state, app_id, worker, "advanced-fresh-after-create")
            restored = etree.fromstring(read_restore)
            restored_case = restored.find(f"{{{CASE}}}case[@case_id='{case_id}']")
            assert restored_case is not None
            restored_link, = restored_case.find(f"{{{CASE}}}index")
            assert (etree.QName(restored_link).localname, restored_link.text) == (reference, PARENT)
            neighbor = restored.find(f"{{{CASE}}}case[@case_id='{NEIGHBOR}']")
            assert neighbor is not None
            assert neighbor.find(f"{{{CASE}}}index/{{{CASE}}}{unaccented}").text == PARENT
            assert restored.find(f"{{{CASE}}}case[@case_id='{OTHER_WORKER_CASE}']") is None

        # A separate form reads the relation after the transaction has been
        # restored. The creating form needs only the session's selected ID.
        found = core_runner.evaluate(
            formBase64=base64.b64encode(LOOKUP_FORM).decode(),
            restoreBase64=base64.b64encode(read_restore).decode(),
            expressions=[f"instance('casedb')/casedb/case[@case_id = '{case_id}']/index/{reference}"],
            instances=["casedb"],
        )
        value, = found["values"]
        assert value.get("value") == PARENT, found

        # Receive Requisition chooses a requisition below the selected clinic,
        # then follows the exact same connection back automatically. A second
        # requisition linked by another name exposes an accidentally broad list.
        from corehq.apps.app_manager.models import AutoSelectCase, LoadUpdateAction

        saved = operations.held_app(state, app_id)
        receive = saved.modules[1].forms[2]
        receive.actions.load_update_cases.append(LoadUpdateAction(
            case_type="clinic",
            case_tag="return_clinic",
            auto_select=AutoSelectCase(mode="case", value_source="case_requisition", value_key="parent"),
        ))
        saved.save()
        _edit_connections(
            editor_driver, state, app_id, receive.unique_id, reference,
            ["case_index.reference_id", "value_key"],
        )
        kept = pages.fresh_section_save(
            editor_driver, state, pages.ADVANCED_CASE_MANAGEMENT, app_id, receive.unique_id,
        )
        assert kept.save is not None and not kept.refused, (kept.unsent, kept.alerts, kept.response)
        receive = operations.held_app(state, app_id).get_form(receive.unique_id)
        chosen, automatic = receive.actions.load_update_cases[-2:]
        assert chosen.case_index.reference_id == reference
        assert automatic.auto_select.value_key == reference

        if worker is None:
            other = deepcopy(transaction)
            other.set("case_id", NEIGHBOR)
            other.find(f"{{{CASE}}}create/{{{CASE}}}case_name").text = "Unrelated requisition"
            other.find(f"{{{CASE}}}index")[0].tag = f"{{{CASE}}}parent"
            restore.append(other)
            read_restore = etree.tostring(restore, encoding="utf-8")
        rebuilt = compare.build(state, app_id, record)
        assert not rebuilt.errors, rebuilt.errors
        suite = etree.fromstring(rebuilt.files["suite.xml"])
        session, = suite.xpath("./entry[form=$xmlns]/session", xmlns=receive.xmlns)
        choice, = session.xpath("datum[@id='case_id_case_requisition']")
        backing, = session.xpath("datum[@id='case_id_return_clinic']")
        assert f"[index/{reference}=" in choice.get("nodeset")
        assert backing.get("function").endswith(f"/index/{reference}")
        with admitted(core_runner, arrange(rebuilt.files, tmp_path / "related")) as admission:
            assert admission["admitted"], admission["problems"]
            trace = core_runner.session(admission["app"], restore=read_restore)
        followup, = (
            run for run in trace["runs"]
            if (step := form_step(run)) and step.get("xmlns") == receive.xmlns
        )
        assert followup["end"] == "submitted", followup.get("refusal")
        selection, = [
            screen for screen in screens(followup, "case-list")
            if screen.get("datum") == "case_id_case_requisition"
        ]
        assert [row["caseId"] for row in selection["rows"]] == [case_id]


def test_advanced_latin1_index_alphabet_survives_a_fresh_worker_restore(editor_driver, hq, core_runner, tmp_path):
    from corehq.form_processor.models import CommCareCase

    # Every precomposed Latin-1 letter in both lexical positions. Keep
    # different case and punctuation spellings as separate index keys.
    letters = [chr(code) for low, high in ((0xC0, 0xD6), (0xD8, 0xF6), (0xF8, 0xFF))
               for code in range(low, high + 1)]
    names = [
        "ordinary", "my-parent", "my.parent",
        *(f"{letter}start" for letter in letters),
        *(f"continued-{letter}" for letter in letters),
    ]
    with hq_check(Configuration(privileges={"CHILD_CASES"})) as (state, record), hq_redis.shared(None), state.committing():
        hq_redis.flush()
        app_id = publish_hq_app(state, ADVANCED_APP)
        app = operations.held_app(state, app_id)
        form = app.modules[1].forms[1]
        action = form.actions.open_cases[0]
        existing, = action.case_indices
        action.case_indices = [
            type(existing).wrap({**existing.to_json(), "reference_id": name}) for name in names
        ]
        app.save()
        saved = pages.fresh_section_save(
            editor_driver, state, pages.ADVANCED_CASE_MANAGEMENT, app_id, form.unique_id,
        )
        assert saved.save is not None and not saved.refused, (saved.alerts, saved.response)
        current = operations.held_app(state, app_id).get_form(form.unique_id)
        assert [index.reference_id for index in current.actions.open_cases[0].case_indices] == names

        built = compare.build(state, app_id, record)
        assert not built.errors, built.errors
        tree = etree.fromstring(built.files["modules-1/forms-1.xml"])
        assert {etree.QName(index).localname for index in tree.xpath("//*[local-name()='index']/*")} == set(names)
        formplayer_hq.default_roles(state)
        database = _worker_database(_worker_case(PARENT, "clinic", "Chosen clinic"))
        worker = formplayer_hq.create_worker(state, database)
        formplayer_hq.save_cases(state, database, worker)
        initial = _authenticated_restore(state, app_id, worker, "alphabet-before-create")

        with admitted(core_runner, arrange(built.files, tmp_path)) as admission:
            assert admission["admitted"], admission["problems"]
            table = load_answer_table()
            table["novaKinds"]["requisition-name"] = [CHILD_NAME]
            trace = core_runner.session(
                admission["app"], restore=initial, answer_table=table,
                question_kinds={"/data/req_name": "requisition-name"},
            )
        run, = (
            run for run in trace["runs"]
            if (step := form_step(run)) and step.get("xmlns") == form.xmlns
        )
        assert run["end"] == "submitted", run.get("refusal")
        submission, _ = unmarked_submission(run)
        transaction, = [
            block for block in etree.fromstring(submission).iter(f"{{{CASE}}}case")
            if block.find(f"{{{CASE}}}create") is not None
        ]
        case_id = transaction.get("case_id")
        assert case_id and case_id != PARENT
        assert {etree.QName(index).localname: index.text for index in transaction.find(f"{{{CASE}}}index")} == dict.fromkeys(names, PARENT)
        request = connect_hq.device_request(
            connect_hq.receiver_url(state.domain, app_id),
            worker.username, formplayer_hq.PASSWORD, submission,
        )
        status, _ = _ask(state, request, "alphabet-submit-indices")
        assert status == 201, status
        saved_case = CommCareCase.objects.get_case(case_id, state.domain)
        assert saved_case.owner_id == worker.user_id
        assert {i.identifier: i.referenced_id for i in saved_case.indices} == dict.fromkeys(names, PARENT)

        restore = _authenticated_restore(state, app_id, worker, "alphabet-fresh-after-create")
        restored = etree.fromstring(restore).find(f"{{{CASE}}}case[@case_id='{case_id}']")
        assert restored is not None
        assert {etree.QName(index).localname: index.text for index in restored.find(f"{{{CASE}}}index")} == dict.fromkeys(names, PARENT)
        indices = f"instance('casedb')/casedb/case[@case_id = '{case_id}']/index"
        expressions = [f"{indices}/{name}" for name in names]
        counted = [f"count({expression})" for expression in expressions]
        # Combining marks can be stored in XML but cannot be a Core XPath name.
        negative = f"{indices}/continued-e\u0301"
        observed = core_runner.evaluate(
            formBase64=base64.b64encode(LOOKUP_FORM).decode(),
            restoreBase64=base64.b64encode(restore).decode(),
            expressions=[*expressions, *counted, negative],
            instances=["casedb"],
        )
        *values, refused = observed["values"]
        assert {value["expression"]: value.get("value") for value in values} == {
            **dict.fromkeys(expressions, PARENT), **dict.fromkeys(counted, "1"),
        }
        assert refused["expression"] == negative and refused["error"]


@pytest.mark.parametrize("reference", ["my/parent", "my:parent", ".parent"], ids=["slash", "colon", "leading-dot"])
def test_advanced_editor_save_cannot_make_an_invalid_xml_index_buildable(editor_driver, hq, reference):
    with hq_check(Configuration(privileges={"CHILD_CASES"})) as (state, record):
        app_id = publish_hq_app(state, ADVANCED_APP)
        app = operations.held_app(state, app_id)
        form = app.modules[1].forms[1]
        _edit_connections(editor_driver, state, app_id, form.unique_id, reference, ["reference_id"])
        current = operations.held_app(state, app_id).get_form(form.unique_id)
        index, = current.actions.open_cases[0].case_indices
        assert index.reference_id == reference
        with pytest.raises(ValueError, match="Invalid tag name"):
            compare.build(state, app_id, record)
