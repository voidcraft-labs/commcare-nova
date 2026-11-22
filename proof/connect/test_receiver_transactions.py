"""Receive a worker instance through HQ and inspect what Connect actually committed.

The submission variants isolate receiver decisions after the worker has finished.
Android and Formplayer exercise the editable uniqueness rules separately. The
direct controls change only the fields that HQ's Connect forwarder cannot send.
"""

import copy
import json
from dataclasses import dataclass
from pathlib import Path

import pytest
from lxml import etree

from proof.connect.conftest import (
    CONFIGURATION,
    CONNECT_XMLNS,
    DELIVER,
    _edit_publish,
    _forwarded_by_hq,
    _Paths,
    connect_ids,
    served_download,
)
from proof.connect.test_receiver import (
    ASSESSMENT_SCORED,
    PAY,
    VISIT_ATTACHMENTS,
    answered,
)
from proof.rules.conftest import published

AREA_ID = "9c4c214e-8cca-4760-ac74-e66c987badb1"
PHOTO = "entrance.png"
AREA_DOWNLOAD = "commcare_connect.opportunity.tasks.download_inaccessibility_request_attachments"


def receiver_instance(document, units, *, tasks=(), modules=(), scores=(), area=False, association=False):
    """Move copies of the worker's submitted activity into independent repeat rows."""
    root = etree.fromstring(document)
    (original,) = root.iter(f"{{{CONNECT_XMLNS}}}deliver")
    wrapper = original.getparent()
    ns = etree.QName(root).namespace
    root.remove(wrapper)
    for unit, recipient in units:
        row = etree.SubElement(root, f"{{{ns}}}row")
        delivery = copy.deepcopy(wrapper)
        (block,) = delivery.iter(f"{{{CONNECT_XMLNS}}}deliver")
        block.set("id", unit)
        block.find(f"{{{CONNECT_XMLNS}}}entity_id").text = recipient
        if association:
            block.find(f"{{{CONNECT_XMLNS}}}work_area_id").text = AREA_ID
        row.append(delivery)

    def add(kind, fields, slug=None):
        holder = etree.SubElement(root, f"{{{ns}}}activity")
        attr = {} if slug is None else {"id": slug}
        block = etree.SubElement(holder, f"{{{CONNECT_XMLNS}}}{kind}", attr, nsmap={None: CONNECT_XMLNS})
        for field, value in fields.items():
            etree.SubElement(block, f"{{{CONNECT_XMLNS}}}{field}").text = value

    for task in tasks:
        add("task", {"name": "Follow up", "description": "A scheduled visit"}, task)
    for slug in modules:
        add(
            "module",
            {"name": slug, "description": "Practice", "time_estimate": "5"},
            slug,
        )
    for score in scores:
        add("assessment", {"user_score": str(score)})
    if area:
        add(
            "work_area_update",
            {
                "work_area_id": AREA_ID,
                "status": "REQUEST_FOR_INACCESSIBLE",
                "reason": "Gate closed",
                "additional_details": "Return on Tuesday",
                "photo_evidence": PHOTO,
            },
        )
    return etree.tostring(root, encoding="utf-8")


@dataclass
class ReceiverFixture:
    unit: str
    unit_renamed: str
    task: str
    downloads: dict
    submissions: dict
    runtime: object
    evidence: Path


@pytest.fixture(scope="module")
def receiver(hq, connect_documents, core_runner, connect_runtime, connect_out, tmp_path_factory):
    document = connect_documents[DELIVER]
    out = connect_out / "receiver-transactions"
    out.mkdir(exist_ok=True)
    with published(document, core_runner, CONFIGURATION) as app:
        built = app.spell()
        assert built.build.files is not None and not built.build.raised, built.build.raised
        paths = _Paths(document, app, core_runner, tmp_path_factory.mktemp("receiver-workers"))
        seed = paths.build(built.build.files, "built", name="hq")["hq"]
        baseline = served_download(app, document, "base")
        edited = served_download(app, document, "edit", change=_edit_publish(app, document), edit=True)
        captured = {}
        for name, download in (("base", baseline), ("edit", edited)):
            path = out / f"{name}.ccz"
            path.write_bytes(download.body)
            captured[name] = {
                "path": download.path,
                "query": download.query,
                "status": download.status,
                "body": str(path),
            }
        original = connect_ids(baseline.body)
        unit, second_unit, task = (
            original["deliver"],
            connect_ids(edited.body)["deliver"],
            original["task"],
        )
        modes = submissions(seed, unit, second_unit, task)
        image = (Path(__file__).parents[1] / "hq-apps/hq-media/media/6.png").read_bytes()
        held = _forwarded_by_hq(
            app,
            document,
            modes,
            connect_runtime,
            attachments_by_name={"area-update": [(PHOTO, "image/png", image)]},
        )
        assert all(
            item.payload["app_id"] == app.app_id and item.payload["domain"] == app.unit.domain for item in held.values()
        )
    for name, submitted in held.items():
        (out / f"{name}.xml").write_bytes(submitted.xml)
        (out / f"{name}.json").write_text(
            json.dumps(
                {
                    "payload": submitted.payload,
                    "hqAttachments": submitted.hq_attachments,
                },
                indent=2,
                ensure_ascii=False,
            )
            + "\n"
        )
    return ReceiverFixture(unit, second_unit, task, captured, held, connect_runtime, out)


def submissions(seed, unit, second_unit, task):
    completed = ("intro", "safety", "followup")
    return {
        "duplicate": receiver_instance(
            seed,
            [(unit, x) for x in ("A", "A", "B")],
            tasks=[task],
            modules=completed,
            scores=[7],
        ),
        "distinct": receiver_instance(seed, [(unit, "A"), (unit, "B")]),
        "empty": receiver_instance(seed, [(unit, ""), (unit, "")]),
        "two-units": receiver_instance(seed, [(unit, "A"), (second_unit, "A")]),
        "module-duplicate": receiver_instance(
            seed,
            [(unit, "A")],
            modules=("intro", "safety", "safety", "followup"),
            scores=[7],
        ),
        "module-distinct": receiver_instance(seed, [(unit, "A")], modules=completed, scores=[7]),
        "assessment-duplicate": receiver_instance(seed, [(unit, "A")], tasks=[task], modules=completed, scores=[7, 8]),
        "length-255": receiver_instance(seed, [(unit, "界" * 255)]),
        "length-256": receiver_instance(seed, [(unit, "A"), (unit, "界" * 256)]),
        "area-update": receiver_instance(seed, [(unit, "A")], area=True, modules=completed),
        "area-association": receiver_instance(seed, [(unit, "A")], association=True),
    }


def receive(
    receiver,
    submitted,
    *,
    name,
    second_unit=False,
    task=False,
    area_worker=None,
    payload=None,
    next_payload=None,
):
    """Scope both roles to the forwarded app and pay the units from its actual releases."""
    sent = submitted.payload if payload is None else payload
    username = sent["metadata"]["username"]
    linked_username = username if "@" in username else f"{username}@{sent['domain']}.commcarehq.org"
    setup = [
        {
            "do": "opportunity",
            "hqUrl": "https://www.commcarehq.org",
            "domain": sent["domain"],
            "learnApp": sent["app_id"],
            "deliverApp": sent["app_id"],
            "passingScore": 5,
            "commcareUsername": linked_username,
            "auto_approve_visits": True,
            "automatic_visit_verification": False,
        },
        {"do": "sync", "hq": [receiver.downloads["base"]]},
    ]
    units = [receiver.unit]
    if second_unit:
        setup.append({"do": "sync", "hq": [receiver.downloads["edit"]]})
        units.append(receiver.unit_renamed)
    setup.extend(
        [
            {"do": "pay", "name": "Visits", "deliverUnits": units},
            {"do": "claim"},
            {"do": "flags", "duplicate": False, "gps": False, "location": 0},
        ]
    )
    if task:
        setup.append({"do": "assign_task", "slug": receiver.task})
    if area_worker is not None:
        setup.append({"do": "assign_area", "worker": area_worker, "case": AREA_ID})
    post = {"do": "post", "name": name, "payload": sent}
    following = post if next_payload is None else {**post, "payload": next_payload}
    steps = receiver.runtime.run({"steps": [*setup, post, following], "observeAreas": area_worker is not None})
    (receiver.evidence / f"scenario-{name}.json").write_text(json.dumps(steps, indent=2, ensure_ascii=False) + "\n")
    return steps[len(setup) - 1 :]


def visit_keys(state):
    return sorted((visit["entityId"], visit["deliverUnit"], visit["status"]) for visit in state["visits"])


@pytest.mark.parametrize(
    "name,ids",
    [("distinct", ["A", "B"]), ("empty", [""]), ("length-255", ["界" * 255])],
)
def test_receiver_non_null_keys_and_identical_replay(receiver, name, ids):
    _, first, repeated = receive(receiver, receiver.submissions[name], name=f"keys-{name}")
    answered(first)
    state = first["state"]
    assert visit_keys(state) == [(key, receiver.unit, "approved") for key in ids]
    assert [(w["entityId"], w["savedPaymentAccrued"]) for w in state["completedWorks"]] == [(key, PAY) for key in ids]
    assert state["access"]["paymentAccrued"] == PAY * len(ids)
    assert state["queued"] == [VISIT_ATTACHMENTS] * len(ids)
    answered(repeated)
    assert repeated["state"] == state


def test_receiver_colliding_visit_commits_only_earlier_work(receiver):
    before, first, repeated = receive(receiver, receiver.submissions["duplicate"], name="colliding-visit", task=True)
    answered(first)
    state = first["state"]
    assert visit_keys(state) == [("A", receiver.unit, "rejected")]
    assert state["visits"][0]["flags"][0][0] == "pending_task"
    assert [(w["entityId"], w["savedPaymentAccrued"]) for w in state["completedWorks"]] == [("A", 0)]
    assert state["access"]["paymentAccrued"] == 0
    assert state["assignedTasks"] == before["state"]["assignedTasks"]
    assert state["completedModules"] == state["assessments"] == []
    assert state["queued"] == [VISIT_ATTACHMENTS]
    answered(repeated)
    assert repeated["state"] == state


def test_receiver_equal_ids_on_distinct_units_pay_one_completed_work(receiver):
    _, first, repeated = receive(
        receiver,
        receiver.submissions["two-units"],
        name="two-required-units",
        second_unit=True,
    )
    answered(first)
    state = first["state"]
    assert visit_keys(state) == sorted([("A", receiver.unit, "approved"), ("A", receiver.unit_renamed, "approved")])
    assert [(w["entityId"], w["savedCompletedCount"], w["savedPaymentAccrued"]) for w in state["completedWorks"]] == [
        ("A", 1, PAY)
    ]
    assert state["access"]["paymentAccrued"] == PAY
    assert state["queued"] == [VISIT_ATTACHMENTS] * 2
    answered(repeated)
    assert repeated["state"] == state


def test_receiver_two_actual_nulls_keep_every_visit_including_repost(receiver):
    payload = copy.deepcopy(receiver.submissions["empty"].payload)
    first_row, second_row = submitted_blocks(payload["form"], "deliver")
    assert first_row.pop("entity_id") == second_row["entity_id"] == ""
    second_row["entity_id"] = None
    _, first, repeated = receive(
        receiver,
        receiver.submissions["empty"],
        payload=payload,
        name="direct-null-and-omitted",
    )
    for post, count in ((first, 2), (repeated, 4)):
        answered(post)
        state = post["state"]
        assert visit_keys(state) == [(None, receiver.unit, "approved")] * count
        assert len({v["xform"] for v in state["visits"]}) == 1
        assert [(w["entityId"], w["savedApprovedCount"]) for w in state["completedWorks"]] == [(None, count)]
        assert state["access"]["paymentAccrued"] == PAY * count
        assert state["queued"] == [VISIT_ATTACHMENTS] * count


@pytest.mark.parametrize(
    "name,modules",
    [("module-duplicate", []), ("module-distinct", ["followup", "intro", "safety"])],
)
def test_receiver_module_savepoint_and_subsequent_assessment(receiver, name, modules):
    before, first, repeated = receive(receiver, receiver.submissions[name], name=name)
    answered(first)
    state = first["state"]
    assert visit_keys(state) == [("A", receiver.unit, "approved")]
    assert state["access"]["paymentAccrued"] == PAY
    assert [m["module"] for m in state["completedModules"]] == modules
    assert [m["slug"] for m in state["learnModules"]] == modules
    assert [a["score"] for a in state["assessments"]] == ([7] if modules else [])
    assert state["access"]["learnProgress"] == (100 if modules else before["state"]["access"]["learnProgress"])
    assert state["queued"] == [
        VISIT_ATTACHMENTS,
        *([ASSESSMENT_SCORED] if modules else []),
    ]
    answered(repeated)
    assert repeated["state"] == state


def test_receiver_second_assessment_rolls_back_visits_tasks_learning_and_callbacks(
    receiver,
):
    before, first, repeated = receive(
        receiver,
        receiver.submissions["assessment-duplicate"],
        name="two-assessments",
        task=True,
    )
    for post in (first, repeated):
        answered(post, 400)
        assert "already completed" in str(post["body"])
        assert post["state"] == before["state"]


def test_receiver_overlong_recipient_rolls_back_the_request(receiver):
    before, first, repeated = receive(receiver, receiver.submissions["length-256"], name="entity-length-256")
    for post in (first, repeated):
        assert post["status"] == 500 and [err["class"] for err in post["raised"]] == ["DataError"], post
        assert post["state"] == before["state"]


def test_hq_keeps_the_photo_but_the_forwarded_update_rolls_back_earlier_work(receiver):
    submitted = receiver.submissions["area-update"]
    assert PHOTO in submitted.hq_attachments[PHOTO]["url"]
    assert submitted.hq_attachments[PHOTO]["length"] > 0
    assert "attachments" not in submitted.payload
    before, first, repeated = receive(receiver, submitted, name="hq-area-missing-manifest", area_worker=True)
    for post in (first, repeated):
        answered(post, 400)
        assert PHOTO in str(post["body"]) and "not found" in str(post["body"])
        assert post["state"] == before["state"]
    assert before["state"]["areas"] == [{"case": AREA_ID, "status": "NOT_VISITED", "assignedToWorker": True}]


def submitted_blocks(node, kind):
    for key, value in node.items():
        if isinstance(value, dict):
            if key == kind and value.get("@xmlns") == CONNECT_XMLNS:
                yield value
            yield from submitted_blocks(value, kind)


@pytest.mark.parametrize("mode", ["complete", "wrong-worker", "unknown-area", "blank-reason", "empty-photo"])
def test_direct_receiver_uses_the_exact_area_and_attached_photo(receiver, mode):
    submitted = receiver.submissions["area-update"]
    payload = copy.deepcopy(submitted.payload)
    payload["attachments"] = {PHOTO: submitted.hq_attachments[PHOTO]}
    (block,) = submitted_blocks(payload["form"], "work_area_update")
    assert block["photo_evidence"] == PHOTO
    if mode == "unknown-area":
        block["work_area_id"] = "42fc7e4a-9a04-4b0c-a7f0-161f4fa42ceb"
    if mode == "blank-reason":
        block["reason"] = "  "
    if mode == "empty-photo":
        block["photo_evidence"] = ""
    before, first, repeated = receive(
        receiver,
        submitted,
        name=f"direct-area-{mode}",
        payload=payload,
        area_worker=mode != "wrong-worker",
    )
    if mode != "complete":
        reason = {
            "unknown-area": "not found",
            "wrong-worker": "not assigned",
            "blank-reason": "reason is required",
            "empty-photo": "photo_evidence is required",
        }[mode]
        for post in (first, repeated):
            answered(post, 400)
            assert reason in str(post["body"])
            assert post["state"] == before["state"]
        return
    answered(first)
    state = first["state"]
    assert visit_keys(state) == [("A", receiver.unit, "approved")]
    assert state["areas"] == [
        {
            "case": AREA_ID,
            "status": "REQUEST_FOR_INACCESSIBLE",
            "assignedToWorker": True,
        }
    ]
    assert state["areaRequests"] == [
        {
            "case": AREA_ID,
            "xform": payload["id"],
            "reason": "Gate closed",
            "details": "Return on Tuesday",
            "status": "PENDING",
        }
    ]
    assert state["queued"] == [VISIT_ATTACHMENTS, AREA_DOWNLOAD]
    assert [m["module"] for m in state["completedModules"]] == [
        "followup",
        "intro",
        "safety",
    ]
    answered(repeated)
    assert repeated["state"] == state


def test_a_second_pending_area_request_rolls_back_its_own_visit(receiver):
    submitted = receiver.submissions["area-update"]
    original = copy.deepcopy(submitted.payload)
    original["attachments"] = {PHOTO: submitted.hq_attachments[PHOTO]}
    changed = copy.deepcopy(original)
    changed["id"] = "7b136381-d86a-4790-bab9-a76d3d30ff64"
    (delivery,) = submitted_blocks(changed["form"], "deliver")
    delivery["entity_id"] = "B"
    _, first, second = receive(
        receiver,
        submitted,
        name="direct-already-pending",
        payload=original,
        area_worker=True,
        next_payload=changed,
    )
    answered(first)
    answered(second, 400)
    assert "pending inaccessibility request" in str(second["body"])
    assert second["state"] == first["state"]


def test_receiver_associates_the_visited_area_without_an_inaccessibility_request(
    receiver,
):
    _, first, repeated = receive(
        receiver,
        receiver.submissions["area-association"],
        name="area-association",
        area_worker=True,
    )
    answered(first)
    state = first["state"]
    assert [v["workArea"] for v in state["visits"]] == [AREA_ID]
    assert [a["status"] for a in state["areas"]] == ["VISITED"]
    assert state["areaRequests"] == []
    assert state["queued"] == [VISIT_ATTACHMENTS]
    answered(repeated)
    assert repeated["state"] == state
