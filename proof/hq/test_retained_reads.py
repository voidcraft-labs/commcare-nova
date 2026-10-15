"""HQ's own answers to the reads and requests Nova's tests serve, retained byte for byte (``proof/hq-reads/``).

Nova's tests never write an answer of HQ's by hand: a test that needs one
serves a file under ``proof/hq-reads/`` (``__tests__/helpers/retainedHqReads.ts``,
``scripts/lib/hqRoundTripCutover/__tests__/fixtures/retainedCutoverReads.ts``).
Each group here makes every state and every read itself, each read in a
determinism operation of its own (``proof.hq.determinism``), writes each
answer to the run's ``<output>/hq-reads/<group>/``, and holds the committed
directory to it byte for byte, so a pin that changes one of HQ's answers
fails here and Nova's tests are never fed a stale one. Each file is
``{ status, headers?, body? }`` (``operations.HqAnswer.retained``): the
headers Nova's client reads, and the body as HQ sent it.

Every request is made through ``operations.api_request``, so HQ's URLconf,
API-key authentication, permission check, privilege check and rate limiter
run, the limiter over counters the harness answers: within its limits
(``seams.api_rate_limits``), or as Redis does (``seams.RedisCounters``) for
the answers it refuses with 429.

- ``publish`` (part 01, A3. The publish sequence, "Lane"): the source read
  of a live app (``navigation-base`` as Nova's first publish leaves it), of
  the empty shell, of an app HQ's own delete soft-deleted, of a linked app,
  of an id HQ does not hold, and of an app made before step 2 (a create that
  carried forms, then an update), the update HQ answers for a deleted, a
  missing and a linked app, and the import HQ refuses at its limiter's floor
  within a second and within a minute.
- ``cutover`` (part 10, The proofs that carry the cutover, "HQ, in the
  lane"): for each fixture document, its pre-step upload bodies
  (``proof/hq-reads/cutover/<document>/legacy/``, never regenerated) applied
  to HQ, HQ's two source reads and two form id reads after the create and
  after the republish, and for four of them that a project space sent the
  ids it holds keeps them; and HQ's answers to each refusal the cutover's
  classification names (``answers/``).

The plausible failures: an answer written by hand that HQ never gives, a
read made outside HQ's own authentication and limiter (so a refusal Nova
classifies is not HQ's), a file that moves run to run (a read outside its
operation), and a committed file left stale by a pin move.
"""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import pytest

from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.conftest import nova_shaped_upload
from proof.hq.seams import RedisCounters, api_rate_limits, rate_counters

PROOF_DIR = Path(__file__).resolve().parents[1]
READS = PROOF_DIR / "hq-reads"
DOCUMENT = "navigation-base"
# An app id HQ has never held.
MISSING_APP = "nova-proof-missing-app"
MEMBER = "member@example.org"

PUBLISH_FILES = (
    "import-429-minute",
    "import-429-second",
    "source-after-create-then-update",
    "source-deleted",
    "source-linked",
    "source-live",
    "source-missing",
    "source-shell",
    "update-deleted",
    "update-linked",
    "update-missing",
)


def _text(value) -> str:
    return json.dumps(value, indent="\t", ensure_ascii=False) + "\n"


class Retained:
    """One group's answers: each written to the run's output as it is made, then the committed files held to
    them."""

    def __init__(self, group):
        self.group = group
        self.made: dict[str, str] = {}
        out = os.environ.get("PROOF_OUT")
        if not out:
            pytest.fail(
                "The retained reads are written under $PROOF_OUT/hq-reads, and PROOF_OUT is not set. Run them through"
                " the proof harness (npm run proof -- proof/hq/test_retained_reads.py), which sets it to /out."
            )
        self.out = Path(out) / "hq-reads" / group

    def keep(self, name, value):
        text = _text(value.retained() if isinstance(value, operations.HqAnswer) else value)
        if name in self.made:
            raise AssertionError(f"The {self.group} group made {name} twice.")
        self.made[name] = text
        path = self.out / f"{name}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return value

    def hold(self, committed: Path, *, ignore=()):
        """The committed files are exactly those made, byte for byte (each ``ignore``d subtree left out)."""
        held = {
            path.relative_to(committed).with_suffix("").as_posix(): path.read_text(encoding="utf-8")
            for path in sorted(committed.rglob("*.json"))
            if not any(path.relative_to(committed).as_posix().startswith(prefix) for prefix in ignore)
        }
        missing = sorted(set(self.made) - set(held))
        stale = sorted(name for name in set(self.made) & set(held) if held[name] != self.made[name])
        extra = sorted(set(held) - set(self.made))
        assert not (missing or stale or extra), (
            f"proof/hq-reads/{self.group}/ is not what HQ answers at its pin: missing {missing}, changed {stale},"
            f" made by nothing {extra}. HQ's answers are written to {self.out}; copy them into"
            f" proof/hq-reads/{self.group}/ and read what changed."
        )


@contextmanager
def _services(state):
    """What HQ's API needs beyond the check's seams: HQ's own Redis, where a user's save takes its lock
    (``proof.hq.redis``), and the commit callbacks HQ's saves register, run where production's commit runs
    them."""
    from proof.hq import redis as hq_redis

    with hq_redis.shared(None), state.committing():
        yield


@contextmanager
def _operation(state, label):
    with state.operation(f"retained:{label}", label.encode()):
        yield


def _first_publish(state, export):
    """Nova's first publish of the document (``proof.observe.publish.create``), as one operation."""
    from proof.observe import publish

    with _operation(state, "first-publish"):
        app_id, refusal, lookups = publish.create(state, export)
    assert refusal is None and (lookups is None or lookups["errors"] == []), (refusal, lookups)
    return app_id


def _app_file(captured):
    return json.loads(operations.upload_field(captured.upload(), "app_file"))


# The publish group --------------------------------------------------------------------------------------------


@pytest.mark.under_determinism
def test_the_publish_reads_nova_is_served_are_hqs_own(hq, core_runner, documents):
    document = documents[DOCUMENT]
    export = document.exports["minimum"]
    retained = Retained("publish")
    with hq_check(export.configuration.hq()) as (state, _), _services(state):
        with api_rate_limits(state):
            with _operation(state, "api-user"):
                member = operations.seed_api_user(state, MEMBER)

            def read(name, app_id):
                with _operation(state, name):
                    return retained.keep(name, operations.source_read(state, app_id, member))

            def update(name, app_id):
                with _operation(state, name):
                    upload = operations.with_app_id(export.content.upload(), app_id)
                    return retained.keep(name, operations.import_request(state, upload, member))

            with _operation(state, "shell"):
                shell_id = operations.apply_upload(state, export.create.upload()).response["app_id"]
            shell = read("source-shell", shell_id)
            with _operation(state, "content"):
                filled = operations.apply_upload(state, operations.with_app_id(export.content.upload(), shell_id))
            assert filled.status == 200, filled.response
            live = read("source-live", shell_id)
            with state.fork():
                with _operation(state, "delete"):
                    operations.delete_app_through_view(state, shell_id)
                deleted = read("source-deleted", shell_id)
                update_deleted = update("update-deleted", shell_id)
            with state.fork():
                with _operation(state, "link"):
                    operations.link_app_through_hq(state, shell_id)
                linked = read("source-linked", shell_id)
                update_linked = update("update-linked", shell_id)
            missing = read("source-missing", MISSING_APP)
            update_missing = update("update-missing", MISSING_APP)
            with state.fork():
                # An app made before step 2: a create that carried the forms (HQ re-mints their ids), then the
                # update that sends Nova's.
                content = _app_file(export.content)
                with _operation(state, "create-with-forms"):
                    created = operations.apply_upload(state, nova_shaped_upload(content, content["name"]))
                created_id = created.response["app_id"]
                with _operation(state, "update-over-forms"):
                    operations.apply_upload(state, operations.with_app_id(export.content.upload(), created_id))
                orphaned = read("source-after-create-then-update", created_id)

        with rate_counters(RedisCounters()):
            with state.fork():
                # Two imports in one second: the second is refused at the limiter's floor.
                with _operation(state, "import-429-second"):
                    upload = operations.with_app_id(export.content.upload(), shell_id)
                    first = operations.import_request(state, upload, member)
                    second = retained.keep("import-429-second", operations.import_request(state, upload, member))
            with state.fork():
                # One import a second until the minute's limit refuses one.
                upload = operations.with_app_id(export.content.upload(), shell_id)
                answers = []
                for at in range(30):
                    with _operation(state, f"import-429-minute-{at}"):
                        answers.append(operations.import_request(state, upload, member))
                    if answers[-1].status == 429 and float(answers[-1].headers.get("Retry-After", "0")) > 2:
                        break
                minute = retained.keep("import-429-minute", answers[-1])

    shell_source = json.loads(shell.body)
    assert shell.status == 200 and shell_source["doc_type"] == "Application"
    assert shell_source["modules"] == [] and shell_source["_attachments"] == {} and shell_source["profile"] == {}
    live_source = json.loads(live.body)
    assert live.status == 200 and live_source["modules"] and live_source["modules"][0]["forms"]
    for module in live_source["modules"]:
        for form in module["forms"]:
            assert f"{form['unique_id']}.xml" in live_source["_attachments"], form["unique_id"]
    assert deleted.status == 200 and json.loads(deleted.body)["doc_type"] == "Application-Deleted"
    assert update_deleted.status == 400, update_deleted
    assert linked.status == 200 and json.loads(linked.body)["doc_type"] == "LinkedApplication"
    assert update_linked.status == 400, update_linked
    assert missing.retained() == {"status": 404}
    assert update_missing.status == 404 and json.loads(update_missing.body) == {
        "success": False,
        "error": "Application not found",
    }
    orphaned_source = json.loads(orphaned.body)
    forms = [form for module in orphaned_source["modules"] for form in module["forms"]]
    assert len([name for name in orphaned_source["_attachments"] if name.endswith(".xml")]) > len(forms)
    assert first.status == 200 and second.status == 429
    assert float(second.headers["Retry-After"]) <= 2, second.headers
    assert minute.status == 429 and float(minute.headers["Retry-After"]) > 2, [a.retained() for a in answers]
    retained.hold(READS / "publish")
    assert sorted(retained.made) == sorted(PUBLISH_FILES)


# The cutover group --------------------------------------------------------------------------------------------

CUTOVER = READS / "cutover"
# The fixtures whose kept ids the group proves: a project space sent the ids it holds keeps them.
KEPT_IDS = (
    "navigation-base",
    "targeted-form-links-hidden-and-fallback",
    "case-operation-query",
    "no-matches-parent",
)
# The fixture the refusals are taken over.
ANSWERS_FIXTURE = "navigation-base"
# The privilege HQ's application API requires (``api/resources/__init__.py::HqBaseResource``), which no corpus
# configuration grants since nothing an export holds reads it.
API_ACCESS = "API_ACCESS"
# The toggle that cuts a project space's API off (``HqBaseResource.dispatch``).
API_CUTOFF = "API_BLACKLIST"
CUTOVER_ANSWERS = (
    "answers/application-429",
    "answers/application-cutoff",
    "answers/application-deleted",
    "answers/application-linked",
    "answers/application-missing",
    "answers/application-module-error",
    "answers/application-no-access-api-permission",
    "answers/application-no-api-access",
    "answers/application-not-a-member",
    "answers/application-wrong-key",
    "answers/limits",
    "answers/source-no-edit-apps",
    "answers/source-not-a-member",
    "answers/source-wrong-key",
)


def _fixtures():
    """The fixture documents, each a directory holding its pre-step upload bodies (``legacy/``)."""
    return sorted(path.name for path in CUTOVER.iterdir() if (path / "legacy").is_dir())


@dataclass(frozen=True)
class _Request:
    """One retained pre-step request: its body, and its sidecar naming the body's content type and the lookup
    workbook pushed before it (the legacy layout, ``proof/checks/corpus.py``)."""

    directory: Path
    name: str

    @property
    def meta(self):
        return json.loads((self.directory / f"{self.name}.json").read_text(encoding="utf-8"))

    def upload(self):
        return operations.Upload((self.directory / f"{self.name}.body").read_bytes(), self.meta["contentType"])

    @property
    def lookups(self):
        named = self.meta.get("lookups")
        return None if named is None else _Request(self.directory, named.removesuffix(".body"))

    def workbook(self):
        return operations.upload_field(self.upload(), "file-to-upload")


class _Legacy:
    """One fixture's pre-step upload bodies, as pull request 2 retained them."""

    def __init__(self, fixture):
        self.id = fixture
        self.directory = CUTOVER / fixture / "legacy"
        self.create = _Request(self.directory, "create")
        self.republish = _Request(self.directory, "republish")
        self.configurations = json.loads((self.directory / "configurations.json").read_text(encoding="utf-8"))

    def configuration(self, *, privileges=(API_ACCESS,), flags=()):
        """The project space of the frozen ``minimum`` configuration, with the privileges the content needs (as
        HQ derives them from these bodies, ``proof.checks.configurations.required_privileges``), those it names,
        and ``privileges``."""
        from proof.checks.configurations import required_privileges
        from proof.hq.configuration import Configuration

        minimum = self.configurations["minimum"]
        needed = required_privileges(
            [_app_file(self.create), _app_file(self.republish)], lookup_push=self.create.lookups is not None
        )
        return Configuration(
            flags=frozenset(minimum["flags"]) | frozenset(flags),
            privileges=frozenset(needed) | frozenset(minimum["namedPrivileges"]) | frozenset(privileges),
            commcare_version=minimum["commcareVersion"],
            commtrack=minimum["commtrack"],
            sync_cases_on_form_entry=minimum["syncCasesOnFormEntry"],
            case_search_enabled=minimum["caseSearchEnabled"],
        )


def _legacy_create(state, legacy):
    """The pre-step create, after its workbook, through ``_handle_import_app``: A as an app made before step 2."""
    with _operation(state, "legacy-create"):
        if legacy.create.lookups is not None:
            pushed = operations.upload_lookup_workbook(state, legacy.create.lookups.workbook(), replace=True)
            assert pushed.errors == [], pushed.errors
        created = operations.apply_upload(state, legacy.create.upload())
    assert created.status == 201, created.response
    return created.response["app_id"]


def _legacy_republish(state, legacy, app_id):
    with _operation(state, "legacy-republish"):
        if legacy.republish.lookups is not None:
            pushed = operations.upload_lookup_workbook(state, legacy.republish.lookups.workbook(), replace=True)
            assert pushed.errors == [], pushed.errors
        updated = operations.apply_upload(state, operations.with_app_id(legacy.republish.upload(), app_id))
    assert updated.status == 200, updated.response


def _body(answer):
    assert answer.status == 200, answer.retained()
    return json.loads(answer.body)


def _forms(app):
    return [form for module in app["modules"] for form in module["forms"]]


def _sent(captured):
    """What a pre-step body sent, by position: each menu's id, case type and name, each form's id, xmlns and
    name."""
    app = _app_file(captured)
    return app, [
        (
            module["unique_id"],
            module["case_type"],
            module["name"],
            [(f["unique_id"], f["xmlns"], f["name"]) for f in module["forms"]],
        )
        for module in app["modules"]
    ]


def _ids(source, application):
    """The ids HQ holds by position: each menu's id and each form's xmlns from the source read, each form's id
    from the form id read (the source read mints its own)."""
    return {
        "modules": [module["unique_id"] for module in source["modules"]],
        "forms": [form["unique_id"] for form in _forms(application)],
        "xmlns": [form["xmlns"] for form in _forms(source)],
    }


def _agree(source, application):
    """Menu ids and ``xmlns`` agree between the source read and the form id read at every position."""
    assert [m["unique_id"] for m in source["modules"]] == [m["unique_id"] for m in application["modules"]]
    assert [f["xmlns"] for f in _forms(source)] == [f["xmlns"] for f in _forms(application)]


def _holds_what_was_sent(source, sent, *, form_ids=None):
    """The source read holds, at every position, the case type and name the body carried for each menu and the
    name for each form (and, where ``form_ids`` is given, each form id the form id read gave matches it)."""
    assert len(source["modules"]) == len(sent)
    for module, (_, case_type, name, forms) in zip(source["modules"], sent, strict=True):
        assert (module["case_type"], module["name"]) == (case_type, name)
        assert [form["name"] for form in module["forms"]] == [form_name for _, _, form_name in forms]
    if form_ids is not None:
        assert form_ids == [form_id for *_, forms in sent for form_id, _, _ in forms]


def _with_form_ids(captured, held_form_ids, app_id):
    """The pre-step body with each form's ``unique_id`` replaced, everywhere the app file writes it, by the id HQ
    holds for the form at its position: the update a cutover that recorded HQ's ids sends."""
    app, sent = _sent(captured)
    text = json.dumps(app)
    legacy_ids = [form_id for *_, forms in sent for form_id, _, _ in forms]
    for legacy_id, held_id in zip(legacy_ids, held_form_ids, strict=True):
        text = text.replace(legacy_id, held_id)
    return nova_shaped_upload(json.loads(text), app["name"], app_id=app_id)


def _kept_ids(state, legacy, captured, app_id, member, label):
    """Two updates whose body is ``captured`` with HQ's form ids, in a fork; what HQ held before and after each."""
    with state.fork():
        source = _body(operations.source_read(state, app_id, member))
        application = _body(operations.form_id_read(state, app_id, member))
        before = _ids(source, application)
        attachments = len(source["_attachments"])
        after = []
        for round in (1, 2):
            with _operation(state, f"{label}-kept-{round}"):
                answered = operations.import_request(state, _with_form_ids(captured, before["forms"], app_id), member)
            assert answered.status == 200, answered.retained()
            held = operations.held_app(state, app_id)
            stored = {
                "modules": [module.unique_id for module in held.modules],
                "forms": [form.unique_id for form in held.get_forms()],
                "xmlns": [form.xmlns for form in held.get_forms()],
            }
            source = _body(operations.source_read(state, app_id, member))
            application = _body(operations.form_id_read(state, app_id, member))
            read = _ids(source, application)
            assert stored == read == before, (label, round, stored, read, before)
            assert len(source["_attachments"]) == attachments, (label, round)
            after.append(read)
    return {"before": before, "after": after}


def _fixture_reads(retained, legacy, member_name):
    """One fixture's two states, as the cutover reads them."""
    with hq_check(legacy.configuration()) as (state, _), _services(state), api_rate_limits(state):
        with _operation(state, "api-user"):
            member = operations.seed_api_user(state, member_name)
        app_id = _legacy_create(state, legacy)

        def read(state_name, name, reader):
            with _operation(state, f"{state_name}-{name}"):
                return retained.keep(f"{legacy.id}/{state_name}/{name}", reader(state, app_id, member))

        sources = [
            _body(read("after-create", name, operations.source_read)) for name in ("app-source", "app-source-again")
        ]
        applications = [
            _body(read("after-create", name, operations.form_id_read)) for name in ("application", "application-again")
        ]
        kept = {}
        if legacy.id in KEPT_IDS:
            kept["after-create"] = _kept_ids(state, legacy, legacy.create, app_id, member, "after-create")
        _legacy_republish(state, legacy, app_id)
        republished = _body(read("after-republish", "app-source", operations.source_read))
        republished_ids = _body(read("after-republish", "application", operations.form_id_read))
        if legacy.id in KEPT_IDS:
            kept["after-republish"] = _kept_ids(state, legacy, legacy.republish, app_id, member, "after-republish")
            for name, value in kept.items():
                retained.keep(f"{legacy.id}/kept-ids/{name}", value)

    # After the create: each source read mints its own form ids, the form id reads agree, and every position
    # holds what the create sent.
    first, again = sources
    assert not {f["unique_id"] for f in _forms(first)} & {f["unique_id"] for f in _forms(again)}, legacy.id
    assert applications[0] == applications[1], legacy.id
    for source in sources:
        _agree(source, applications[0])
        _holds_what_was_sent(source, _sent(legacy.create)[1])
    # After the republish: HQ holds the republish's form ids and xmlns, and the attachments of both generations.
    _, sent = _sent(legacy.republish)
    _agree(republished, republished_ids)
    _holds_what_was_sent(republished, sent, form_ids=[form["unique_id"] for form in _forms(republished_ids)])
    assert [f["xmlns"] for f in _forms(republished)] == [xmlns for *_, forms in sent for _, xmlns, _ in forms]
    assert len(republished["_attachments"]) > len(_forms(republished)), legacy.id


def _answers(retained):
    """HQ's answer to each refusal the cutover's classification names, over the answers fixture."""
    from corehq.apps.api.resources.meta import api_rate_limiter

    legacy = _Legacy(ANSWERS_FIXTURE)

    def answer(name, reader, state, app_id, credential):
        with _operation(state, f"answer-{name}"):
            return retained.keep(f"answers/{name}", reader(state, app_id, credential))

    with hq_check(legacy.configuration()) as (state, _), _services(state):
        with api_rate_limits(state):
            with _operation(state, "api-users"):
                member = operations.seed_api_user(state, MEMBER)
                no_api = operations.seed_api_user(state, "no-api@example.org", access_api=False)
                no_edit = operations.seed_api_user(state, "no-edit@example.org", edit_apps=False)
                stranger = operations.seed_api_user(state, "stranger@example.org", member=False)
            wrong = operations.ApiCredential(MEMBER, "nova-proof-wrong-key")
            app_id = _legacy_create(state, legacy)
            no_api_source = operations.source_read(state, app_id, no_api)
            answer("application-no-access-api-permission", operations.form_id_read, state, app_id, no_api)
            answer("source-no-edit-apps", operations.source_read, state, app_id, no_edit)
            answer("source-not-a-member", operations.source_read, state, app_id, stranger)
            answer("application-not-a-member", operations.form_id_read, state, app_id, stranger)
            answer("source-wrong-key", operations.source_read, state, app_id, wrong)
            answer("application-wrong-key", operations.form_id_read, state, app_id, wrong)
            answer("application-missing", operations.form_id_read, state, MISSING_APP, member)
            with state.fork():
                with _operation(state, "delete"):
                    operations.delete_app_through_view(state, app_id)
                answer("application-deleted", operations.form_id_read, state, app_id, member)
            with state.fork():
                with _operation(state, "link"):
                    operations.link_app_through_hq(state, app_id)
                answer("application-linked", operations.form_id_read, state, app_id, member)
            with state.fork():
                with _operation(state, "unparsable-form"):
                    operations.break_form_source(state, app_id)
                answer("application-module-error", operations.form_id_read, state, app_id, member)
        with rate_counters(RedisCounters()) as counters, state.fork():
            with _operation(state, "answer-application-429"):
                for _ in range(15):
                    assert operations.source_read(state, app_id, member).status == 200
                uncounted = dict(counters.counts)
                first = operations.form_id_read(state, app_id, member)
                limited = retained.keep("answers/application-429", operations.form_id_read(state, app_id, member))
            retained.keep(
                "answers/limits",
                {
                    scope: {counter.key: limit for counter, _, limit in rates}
                    for scope, rates in api_rate_limiter.iter_rates(state.domain)
                },
            )

    with hq_check(legacy.configuration(privileges=())) as (state, _), _services(state), api_rate_limits(state):
        with _operation(state, "api-user"):
            member = operations.seed_api_user(state, MEMBER)
        app_id = _legacy_create(state, legacy)
        no_privilege_source = operations.source_read(state, app_id, member)
        answer("application-no-api-access", operations.form_id_read, state, app_id, member)
    with (
        hq_check(legacy.configuration(flags=(API_CUTOFF,))) as (state, _),
        _services(state),
        api_rate_limits(state),
    ):
        with _operation(state, "api-user"):
            member = operations.seed_api_user(state, MEMBER)
        app_id = _legacy_create(state, legacy)
        answer("application-cutoff", operations.form_id_read, state, app_id, member)

    return {
        "no_api_source": no_api_source,
        "no_privilege_source": no_privilege_source,
        "uncounted": uncounted,
        "first": first,
        "limited": limited,
    }


@pytest.mark.under_determinism
def test_the_cutover_reads_nova_is_served_are_hqs_own(hq, core_runner):
    retained = Retained("cutover")
    fixtures = _fixtures()
    assert len(fixtures) == 17, fixtures
    for position, fixture in enumerate(fixtures):
        _fixture_reads(retained, _Legacy(fixture), f"member-{position}@example.org")
    seen = _answers(retained)

    made = {name: json.loads(text) for name, text in retained.made.items() if name.startswith("answers/")}
    # The source read needs no API access and no access_api permission; the form id read needs both.
    assert seen["no_privilege_source"].status == 200 and seen["no_api_source"].status == 200
    assert made["answers/application-no-api-access"]["status"] == 401
    assert "error" in json.loads(made["answers/application-no-api-access"]["body"])
    assert made["answers/application-cutoff"]["status"] == 401
    assert made["answers/application-no-access-api-permission"]["status"] == 403
    assert made["answers/source-no-edit-apps"]["status"] == 403
    assert made["answers/source-not-a-member"]["status"] == made["answers/application-not-a-member"]["status"] == 403
    for name in ("answers/source-wrong-key", "answers/application-wrong-key"):
        assert made[name]["status"] == 401 and "body" not in made[name], made[name]
        assert made[name]["headers"]["Content-Type"].startswith("text/html"), made[name]
    assert made["answers/application-deleted"]["status"] == made["answers/application-missing"]["status"] == 404
    linked = json.loads(made["answers/application-linked"]["body"])
    assert made["answers/application-linked"]["status"] == 200 and linked["modules"]
    module_error = json.loads(made["answers/application-module-error"]["body"])
    assert any(set(module) == {"error"} for module in module_error["modules"]), module_error["modules"]
    # Fifteen source reads move no counter; the second form id read of one second is refused, with no wait named.
    assert seen["uncounted"] == {}
    assert seen["first"].status == 200
    assert made["answers/application-429"]["status"] == 429 and "body" not in made["answers/application-429"]
    assert "Retry-After" not in made["answers/application-429"].get("headers", {})
    retained.hold(CUTOVER, ignore=tuple(f"{fixture}/legacy/" for fixture in fixtures) + ("legacy-manifest",))
    assert sorted(name for name in retained.made if name.startswith("answers/")) == sorted(CUTOVER_ANSWERS)
