"""The rule ``runtime-url-app-id`` is sound: HQ answers a runtime URL alike under the release's id and under the
working app's, while the release is the app as it stands.

Contract: the rule reads the address of a request a reader sent HQ, and
writes the release's id (``@build``) as the working app's (``@app``) where
the address is a project space's receiver, search, restore or case fixture
address, and leaves every other address as it is. A device on A installs
HQ's release and sends its requests under the release's id; Nova's local
archive names the working app's id. The plausible failures: HQ answering a
search, a restore or a submission otherwise under one id than under the
other (another configuration read, a case left out, a form refused or its
cases applied otherwise); Formplayer walking the release otherwise once its
suite and profile name the working app; and the rule erasing an address
that names another view, another project space or an id that is neither.

Three tests, over one served state of ``targeted-sync-on-form-entry`` (its
search and the follow-up form it opens on the case the worker picks; from step 4
the document is published with sync cases on form entry off, so no claim or sync
step comes before the form):

- the rule over addresses alone;
- HQ's search, restore and receiver views asked directly with the worker's
  credentials under each id, each in a fork of the state: each answers with
  the same status and the same body (a restore but for the restore id HQ
  draws for each), and the form and case records the submission leaves are
  the same but for the form's ``build_id``, which HQ records for the release
  alone (``receiverwrapper/util.py::get_app_and_build_ids``) and which the
  rule does not erase, since it reads the address alone;
- Formplayer's walk of HQ's own release, and of the release with the working
  app's id written into its suite and profile: the lane's judge finds the
  two walks apart at each submission's address and at HQ's answer to the
  submit, which names the saved form by its data node's name where the form
  names no build (``submission_post.py::SubmissionPost._get_form_name``), and
  with the rule at that answer alone.

CommCare Android's reading is
``proof/android/predicates.py::test_a_device_reads_an_archive_alike_under_either_app_id``.
"""

from __future__ import annotations

import hashlib
import json

import pytest

from proof.rules.conftest import published
from proof.rules.runtime_url_app_id import APP, BUILD, RULE, normalize

DOCUMENT = "targeted-sync-on-form-entry"
# Members of an archive that hold runtime URLs: the suite, and every profile HQ's build writes.
URL_MEMBERS = ("suite.xml", "profile.xml", "profile.ccpr", "media_profile.xml", "media_profile.ccpr")
# A name no case of the document's case database holds, for a search that finds nothing.
NO_SUCH_NAME = "nobody holds this name"


# The rule over addresses alone ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "/a/{space}/receiver/{id}/",
        "/a/{space}/receiver/secure/{id}/",
        "/a/{space}/phone/search/{id}/",
        "/a/{space}/phone/restore/{id}/",
        "/a/{space}/phone/case_fixture/{id}/",
    ],
)
def test_the_release_and_the_working_app_are_one_runtime_address_and_nothing_else_moves(path):
    for origin in ("", "https://www.commcarehq.org"):
        release = origin + path.format(space="field-ops", id=BUILD)
        working = origin + path.format(space="field-ops", id=APP)
        assert normalize(release) == normalize(working) == working
        # Another project space's address stays another.
        assert normalize(release) != normalize(origin + path.format(space="other-space", id=APP))
        # An id neither record writes for an app (a placeholder a pre-fix archive named, an id HQ drew) is left.
        for other in ("__APP_ID__", "0123456789abcdef0123456789abcdef"):
            address = origin + path.format(space="field-ops", id=other)
            assert normalize(address) == address
    # The query string an address carries is kept.
    restore = "/a/field-ops/phone/restore/{}/?version=2.0"
    assert normalize(restore.format(BUILD)) == restore.format(APP)


@pytest.mark.parametrize(
    "address",
    [
        # Android's own form post address, which a pre-fix archive's device meets.
        "https://www.commcarehq.org/a/{domain}/receiver",
        f"/a/field-ops/receiver/{BUILD}",
        "/a/field-ops/receiver/",
        f"/a/field-ops/phone/claim-case/{BUILD}/",
        f"/a/field-ops/apps/download/{BUILD}/",
        f"/a/field-ops/phone/search/extra/{BUILD}/",
        f"/receiver/{BUILD}/",
        f"/b/field-ops/receiver/{BUILD}/",
        BUILD,
    ],
)
def test_every_other_address_is_left_as_it_is(address):
    assert normalize(address) == address


def test_the_rule_reads_the_address_of_a_request_and_nothing_else():
    assert RULE.applies_to("request-url")
    for artifact in ("formplayer", "instance", "trace", "suite.xml", "profile.ccpr", "app.json"):
        assert not RULE.applies_to(artifact)
    assert normalize(None) is None
    assert normalize({"path": f"/a/x/receiver/{BUILD}/"}) == {"path": f"/a/x/receiver/{BUILD}/"}


# HQ's own views under each id -----------------------------------------------------------------------------------


def _ask(unit, request, label):
    """HQ's answer to one request a device sends, from its own handler, middleware and the view's decorators,
    over the unit's state (``proof.formplayer.hq.respond``): ``(status, body)``."""
    from proof.formplayer import hq as formplayer_hq

    digest = hashlib.sha256(f"runtime-url-app-id|{label}".encode()).digest()
    with unit.committing(), unit.request(digest), formplayer_hq._language_put_back():
        response = formplayer_hq.respond(formplayer_hq.django_request(request))
        content = b"".join(response.streaming_content) if response.streaming else response.content
    return response.status_code, content


def _worker_get(path, query, username, password):
    import base64

    from proof.formplayer.client import HqRequest

    credentials = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
    return HqRequest("GET", path, query, (("Authorization", f"Basic {credentials}"),), b"")


def _without_restore_id(body):
    """A restore's body with the restore id HQ draws for each restore taken out, parsed and written as XML."""
    from lxml import etree

    root = etree.fromstring(body)
    for element in list(root.iter(etree.Element)):
        if etree.QName(element).localname == "restore_id":
            element.getparent().remove(element)
    return etree.tostring(root, encoding="utf-8")


def _submission(xmlns, case_type, case_id, instance_id, user_id, username):
    """A form of the app as a device sends it: its data node, a case block creating a case the worker owns, and
    the meta block, written as XML."""
    from lxml import etree

    case_ns, meta_ns = "http://commcarehq.org/case/transaction/v2", "http://openrosa.org/jr/xforms"
    data = etree.Element(etree.QName(xmlns, "data"), nsmap={None: xmlns})
    case = etree.SubElement(data, etree.QName(case_ns, "case"), nsmap={"n0": case_ns})
    case.attrib.update({"case_id": case_id, "date_modified": "2026-10-01T10:00:00Z", "user_id": user_id})
    create = etree.SubElement(case, etree.QName(case_ns, "create"))
    for name, value in (("case_name", "Either id"), ("owner_id", user_id), ("case_type", case_type)):
        etree.SubElement(create, etree.QName(case_ns, name)).text = value
    meta = etree.SubElement(data, etree.QName(meta_ns, "meta"), nsmap={"n1": meta_ns})
    for name, value in (
        ("deviceID", "proof-device"),
        ("timeStart", "2026-10-01T10:00:00Z"),
        ("timeEnd", "2026-10-01T10:00:01Z"),
        ("username", username),
        ("userID", user_id),
        ("instanceID", instance_id),
    ):
        etree.SubElement(meta, etree.QName(meta_ns, name)).text = value
    return etree.tostring(data, encoding="utf-8", xml_declaration=True)


def _json(value):
    from corehq.util.json import CommCareJSONEncoder

    return json.loads(json.dumps(value, cls=CommCareJSONEncoder, sort_keys=True))


def _searched_module(doc):
    """The released app's module that offers a case search, by its case type."""
    found = [module for module in doc["modules"] if (module.get("search_config") or {}).get("properties")]
    assert found, "the document offers no case search, so its searches show nothing"
    return found[0]


def _asked_under(served, receiver_id, database, label):
    """In a fork of the served state: HQ's answers to the document's searches, the worker's restore and one form
    of the app, each under ``receiver_id``, and the form and case records the submission left."""
    import uuid

    from corehq.form_processor.models import CommCareCase, XFormInstance

    from proof.connect import hq as connect_hq
    from proof.formplayer import hq as formplayer_hq

    unit, domain = served.unit, served.domain
    username, password = served.username, formplayer_hq.PASSWORD
    module = _searched_module(served.doc)
    case_type = module["case_type"]
    xmlns = module["forms"][0]["xmlns"]
    case_id, instance_id = str(uuid.UUID(int=41)), str(uuid.UUID(int=42))
    held = {"searches": []}
    with unit.fork():
        for name, query in (
            ("all", f"case_type={case_type}"),
            ("none", f"case_type={case_type}&case_name={NO_SUCH_NAME.replace(' ', '+')}"),
        ):
            path = f"/a/{domain}/phone/search/{receiver_id}/"
            held["searches"].append(_ask(unit, _worker_get(path, query, username, password), f"{label}:search:{name}"))
        path = f"/a/{domain}/phone/restore/{receiver_id}/"
        status, body = _ask(
            unit, _worker_get(path, "version=2.0&device_id=proof-device", username, password), f"{label}:restore"
        )
        held["restore"] = (status, _without_restore_id(body) if status == 200 else body)
        submission = _submission(xmlns, case_type, case_id, instance_id, served.worker.user_id, username)
        held["receiver"] = _ask(
            unit,
            connect_hq.device_request(f"/a/{domain}/receiver/{receiver_id}/", username, password, submission),
            f"{label}:receiver",
        )
        held["form"] = _json(XFormInstance.objects.get_form(instance_id, domain).to_json())
        held["case"] = _json(CommCareCase.objects.get_case(case_id, domain).to_json())
    held["database"] = {case.case_id for case in database.cases if case.case_type == case_type}
    return held


def test_hqs_search_restore_and_receiver_answer_alike_under_either_app_id(rule_documents, hq, core_runner):
    from proof.formplayer import hq as formplayer_hq
    from proof.observe import casedata

    document = rule_documents[DOCUMENT]
    database = casedata.document_case_database(document)
    with published(document, core_runner) as app:
        with formplayer_hq.serve(app.unit, document, app.app_id, label="either-id", database=database) as served:
            assert served.build_id != served.app_id
            release = _asked_under(served, served.build_id, database, "asked")
            working = _asked_under(served, served.app_id, database, "asked")

    cases = release["database"]
    assert cases, "the document's case database holds no case its search could find"
    (all_status, all_body), (none_status, none_body) = release["searches"]
    assert all_status == none_status == 200, release["searches"]
    assert all(case_id.encode() in all_body for case_id in cases), all_body[:400]
    assert not any(case_id.encode() in none_body for case_id in cases), none_body[:400]
    assert working["searches"] == release["searches"]
    assert release["restore"][0] == 200 and all(case_id.encode() in release["restore"][1] for case_id in cases)
    assert working["restore"] == release["restore"]
    assert release["receiver"][0] == 201, release["receiver"]
    assert working["receiver"] == release["receiver"]
    assert working["case"] == release["case"]
    assert (release["form"]["app_id"], release["form"]["build_id"]) == (served.app_id, served.build_id)
    assert (working["form"]["app_id"], working["form"]["build_id"]) == (served.app_id, None)
    form_fields = set(release["form"]) | set(working["form"])
    differing = sorted(key for key in form_fields if release["form"].get(key) != working["form"].get(key))
    assert differing == ["build_id"], differing


# Formplayer's walk of the release under each id -----------------------------------------------------------------


def _naming(archive, old, new):
    """The archive with every runtime URL that names ``old`` as the app (an attribute or a text of the suite or a
    profile) naming ``new``, each member parsed and written as XML, and every other member, entry name, order and
    compression kept."""
    import io
    import zipfile
    from urllib.parse import urlsplit, urlunsplit

    from lxml import etree

    from proof.rules.runtime_url_app_id import _runtime_id_at

    def renamed(value):
        if not value:
            return value
        parts = urlsplit(value)
        segments = parts.path.split("/")
        at = _runtime_id_at(segments)
        if at is None or segments[at] != old:
            return value
        segments[at] = new
        return urlunsplit(parts._replace(path="/".join(segments)))

    with zipfile.ZipFile(io.BytesIO(archive)) as source:
        members = [(info, source.read(info)) for info in source.infolist()]
    out, rewritten = io.BytesIO(), 0
    with zipfile.ZipFile(out, "w") as target:
        for info, data in members:
            if info.filename in URL_MEMBERS:
                root = etree.fromstring(data)
                for element in root.iter(etree.Element):
                    for name, value in element.attrib.items():
                        if renamed(value) != value:
                            element.set(name, renamed(value))
                            rewritten += 1
                    if element.text and renamed(element.text.strip()) != element.text.strip():
                        element.text = renamed(element.text.strip())
                        rewritten += 1
                data = etree.tostring(root, xml_declaration=True, encoding="utf-8")
            target.writestr(info, data)
    assert rewritten, f"the archive names the app {old} in no runtime URL"
    return out.getvalue()


def test_formplayer_walks_the_release_alike_under_either_app_id(rule_documents, hq, core_runner, formplayer_runner):
    from proof.checks import served as judged
    from proof.formplayer import apps
    from proof.formplayer import hq as formplayer_hq
    from proof.formplayer import observe as formplayer_observe
    from proof.observe.record import Blobs

    document = rule_documents[DOCUMENT]
    blobs = Blobs()
    with published(document, core_runner) as app:
        with formplayer_hq.serve(app.unit, document, app.app_id, runner=formplayer_runner, label="either-id") as served:
            _, release = formplayer_observe.walked(served, formplayer_runner, blobs)
            script = formplayer_observe.script_of(release)
            archive = _naming(served.archive(), served.build_id, served.app_id)
            given = apps.build_id(served.app_id, archive)
            served.hq.archives[given] = archive
            try:
                _, working = formplayer_observe.walked(
                    served, formplayer_runner, blobs, script=script, app_id=given, archives=[archive]
                )
            finally:
                served.hq.archives.pop(given, None)

    runs = release["runs"]
    assert runs and any(step.get("submissions") for run in runs for step in run["steps"]), (
        "the walk sends no submission, so it shows nothing of the receiver's address"
    )
    paths = [sent["path"] for run in runs for step in run["steps"] for sent in step.get("submissions") or []]
    assert all(path.endswith(f"/receiver/{BUILD}/") for path in paths), paths

    def compared(rules):
        found = judged.formplayer_differences(
            release, working, check="proof4", document="-", artifact="formplayer", rules=rules
        )
        return sorted({(difference.path, difference.kind) for difference in found})

    assert compared(()) == [("/runs/*/steps/*/submissions/*/path", "changed")]
    assert compared((RULE,)) == []
