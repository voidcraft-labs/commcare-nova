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
- the drift groups (part 02, The retained HQ reads): for each of the five
  documents ``DRIFT_DOCUMENTS`` names, published as Nova's first publish
  leaves it, two reads of the unchanged app (``app-source``,
  ``app-source-again``), one read after each save its ``hq-side.json``
  names, each made over A in a fork of its own
  (``app-source-after-<save>``), for ``case-list-inline`` the read after
  Nova's media upload, for ``targeted-hq-side-lookup`` the table list and
  the table's rows, and beside them the ownership descriptor the capture
  wrote for the content import (``ownership``); ``navigation-base`` given
  every form-id reference path and two report configs by HQ's own models
  (``hq-built/``); the shell of ``navigation-base`` and the same shell with
  a menu HQ's model added (``shell/``); three lookup tables Nova's workbook
  grammar uploads and HQ's models shape, with their rows, after HQ's table
  editor adds a column and after it renames a tag (``lookups/``); places the
  location resource makes, updates with their own values, archives and
  deletes, its refusals of a create over an archived place, and the level
  resource's refusal of a write (``places/``); and the upload view's answers
  to Nova's captured workbook, to a file that is no workbook and to a
  request with none (``lookup-upload/``). Each read's project space is the
  document's configuration with HQ's API access privilege beside it, which
  every one of these resources requires. A read whose view raised is
  ``{"exception": <its class name>}``. Beside them it holds the two premises
  the comparison rests on: HQ's form-id reference paths are the four the
  normalization replaces, and a stored document lacking a declared key at
  its manifest default reads back at that default (``Detail.display`` alone
  excepted). The editors' saves over ``navigation-base`` and the shell are
  ``proof/editors/test_retained_reads.py``'s, which this module leaves out
  of what it holds.

The plausible failures: an answer written by hand that HQ never gives, a
read made outside HQ's own authentication and limiter (so a refusal Nova
classifies is not HQ's), a file that moves run to run (a read outside its
operation), and a committed file left stale by a pin move.
"""

from __future__ import annotations

import dataclasses
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

    def hold(self, committed: Path, *, ignore=(), others=lambda name: False):
        """The committed files are exactly those made, byte for byte (each ``ignore``d subtree, and each file
        ``others`` says another test writes, left out)."""
        held = {
            path.relative_to(committed).with_suffix("").as_posix(): path.read_text(encoding="utf-8")
            for path in sorted(committed.rglob("*.json"))
            if not any(path.relative_to(committed).as_posix().startswith(prefix) for prefix in ignore)
            and not others(path.relative_to(committed).with_suffix("").as_posix())
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


# The drift groups ---------------------------------------------------------------------------------------------

# The documents whose reads the drift comparison is proven over: a form link (a reference path), media, a person's
# saves in HQ, and the lookup table.
DRIFT_DOCUMENTS = (
    "navigation-base",
    "search-registration-link",
    "case-list-inline",
    "targeted-hq-side-state",
    "targeted-hq-side-lookup",
)
# The four paths ``models/base.py::FormIdProperty`` registers at the pin, which ``normalizeHqAppSource`` replaces
# with position tokens (``lib/deployment/hqSourceBaseline.ts``).
FORM_ID_REFERENCE_PATHS = {
    "modules[*].case_list_form.form_id",
    "modules[*].forms[*].form_links[*].form_id",
    "modules[*].forms[*].shadow_parent_form_id",
    "modules[*].schedule_phases[*].forms[*].form_id",
}
# The one declared key a stored document lacking it does not read back at its manifest default: HQ fills a
# detail's display from its position (``models/details.py``), where the manifest records null.
DEFAULT_EXCEPTIONS = {("Detail", "display")}
SURFACE = PROOF_DIR.parent / "lib" / "commcare" / "surface" / "surface.json"


def _editors_file(name):
    """The files under ``navigation-base/`` and ``shell/`` the editors' saves write
    (``proof/editors/test_retained_reads.py``)."""
    return name.startswith("app-source-after-") and name.endswith("-save")


def _with_api_access(export):
    """The export's project space with HQ's API access privilege beside what it grants."""
    configuration = export.configuration.hq()
    return dataclasses.replace(configuration, privileges=configuration.privileges | {API_ACCESS})


def _keep_raised(retained, name, read):
    """``read()``'s answer kept under ``name``, or, where HQ's view raised in place of answering, the exception's
    class name."""
    try:
        answer = read()
    except Exception as error:  # noqa: BLE001 (any exception HQ's view raises is what the file records)
        return retained.keep(name, {"exception": type(error).__name__})
    return retained.keep(name, answer)


def _ownership(export, name):
    """The ownership descriptor the capture wrote beside one import of the first publish
    (``proof/corpus/entryWriter.ts``: ``create.ownership.json``, ``content.ownership.json``)."""
    return json.loads((export.directory / f"{name}.ownership.json").read_text(encoding="utf-8"))


def _document_reads(documents, document_id, member_name):
    """One document's reads: the published app twice, after each of a person's saves, after its media, and its
    lookup table; and its ownership."""
    from proof.observe import hqside, publish

    document = documents[document_id]
    export = document.exports["minimum"]
    retained = Retained(document_id)
    retained.keep("ownership", _ownership(export, "content"))
    with hq_check(_with_api_access(export)) as (state, _), _services(state), api_rate_limits(state):
        with _operation(state, "api-user"):
            member = operations.seed_api_user(state, member_name)
        app_id = _first_publish(state, export)

        def read(name):
            with _operation(state, name):
                return retained.keep(name, operations.source_read(state, app_id, member))

        first = read("app-source")
        again = read("app-source-again")
        saves = document.hq_side or {}
        for kind, run in hqside.SAVES:
            if kind not in saves:
                continue
            with state.fork():
                with _operation(state, f"hq-side-{kind}"):
                    run(state, app_id, saves[kind])
                read(f"app-source-after-{kind}")
        if export.content.media is not None:
            with _operation(state, "media"):
                uploaded = publish.upload_media(state, app_id, export.content.media)
            assert uploaded["refused"] is None and uploaded["errors"] == [], uploaded
            read("app-source-after-media")
        if document_id == "targeted-hq-side-lookup":
            with _operation(state, "lookup-tables"):
                tables = retained.keep("lookup-tables", operations.lookup_tables_read(state, member))
            for table in _body(tables)["objects"]:
                with _operation(state, f"fixture-rows-{table['tag']}"):
                    retained.keep(
                        f"fixture-rows-{table['tag']}", operations.fixture_rows_read(state, table["id"], member)
                    )
    unread = sorted(set(saves) - {kind for kind, _ in hqside.SAVES})
    assert not unread, unread
    forms = [form["unique_id"] for form in _forms(_body(first))]
    assert forms and not set(forms) & {form["unique_id"] for form in _forms(_body(again))}, document_id
    return retained


def _hq_built(retained, export, member_name):
    """``navigation-base`` after HQ's own models give it every form-id reference path: a case-list form, an
    advanced menu holding two forms, a shadow form of the first and a two-phase visit schedule, and a report menu
    with two configs, one with a slug."""
    from corehq.apps.app_manager.models import (
        AdvancedModule,
        ReportAppConfig,
        ReportModule,
        SchedulePhase,
        SchedulePhaseForm,
    )

    with hq_check(_with_api_access(export)) as (state, _), _services(state), api_rate_limits(state):
        with _operation(state, "api-user"):
            member = operations.seed_api_user(state, member_name)
        app_id = _first_publish(state, export)
        with _operation(state, "hq-built"):
            app = operations.held_app(state, app_id)
            menu = app.get_module(0)
            register = next(form for form in menu.get_forms() if not form.requires_case())
            menu.case_list_form.form_id = register.unique_id
            menu.case_list_form.label = {app.langs[0]: "Register"}
            advanced = app.add_module(AdvancedModule.new_module("Schedule", app.langs[0]))
            advanced.case_type = menu.case_type
            first = advanced.new_form("First visit", app.langs[0])
            second = advanced.new_form("Second visit", app.langs[0])
            shadow = advanced.new_shadow_form("First visit again", app.langs[0])
            shadow.shadow_parent_form_id = first.unique_id
            advanced.has_schedule = True
            advanced.schedule_phases = [
                SchedulePhase(anchor="edd", forms=[SchedulePhaseForm(form_id=first.unique_id)]),
                SchedulePhase(anchor="add", forms=[SchedulePhaseForm(form_id=second.unique_id)]),
            ]
            reports = app.add_module(ReportModule.new_module("Reports", app.langs[0]))
            reports.report_configs = [
                ReportAppConfig(report_id="nova-proof-report-one"),
                ReportAppConfig(report_id="nova-proof-report-two", report_slug="second_report"),
            ]
            app.save()
        reads = []
        for name in ("app-source", "app-source-again"):
            with _operation(state, f"hq-built-{name}"):
                reads.append(_body(retained.keep(name, operations.source_read(state, app_id, member))))
    first_read, again = reads
    advanced_menu = first_read["modules"][1]
    assert first_read["modules"][0]["case_list_form"]["form_id"] in {f["unique_id"] for f in _forms(first_read)}
    assert advanced_menu["forms"][2]["shadow_parent_form_id"] == advanced_menu["forms"][0]["unique_id"]
    assert [p["forms"][0]["form_id"] for p in advanced_menu["schedule_phases"]] == [
        advanced_menu["forms"][0]["unique_id"],
        advanced_menu["forms"][1]["unique_id"],
    ]
    first_configs = first_read["modules"][2]["report_configs"]
    again_configs = again["modules"][2]["report_configs"]
    # Each read mints every report config's uuid and fills an empty slug with the stored uuid, the same each time.
    assert {c["uuid"] for c in first_configs}.isdisjoint({c["uuid"] for c in again_configs})
    assert [c["report_slug"] for c in first_configs] == [c["report_slug"] for c in again_configs]
    assert first_configs[1]["report_slug"] == "second_report"


def _shell_reads(retained, export, member_name):
    """The shell ``navigation-base``'s create makes, and the same shell after HQ's own model adds a menu."""
    from corehq.apps.app_manager.models import Module

    retained.keep("ownership", _ownership(export, "create"))
    with hq_check(_with_api_access(export)) as (state, _), _services(state), api_rate_limits(state):
        with _operation(state, "api-user"):
            member = operations.seed_api_user(state, member_name)
        with _operation(state, "shell"):
            shell_id = operations.apply_upload(state, export.create.upload()).response["app_id"]
        with _operation(state, "shell-app-source"):
            shell = retained.keep("app-source", operations.source_read(state, shell_id, member))
        with _operation(state, "shell-menu"):
            app = operations.held_app(state, shell_id)
            app.add_module(Module.new_module("Added in HQ", app.langs[0]))
            app.save()
        with _operation(state, "shell-app-source-with-a-menu"):
            menu = retained.keep("app-source-with-a-menu", operations.source_read(state, shell_id, member))
    assert _body(shell)["modules"] == [] and len(_body(menu)["modules"]) == 1


@pytest.mark.under_determinism
def test_the_drift_reads_nova_is_served_are_hqs_own(hq, core_runner, documents):
    groups = [
        _document_reads(documents, document_id, f"member-{position}@example.org")
        for position, document_id in enumerate(DRIFT_DOCUMENTS)
    ]
    export = documents["navigation-base"].exports["minimum"]
    hq_built = Retained("hq-built")
    _hq_built(hq_built, export, "member-built@example.org")
    shell = Retained("shell")
    _shell_reads(shell, export, "member-shell@example.org")

    made = {group.group: group.made for group in groups}
    assert set(made["case-list-inline"]) >= {"app-source-after-media"}
    assert {"app-source-after-uiTranslations", "app-source-after-appAttributes"} <= set(made["targeted-hq-side-state"])
    assert {"lookup-tables", "app-source-after-lookupTable"} <= set(made["targeted-hq-side-lookup"])
    for group in (*groups, hq_built, shell):
        group.hold(READS / group.group, others=_editors_file)


def _lookup_workbook(tables):
    """An ``.xlsx`` in the header grammar Nova's lookup workbook writes (``lib/commcare/lookup/workbook.ts``): the
    ``types`` sheet naming each table's tag, ``is_global?`` and fields, and each table's sheet of ``field: <name>``
    columns, each row new."""
    from io import BytesIO

    from couchexport.export import export_raw
    from couchexport.models import Format

    widest = max(len(fields) for _, fields, _ in tables)
    types_headers = ("Delete(Y/N)", "table_id", "is_global?", *(f"field {n}" for n in range(1, widest + 1)))
    types_rows = [("N", tag, "yes", *fields, *([""] * (widest - len(fields)))) for tag, fields, _ in tables]
    sheets = [("types", types_headers, types_rows)]
    for tag, fields, rows in tables:
        sheets.append(
            (tag, ("UID", "Delete(Y/N)", *(f"field: {field}" for field in fields)), [("", "N", *row) for row in rows])
        )
    out = BytesIO()
    export_raw(
        [(name, headers) for name, headers, _ in sheets],
        [(name, rows) for name, _, rows in sheets],
        out,
        format=Format.XLS_2007,
    )
    return out.getvalue()


def _shape_rich(state):
    """``rich`` as HQ's models keep it: not global, a property on its ``name`` field, a row attribute, and its
    second row holding two values in one field."""
    from corehq.apps.fixtures.models import Field, LookupTable, LookupTableRow, TypeField

    table = LookupTable.objects.get(domain=state.domain, tag="rich")
    table.is_global = False
    table.fields = [TypeField(name="code"), TypeField(name="name", properties=["lang"])]
    table.item_attributes = ["zone"]
    table.save()
    first, second = LookupTableRow.objects.iter_rows(state.domain, tag="rich")
    first.fields = {"code": [Field(value="north")], "name": [Field(value="North", properties={"lang": "en"})]}
    first.item_attributes = {"zone": "upland"}
    first.save()
    second.fields = {
        "code": [Field(value="south")],
        "name": [Field(value="South", properties={"lang": "en"}), Field(value="Sud", properties={"lang": "fr"})],
    }
    second.item_attributes = {"zone": "coastal"}
    second.save()


def _table_editor(state, table, body):
    """A save of HQ's lookup table editor (``fixtures/views.py::update_tables``, the PUT its page sends)."""
    from django.urls import resolve, reverse

    from proof.hq import requests as hq_requests

    path = reverse("update_lookup_tables", args=[state.domain, table])
    match = resolve(path)
    response = match.func(
        hq_requests.raw(state, "PUT", path, json.dumps(body).encode(), "application/json"), *match.args, **match.kwargs
    )
    assert response.status_code == 200 and "validation_errors" not in json.loads(response.content), response.content


def _lookup_reads(retained, export, member_name):
    """Three tables Nova's workbook grammar uploads and HQ's models shape, read through the two resources Nova's
    drift check reads, then after HQ's table editor adds a column and, apart, renames a tag."""
    from corehq.apps.fixtures.models import LookupTable

    long_rows = [(f"{n:04}", f"Place {n}") for n in range(1005)]
    workbook = _lookup_workbook(
        [
            ("plain", ("code", "name"), [("001", "Clinic"), ("002", "Hospital")]),
            ("rich", ("code", "name"), [("north", "North"), ("south", "South")]),
            ("long", ("code", "name"), long_rows),
        ]
    )
    with hq_check(_with_api_access(export)) as (state, _), _services(state), api_rate_limits(state):
        with _operation(state, "api-user"):
            member = operations.seed_api_user(state, member_name)
        with _operation(state, "lookup-upload"):
            uploaded = operations.upload_lookup_workbook(state, workbook, replace=True)
            assert uploaded.errors == [], uploaded.errors
            _shape_rich(state)
        with _operation(state, "lookup-tables"):
            tables = {
                t["tag"]: t
                for t in _body(retained.keep("lookup-tables", operations.lookup_tables_read(state, member)))["objects"]
            }
        # The table resource read, through HQ's own resource class, serves what the API answered.
        assert {
            tag: {k: v for k, v in table.items() if k not in ("id", "resource_uri", "tag")}
            for tag, table in tables.items()
        } == operations.served_lookup_tables(state)
        for tag in ("plain", "rich"):
            with _operation(state, f"fixture-rows-{tag}"):
                rows = retained.keep(
                    f"fixture-rows-{tag}", operations.fixture_rows_read(state, tables[tag]["id"], member)
                )
            assert [{"fields": row["fields"]} for row in _body(rows)["objects"]] == operations.served_lookup_rows(
                state, tag
            )
        with _operation(state, "fixture-rows-long-1"):
            page = _body(
                retained.keep("fixture-rows-long-1", operations.fixture_rows_read(state, tables["long"]["id"], member))
            )
        with _operation(state, "fixture-rows-long-2"):
            last = _body(
                retained.keep(
                    "fixture-rows-long-2",
                    operations.fixture_rows_read(state, tables["long"]["id"], member, query=page["meta"]["next"]),
                )
            )
        plain = LookupTable.objects.get(domain=state.domain, tag="plain").id.hex
        with state.fork():
            with _operation(state, "column-added"):
                _table_editor(
                    state,
                    plain,
                    {
                        "tag": "plain",
                        "is_global": True,
                        "description": "",
                        "fields": {"code": {}, "name": {}, "region": {"is_new": True}},
                    },
                )
            with _operation(state, "lookup-tables-after-column-added"):
                retained.keep("lookup-tables-after-column-added", operations.lookup_tables_read(state, member))
            with _operation(state, "fixture-rows-plain-after-column-added"):
                raised = _keep_raised(
                    retained,
                    "fixture-rows-plain-after-column-added",
                    lambda: operations.fixture_rows_read(state, plain, member),
                )
        with state.fork():
            with _operation(state, "renamed"):
                _table_editor(
                    state,
                    plain,
                    {"tag": "plain_renamed", "is_global": True, "description": "", "fields": {"code": {}, "name": {}}},
                )
            with _operation(state, "lookup-tables-after-rename"):
                renamed = retained.keep("lookup-tables-after-rename", operations.lookup_tables_read(state, member))
    assert tables["plain"]["is_global"] is True and tables["rich"]["is_global"] is False
    assert page["meta"]["total_count"] == 1005 and len(page["objects"]) == 1000
    assert page["meta"]["next"].startswith("?") and last["meta"]["next"] is None and len(last["objects"]) == 5
    assert {row["id"] for row in page["objects"]}.isdisjoint({row["id"] for row in last["objects"]})
    assert "exception" in raised
    renamed_tables = {t["id"]: t["tag"] for t in _body(renamed)["objects"]}
    assert renamed_tables[tables["plain"]["id"]] == "plain_renamed"


def _places_reads(retained, export, member_name):
    """Places the location resource's own PATCH makes, as Nova's push makes them (a parent with coordinates, a child
    without, and a second top-level place made after them), read through the inventory Nova reads: as made, after
    an update that sends a place its own values, after HQ archives it, and apart after HQ
    deletes it; HQ's refusals of a create over the archived place; and the level resource's refusal of a write."""
    from corehq.apps.locations.models import LocationType, SQLLocation

    with hq_check(_with_api_access(export)) as (state, _), _services(state), api_rate_limits(state):
        with _operation(state, "api-user"):
            member = operations.seed_api_user(state, member_name, edit_locations=True)
        with _operation(state, "levels"):
            region = LocationType.objects.create(domain=state.domain, name="Region", code="region")
            LocationType.objects.create(domain=state.domain, name="District", code="district", parent_type=region)
        with _operation(state, "parent"):
            made = operations.location_patch(
                state,
                [
                    {
                        "name": "North",
                        "site_code": "north",
                        "location_type_code": "region",
                        "latitude": "12.5",
                        "longitude": "-1.123456789012345",
                    }
                ],
                member,
            )
            assert made.status == 202, made.retained()
        parent = SQLLocation.objects.get(domain=state.domain, site_code="north").location_id
        with _operation(state, "child"):
            made = operations.location_patch(
                state,
                [
                    {
                        "name": "North clinic",
                        "site_code": "north_clinic",
                        "location_type_code": "district",
                        "parent_location_id": parent,
                    }
                ],
                member,
            )
            assert made.status == 202, made.retained()
        # A place made after the child, so the child is not last and the update that sends it its own values
        # moves it in the inventory's order (``last_modified``).
        with _operation(state, "later"):
            made = operations.location_patch(
                state, [{"name": "South", "site_code": "south", "location_type_code": "region"}], member
            )
            assert made.status == 202, made.retained()
        with _operation(state, "locations"):
            listed = _body(retained.keep("locations", operations.locations_read(state, member)))
        child = next(place for place in listed["objects"] if place["site_code"] == "north_clinic")
        with _operation(state, "unchanged-update"):
            fields = ("name", "site_code", "location_type_code", "parent_location_id", "location_data")
            made = operations.location_patch(
                state, [{"location_id": child["location_id"], **{key: child[key] for key in fields}}], member
            )
            assert made.status == 202, made.retained()
        with _operation(state, "locations-after-unchanged-update"):
            unchanged = _body(
                retained.keep("locations-after-unchanged-update", operations.locations_read(state, member))
            )
        with state.fork():
            with _operation(state, "archive"):
                SQLLocation.objects.get(location_id=child["location_id"]).archive()
            with _operation(state, "locations-after-archive"):
                retained.keep("locations-after-archive", operations.locations_read(state, member))
            again = {
                "name": "North clinic",
                "site_code": "north_clinic",
                "location_type_code": "district",
                "parent_location_id": parent,
            }
            with _operation(state, "create-over-archived-same-name"):
                same = retained.keep(
                    "create-over-archived-same-name", operations.location_patch(state, [again], member)
                )
            with _operation(state, "create-over-archived-other-site-code"):
                other = retained.keep(
                    "create-over-archived-other-site-code",
                    operations.location_patch(state, [{**again, "name": "North clinic annex"}], member),
                )
        with state.fork():
            with _operation(state, "delete"):
                SQLLocation.objects.get(location_id=child["location_id"]).full_delete()
            with _operation(state, "locations-after-delete"):
                retained.keep("locations-after-delete", operations.locations_read(state, member))
        with _operation(state, "level-write"):
            level = retained.keep(
                "level-write", operations.location_type_write(state, member, {"name": "Ward", "code": "ward"})
            )
    by_code = {place["site_code"]: place for place in listed["objects"]}
    assert by_code["north"]["latitude"] == "12.5000000000" and by_code["north"]["longitude"] == "-1.1234567890"
    assert by_code["north_clinic"]["latitude"] is None
    assert [p["site_code"] for p in listed["objects"]] == ["north", "north_clinic", "south"]
    assert [p["site_code"] for p in unchanged["objects"]] == ["north", "south", "north_clinic"]
    assert same.status == 400 and "Location with same name and parent already exists." in same.body
    assert other.status == 400 and "another location already uses this site code" in other.body
    assert level.status == 401, level.retained()


def _lookup_upload_reads(retained, documents, member_name):
    """The upload view's JSON answers (``fixtures/views.py::upload_fixture_api``) to the workbook Nova's push
    captured for ``targeted-hq-side-lookup``, to a file that is no workbook and to a request with no file."""
    export = documents["targeted-hq-side-lookup"].exports["minimum"]
    captured = export.content.lookups
    with hq_check(_with_api_access(export)) as (state, _), _services(state), api_rate_limits(state):
        with _operation(state, "api-user"):
            # The upload needs the account's Edit Data permission
            # (``fixtures/dispatcher.py::require_can_edit_fixtures``).
            member = operations.seed_api_user(state, member_name, edit_data=True)

        def upload(name, body, content_type):
            with _operation(state, name):
                return retained.keep(
                    name,
                    operations.api_request(
                        state,
                        "POST",
                        f"/a/{state.domain}/fixtures/fixapi/",
                        credential=member,
                        body=body,
                        content_type=content_type,
                    ),
                )

        nova = upload("workbook", captured.upload().body, captured.content_type)
        boundary = "nova-proof-boundary"

        def form(fields):
            body = b"".join(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"{extra}\r\n\r\n'.encode()
                + value
                + b"\r\n"
                for name, extra, value in fields
            )
            return body + f"--{boundary}--\r\n".encode(), f"multipart/form-data; boundary={boundary}"

        not_a_workbook = upload(
            "not-a-workbook",
            *form(
                [
                    ("replace", "", b"true"),
                    (
                        "file-to-upload",
                        '; filename="tables.xlsx"\r\nContent-Type: application/octet-stream',
                        b"not a workbook",
                    ),
                ]
            ),
        )
        no_file = upload("no-file", *form([("replace", "", b"true")]))
    assert nova.status == 200 and json.loads(nova.body)["code"] == 200, nova.retained()
    assert json.loads(not_a_workbook.body)["code"] != 200 and json.loads(no_file.body)["code"] != 200


@pytest.mark.under_determinism
def test_the_lookup_and_place_reads_nova_is_served_are_hqs_own(hq, core_runner, documents):
    # Nova's table push and HQ's table editor need the project space's lookup table privilege, which
    # targeted-hq-side-lookup's configuration grants.
    lookup_export = documents["targeted-hq-side-lookup"].exports["minimum"]
    lookups = Retained("lookups")
    _lookup_reads(lookups, lookup_export, "member-lookups@example.org")
    # The location resource needs the project space's locations privilege, which location-multirung's
    # configuration grants.
    places = Retained("places")
    _places_reads(places, documents["location-multirung"].exports["minimum"], "member-places@example.org")
    upload = Retained("lookup-upload")
    _lookup_upload_reads(upload, documents, "member-upload@example.org")
    for group in (lookups, places, upload):
        group.hold(READS / group.group)


def _stripped(value, items):
    """``value`` with every key of an object carrying a ``doc_type`` removed where it holds the default the surface
    manifest records for ``schema:<doc_type>.<key>``, at every depth."""
    if isinstance(value, list):
        return [_stripped(item, items) for item in value]
    if not isinstance(value, dict):
        return value
    doc_type = value.get("doc_type")
    kept = {}
    for key, held in value.items():
        item = items.get(f"schema:{doc_type}.{key}") if isinstance(doc_type, str) and key != "doc_type" else None
        if item is not None and item.get("declared") is True and "default" in item and item["default"] == held:
            continue
        kept[key] = _stripped(held, items)
    return kept


def _differences(left, right, path=(), doc_type=None):
    """Each ``(doc_type, key)`` at which two documents differ, where the difference is a key of an object."""
    if isinstance(left, dict) and isinstance(right, dict):
        found = set()
        here = left.get("doc_type", doc_type)
        for key in set(left) | set(right):
            if key not in left or key not in right:
                found.add((here, key))
            else:
                found |= _differences(left[key], right[key], (*path, key), here)
        return found
    if isinstance(left, list) and isinstance(right, list) and len(left) == len(right):
        found = set()
        for a, b in zip(left, right, strict=True):
            found |= _differences(a, b, path, doc_type)
        return found
    return set() if left == right else {(doc_type, path[-1] if path else None)}


@pytest.mark.under_determinism
def test_the_comparisons_premises_hold_at_the_pin(hq, core_runner, documents):
    """The normalization replaces exactly the form-id reference paths HQ registers, and the schema-growth rule's
    premise: a stored app lacking a declared key at its manifest default reads back at that default."""
    from corehq.apps.app_manager.models import Application, form_id_references
    from jsonpath_ng import parse

    registered = sorted(str(path) for path in form_id_references)
    assert registered == sorted(str(parse(path)) for path in FORM_ID_REFERENCE_PATHS), registered
    items = json.loads(SURFACE.read_text(encoding="utf-8"))["items"]
    export = documents["navigation-base"].exports["minimum"]
    with hq_check(export.configuration.hq()) as (state, _), _services(state):
        app_id = _first_publish(state, export)
        stored = json.loads(json.dumps(operations.held_app(state, app_id).to_json()))
    stripped = _stripped(stored, items)
    removed = len(json.dumps(stored)) - len(json.dumps(stripped))
    assert removed > 0
    read = json.loads(json.dumps(Application.wrap(json.loads(json.dumps(stripped))).to_json()))
    whole = json.loads(json.dumps(Application.wrap(json.loads(json.dumps(stored))).to_json()))
    assert _differences(read, whole) <= DEFAULT_EXCEPTIONS, _differences(read, whole)
