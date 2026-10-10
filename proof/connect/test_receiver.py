"""Connect's own receiver over what HQ forwards of a Nova Connect app's submissions.

Contract: for Nova's learn app and Nova's deliver app, published into HQ as
Nova's publish leaves them, Connect at its pin (``proof/pins.json``) reads the
app's learn module, deliver unit and task from HQ's build
(``opportunity/tasks.py::sync_learn_modules_and_deliver_units``), and its
receiver (``form_receiver/views.py::FormReceiver``, ``processor.py``) turns the
payload HQ's own Connect repeater builds of each submission into a completed
module, an assessment, a visit with its completed work and pay, and a
completed task. Each test states what Connect does with one kind of
submission, and where it refuses or fails, the paired submission it accepts.

The plausible failures: Nova emitting a Connect block HQ's repeater does not
forward or Connect's receiver does not find; an id Connect keys a row by
moving under an opportunity that already holds it (defect 15); a submission
that carries no location where Connect checks one (the harness's finding
34); a block spelled another way by HQ's form designer that Connect reads
differently (finding 55); and a name Nova admits that Connect's receiver
cannot process (finding 60).

Every scenario's steps, with the rows Connect held after each, are written to
the run's ``connect/scenario.<name>.json``, beside the submission and the
payload of each path (``connect/<document>/``).
"""

import io
import json
import zipfile

import pytest

from proof.checks.compare.xml_tree import parse_xml
from proof.connect.conftest import (
    DELIVER,
    DELIVER_KEY_NAMES,
    LEARN,
    LEARN_KEY_NAMES,
    TASK_NAMED_TASK,
    WRITTEN,
    WRITTEN_NEAR,
)

HQ_URL = "https://www.commcarehq.org"
PROFILE_XMLNS = "http://cihi.commcarehq.org/jad"
VISIT_ATTACHMENTS = "commcare_connect.opportunity.tasks.download_user_visit_attachments"
TASK_COMPLETED = "commcare_connect.opportunity.tasks.send_task_completion_notification"
ASSESSMENT_SCORED = "commcare_connect.opportunity.tasks.notify_user_for_scored_assessment"
# What the Core runner answers the learn form's score with (``proof/core/answers.json``), which the assessment
# reads; the learn app passes at 5.
SCORE = 7
PASSING_SCORE = 5
# What the payment unit of every scenario pays for one approved visit (``proof/connect/driver.py``).
PAY = 10


class World:
    """The Connect apps and the scenarios made of them."""

    def __init__(self, apps, runtime, out):
        self.learn, self.deliver, self.named_task = apps[LEARN], apps[DELIVER], apps[TASK_NAMED_TASK]
        self.learn_keys, self.deliver_keys = apps[LEARN_KEY_NAMES], apps[DELIVER_KEY_NAMES]
        self._runtime, self._out, self._paths, self._ran = runtime, out, {}, {}
        archives = out / "archives"
        archives.mkdir(exist_ok=True)
        for app in apps.values():
            for name, content in app.archives.items():
                path = archives / f"{app.document}.{name}.ccz"
                path.write_bytes(content)
                self._paths[(app.document, name)] = str(path)
        self.unit, self.unit_renamed = self.deliver.renames["deliver"]
        self.task, self.task_renamed = self.deliver.renames["task"]
        self.module, self.module_renamed = self.learn.renames["module"]

    # Steps -----------------------------------------------------------------------------------------------------

    def opportunity(self, learn=None, deliver=None):
        learn, deliver = learn or self.learn, deliver or self.deliver
        return {
            "do": "opportunity",
            "hqUrl": HQ_URL,
            "domain": deliver.domain,
            "learnApp": learn.app_id,
            "deliverApp": deliver.app_id,
            "commcareUsername": f"{deliver.username}@{deliver.domain}.commcarehq.org",
            "passingScore": PASSING_SCORE,
        }

    def sync(self, learn="built", deliver="built", learn_app=None, deliver_app=None):
        """Connect's sync over HQ's archives of the two apps: each as published, or after its edit ("renamed")."""
        learn_app, deliver_app = learn_app or self.learn, deliver_app or self.deliver
        return {
            "do": "sync",
            "ccz": {
                learn_app.app_id: self._paths[(learn_app.document, learn)],
                deliver_app.app_id: self._paths[(deliver_app.document, deliver)],
            },
        }

    def pay(self, *units):
        return {"do": "pay", "name": "Visits", "deliverUnits": list(units)}

    def assign(self, task):
        return {"do": "assign_task", "slug": task}

    @staticmethod
    def post(app, name):
        return {"do": "post", "name": f"{app.document}:{name}", "payload": app.submissions[name].payload}

    def ready(self, *more):
        """An opportunity synced from HQ's builds, its deliver unit paid for, its worker's claim made."""
        return [self.opportunity(), self.sync(), self.pay(self.unit), {"do": "claim"}, *more]

    # Runs ------------------------------------------------------------------------------------------------------

    def run(self, name, steps):
        """The scenario's steps' results, run once for the session and written to the run's output."""
        if name not in self._ran:
            result = self._runtime.run({"steps": steps})
            (self._out / f"scenario.{name}.json").write_text(
                json.dumps(result, indent=1, sort_keys=True, ensure_ascii=False) + "\n"
            )
            self._ran[name] = result
        return self._ran[name]

    def delivered(self, name, *steps):
        """The posts of a scenario over a ready opportunity, and the rows Connect held at its end."""
        result = self.run(name, self.ready(*steps))
        return [step for step in result if step["do"] == "post"], result[-1]["state"]


@pytest.fixture(scope="session")
def world(connect_apps, connect_runtime, connect_out):
    return World(connect_apps, connect_runtime, connect_out)


def answered(post, status=200):
    """A post's answer as (status, body, what a view raised)."""
    assert (post["status"], post["raised"]) == (status, []), post
    return post["body"]


def flags(visit):
    return [code for code, _ in visit["flags"] or []]


def post_url(profile: bytes):
    """The submission URL a profile gives the device (its ``PostURL`` property), or None where it names none.
    HQ's profile holds its properties in no namespace and Nova's local one in the profile's own; a property is
    read under either."""
    urls = [
        element.get("value")
        for element in parse_xml(profile).iter("property", f"{{{PROFILE_XMLNS}}}property")
        if element.get("key") == "PostURL"
    ]
    assert len(urls) <= 1, urls
    return urls[0] if urls else None


# What Connect reads of the app -------------------------------------------------------------------------------------


def test_connect_reads_the_learn_module_the_deliver_unit_and_the_task_from_hqs_builds(world):
    """Connect's sync downloads each app's archive from HQ and makes exactly the rows the documents author, the
    deliver unit paid by nothing until a manager says so."""
    synced = world.run("sync", [world.opportunity(), world.sync()])[-1]
    assert {(asked["app"], asked["latest"]) for asked in synced["asked"]} == {
        (world.learn.app_id, "release"),
        (world.deliver.app_id, "release"),
    }
    state = synced["state"]
    assert state["learnModules"] == [
        {"slug": "hand_washing", "name": "Hand washing", "description": "Wash for twenty seconds.", "time_estimate": 5}
    ]
    assert state["deliverUnits"] == [{"slug": "home_visit", "name": "Home visit", "paymentUnit": None}]
    assert state["taskTypes"] == [{"slug": "follow_up", "name": "Follow up", "description": "Return within a week."}]
    assert (world.module, world.unit, world.task) == ("hand_washing", "home_visit", "follow_up")


# Both archives ---------------------------------------------------------------------------------------------


def test_a_learn_submission_completes_its_module_and_scores_its_assessment_from_either_archive(world):
    """HQ's build's submission and the local archive's, each received under the app's id, leave Connect the same
    rows: the module completed, learning finished, the assessment scored and passed."""
    posts, state = world.delivered("learn-hq", world.post(world.learn, "hq"))
    answered(posts[0])
    assert [done["module"] for done in state["completedModules"]] == [world.module]
    assert state["access"]["learnProgress"] == 100.0
    assert state["access"]["completedLearnDate"] == "2026-01-15T10:30:00+00:00"
    assert [(a["score"], a["passingScore"], a["passed"]) for a in state["assessments"]] == [
        (SCORE, PASSING_SCORE, True)
    ]
    assert state["queued"] == [ASSESSMENT_SCORED]
    local_posts, local_state = world.delivered("learn-local", world.post(world.learn, "local"))
    answered(local_posts[0])
    assert local_state == state


def test_a_delivery_is_approved_and_paid_from_either_archive(world):
    """A delivery from HQ's build and one from the local archive, each received under the app's id in an
    opportunity that verifies nothing, leave Connect the same rows: one approved visit, its work approved and
    paid, and the visit's attachments asked for."""
    posts, state = world.delivered("deliver-hq", world.post(world.deliver, "hq"))
    answered(posts[0])
    (visit,) = state["visits"]
    assert (visit["deliverUnit"], visit["status"], visit["reviewStatus"]) == (world.unit, "approved", "agree")
    assert (visit["flagged"], visit["flags"], visit["location"], visit["workArea"]) == (False, None, None, None)
    assert (visit["entityId"], visit["entityName"]) == ("proof-worker-2026-01-15", "proof-worker")
    assert [(work["status"], work["savedPaymentAccrued"]) for work in state["completedWorks"]] == [("approved", PAY)]
    assert state["access"]["paymentAccrued"] == PAY
    assert state["queued"] == [VISIT_ATTACHMENTS]
    local_posts, local_state = world.delivered("deliver-local", world.post(world.deliver, "local"))
    answered(local_posts[0])
    assert local_state == state


def test_the_form_that_delivers_also_completes_the_workers_assigned_task(world):
    """Nova's deliver form holds the task beside the deliver unit, and Connect reads the unit first: while the
    task is assigned the form's own visit is rejected for it, the same submission then completes the task, and
    the next day's visit is approved."""
    posts, state = world.delivered(
        "deliver-task", world.assign(world.task), world.post(world.deliver, "hq"), world.post(world.deliver, "hq@next")
    )
    answered(posts[0])
    (first,) = posts[0]["state"]["visits"]
    assert (first["status"], flags(first)) == ("rejected", ["pending_task"])
    assert [(task["slug"], task["status"]) for task in posts[0]["state"]["assignedTasks"]] == [
        (world.task, "completed")
    ]
    assert posts[0]["state"]["queued"] == [VISIT_ATTACHMENTS, TASK_COMPLETED]
    answered(posts[1])
    assert sorted((visit["entityId"], visit["status"]) for visit in state["visits"]) == [
        ("proof-worker-2026-01-15", "rejected"),
        ("proof-worker-2026-01-16", "approved"),
    ]
    assert state["access"]["paymentAccrued"] == PAY


def test_a_local_archives_submission_names_no_app_and_connect_refuses_it(world, connect_apps):
    """HQ's build tells the device to post to the receiver under the app's id; Nova's local archive names no
    submission URL at all, so no post from it names the app. Posted to the project space's receiver with no app
    named, HQ records no app, forwards a payload whose app id is null, and Connect refuses it and writes
    nothing. The same submission received under the app's id is accepted (the two tests above)."""
    for app in (world.learn, world.deliver):
        with zipfile.ZipFile(io.BytesIO(app.archives["built"])) as built:
            assert post_url(built.read("profile.ccpr")).endswith(f"/a/{app.domain}/receiver/{app.app_id}/")
        assert post_url(app.local_profile) is None
        unnamed = app.submissions["local-unnamed"]
        assert unnamed.forwarded.forwards is True
        assert (unnamed.payload["app_id"], unnamed.payload["build_id"]) == (None, None)
        assert unnamed.xml == app.submissions["local"].xml
        assert app.submissions["local"].payload["app_id"] == app.app_id
        before = world.run("ready", world.ready())[-1]["state"]
        posts, state = world.delivered(f"unnamed-{app.document}", world.post(app, "local-unnamed"))
        assert answered(posts[0], 400) == {"app_id": ["This field may not be null."]}
        assert state == before


# Finding 34: location ----------------------------------------------------------------------------------------------


def test_only_hqs_build_carries_a_location_to_connect(world):
    """HQ's build holds the meta's location node, so the fix a device's GPS gave the form's sensor poll reaches
    Connect as the visit's location; Nova's local archive holds none, so on a device with the same fix the form
    has nowhere to write it and Connect is given null. Core, which has no GPS, writes none on either."""
    submissions = world.deliver.submissions
    assert submissions["hq"].payload["metadata"]["location"] is None
    assert submissions["hq+fix"].payload["metadata"]["location"] == WRITTEN
    assert submissions["local+fix"].payload["metadata"]["location"] is None


def test_gps_verification_flags_every_delivery_that_carries_no_location(world):
    """With the opportunity's GPS verification on, Connect flags a delivery with no location "GPS data is
    missing" and leaves it pending where it would have approved it: the local archive's always, and HQ's
    build's only while the device has no fix. With verification off neither is flagged (the delivery test)."""
    gps_on = {"do": "flags", "gps": True}
    for name, submission in (("gps-local", "local+fix"), ("gps-hq-no-fix", "hq")):
        posts, state = world.delivered(name, gps_on, world.post(world.deliver, submission))
        answered(posts[0])
        (visit,) = state["visits"]
        assert (visit["status"], visit["flags"], visit["location"]) == (
            "pending",
            [["gps", "GPS data is missing"]],
            None,
        )
        assert state["access"]["paymentAccrued"] == 0
    posts, state = world.delivered("gps-hq-fix", gps_on, world.post(world.deliver, "hq+fix"))
    answered(posts[0])
    (visit,) = state["visits"]
    assert (visit["status"], visit["flags"], visit["location"]) == ("approved", None, WRITTEN)
    assert state["access"]["paymentAccrued"] == PAY


def test_the_distance_check_passes_over_a_delivery_that_carries_no_location(world):
    """With the opportunity checking visits within 100 m of another, Connect flags HQ's build's second visit
    about four metres from the first and passes one made far away. A local archive's delivery escapes the check
    on both sides: made at the first visit's place it is not flagged, and a later visit at its place is not
    flagged against it."""
    within = {"do": "flags", "location": 100}
    deliver = world.deliver

    def second(name, first, then):
        posts, state = world.delivered(name, within, world.post(deliver, first), world.post(deliver, then))
        answered(posts[0])
        answered(posts[1])
        return next(visit for visit in state["visits"] if visit["entityId"] == "proof-worker-2026-01-16")

    near = second("distance-hq-near", "hq+fix", "hq@next+near")
    assert near["status"] == "pending" and flags(near) == ["location"]
    assert near["flags"][0][1].startswith("Visit location is 4.") and near["flags"][0][1].endswith(
        "m from another visit"
    )
    assert second("distance-hq-far", "hq+fix", "hq@next+far")["flags"] is None
    checked = second("distance-local-checked", "hq+fix", "local@next+near")
    assert (checked["status"], checked["flags"], checked["location"]) == ("approved", None, None)
    other = second("distance-local-other", "local+fix", "hq@next+near")
    assert (other["status"], other["flags"], other["location"]) == ("approved", None, WRITTEN_NEAR)


# Finding 55: the work area id HQ's form designer writes ------------------------------------------------------------


def test_connect_reads_the_empty_work_area_id_hqs_form_designer_writes_as_none(world):
    """A Vellum save writes an empty ``work_area_id`` into the deliver unit, which Nova's form does not hold.
    HQ forwards it as an empty string, and Connect's receiver leaves the same rows as for Nova's form."""
    deliver = world.deliver
    assert "work_area_id" not in deliver.submissions["hq"].payload["form"][world.unit]["deliver"]
    assert deliver.submissions["vellum"].payload["form"][world.unit]["deliver"]["work_area_id"] == ""
    posts, state = world.delivered("deliver-vellum", world.post(deliver, "vellum"))
    answered(posts[0])
    _, plain = world.delivered("deliver-hq", world.post(deliver, "hq"))
    assert state == plain


# Defect 15: renamed ids ----------------------------------------------------------------------------------------------


def test_a_renamed_deliver_unit_is_refused_until_a_manager_pays_for_it(world):
    """After the rename, Connect refuses every delivery, from HQ's build and from the local archive alike, with
    "Payment unit is not configured for the deliver unit", and keeps none of it. Its sync of the renamed build
    adds the new unit beside the old one, still unpaid, so deliveries stay refused until a manager adds the new
    unit to a payment unit; then the delivery is accepted, under the new unit."""
    refusal = {
        "detail": "Payment unit is not configured for the deliver unit: Home visit in opportunity: Proof opportunity"
    }
    renamed = world.post(world.deliver, "renamed@next")
    result = world.run(
        "rename-deliver",
        world.ready(
            world.post(world.deliver, "hq"),
            renamed,
            world.sync(deliver="renamed"),
            renamed,
            world.pay(world.unit_renamed),
            renamed,
        ),
    )
    accepted, unsynced, resynced, synced, _, paid = result[4:]
    answered(accepted)
    assert answered(unsynced, 400) == refusal
    assert unsynced["state"] == accepted["state"]
    assert resynced["state"]["deliverUnits"] == [
        {"slug": world.unit, "name": "Home visit", "paymentUnit": "Visits"},
        {"slug": world.unit_renamed, "name": "Home visit", "paymentUnit": None},
    ]
    assert answered(synced, 400) == refusal
    assert synced["state"]["visits"] == accepted["state"]["visits"]
    answered(paid)
    assert sorted((visit["deliverUnit"], visit["status"]) for visit in paid["state"]["visits"]) == [
        (world.unit, "approved"),
        (world.unit_renamed, "approved"),
    ]
    posts, state = world.delivered("rename-deliver-local", world.post(world.deliver, "renamed-local"))
    assert answered(posts[0], 400) == refusal
    assert state["visits"] == []


def test_a_renamed_learn_module_leaves_learning_unfinished(world):
    """After the rename, the receiver makes the renamed module a second module beside the old one, which stays
    counted: a worker who completes the course after the rename stands at half and is never finished, from HQ's
    build and from the local archive alike, and Connect's sync of the renamed build removes nothing. A worker
    who had completed the old module keeps a finished course."""
    for name, submission in (("rename-learn", "renamed"), ("rename-learn-local", "renamed-local")):
        result = world.run(name, world.ready(world.post(world.learn, submission), world.sync(learn="renamed")))
        post, resynced = result[-2], result[-1]
        answered(post)
        for state in (post["state"], resynced["state"]):
            assert [module["slug"] for module in state["learnModules"]] == [world.module, world.module_renamed]
            assert [done["module"] for done in state["completedModules"]] == [world.module_renamed]
            assert (state["access"]["learnProgress"], state["access"]["completedLearnDate"]) == (50.0, None)
    posts, state = world.delivered(
        "rename-learn-after-finishing", world.post(world.learn, "hq"), world.post(world.learn, "renamed@next")
    )
    answered(posts[0])
    answered(posts[1])
    assert (state["access"]["learnProgress"], state["access"]["completedLearnDate"]) == (
        100.0,
        "2026-01-15T10:30:00+00:00",
    )


def test_a_renamed_task_never_completes_the_task_a_worker_was_assigned(world):
    """A task assigned before the rename is of the old task type. After the rename the form's task matches no
    assigned task, so it stays assigned and every delivery of the worker is rejected for it, where the form
    before the rename completed it (the assigned-task test)."""
    posts, state = world.delivered(
        "rename-task",
        world.assign(world.task),
        world.sync(deliver="renamed"),
        world.pay(world.unit_renamed),
        world.post(world.deliver, "renamed"),
        world.post(world.deliver, "renamed@next"),
    )
    answered(posts[0])
    answered(posts[1])
    assert [task["slug"] for task in state["taskTypes"]] == [world.task, world.task_renamed]
    assert [(task["slug"], task["status"], task["xform"]) for task in state["assignedTasks"]] == [
        (world.task, "assigned", None)
    ]
    assert [(visit["status"], flags(visit)) for visit in state["visits"]] == [("rejected", ["pending_task"])] * 2
    assert TASK_COMPLETED not in state["queued"]
    assert state["access"]["paymentAccrued"] == 0


# Finding 60: a block named like one of Connect's own keys ---------------------------------------------------------


def test_a_task_named_task_fails_connects_receiver_on_every_submission(world):
    """Nova names a Connect block's wrapper node by the block's id, and Connect's receiver looks for ``task`` at
    every depth of the form and reads each match's namespace. A task whose id is ``task`` is so wrapped in a
    node that has none: the receiver raises ``KeyError('@xmlns')``, answers 500 and keeps nothing of the
    submission, its delivery included, from HQ's build and the local archive alike. The deliver app whose task
    is ``follow_up`` is accepted (the delivery tests)."""
    app = world.named_task
    assert set(app.submissions["hq"].payload["form"]["task"]) == {"task"}
    result = world.run(
        "task-named-task",
        [
            world.opportunity(deliver=app),
            world.sync(deliver_app=app),
            world.pay("visit"),
            {"do": "claim"},
            world.post(app, "hq"),
            world.post(app, "local"),
        ],
    )
    claimed, from_hq, from_local = result[-3:]
    assert claimed["state"]["taskTypes"] == [
        {"slug": "task", "name": "Record & review", "description": "Ask <then> listen"}
    ]
    for post in (from_hq, from_local):
        assert (post["status"], post["raised"]) == (500, [{"class": "KeyError", "message": "'@xmlns'"}])
        assert post["state"] == claimed["state"]
        assert post["state"]["visits"] == []


def test_every_other_name_connects_receiver_looks_for_fails_it_too(world):
    """The receiver looks for ``module`` and ``assessment`` in a learn app's form, and ``deliver``, ``task`` and
    ``work_area_update`` in a deliver app's. A form whose one Connect block is named like any of them fails the
    receiver the same way, and Connect keeps nothing of it: no completed module, no assessment, no visit. The
    apps whose blocks are named otherwise are accepted (the learn and delivery tests)."""
    learn, deliver = world.learn_keys, world.deliver_keys

    def named(app):
        """Each of the app's submissions, by its Connect block's id (its wrapper node's name)."""
        found = {}
        for submitted in app.submissions.values():
            (wrapper,) = submitted.payload["form"]
            found[wrapper] = {"do": "post", "name": f"{app.document}:{wrapper}", "payload": submitted.payload}
        return found

    posts = {**named(learn), **named(deliver)}
    assert sorted(posts) == ["assessment", "deliver", "module", "work_area_update"]
    result = world.run(
        "key-names",
        [
            world.opportunity(learn=learn, deliver=deliver),
            world.sync(learn_app=learn, deliver_app=deliver),
            world.pay("deliver", "work_area_update"),
            {"do": "claim"},
            *(posts[name] for name in sorted(posts)),
        ],
    )
    claimed = result[3]
    assert [module["slug"] for module in claimed["state"]["learnModules"]] == ["module"]
    assert [unit["slug"] for unit in claimed["state"]["deliverUnits"]] == ["deliver", "work_area_update"]
    for post in result[4:]:
        assert (post["status"], post["raised"]) == (500, [{"class": "KeyError", "message": "'@xmlns'"}]), post["name"]
        assert post["state"] == claimed["state"], post["name"]
