"""The rule ``media-path-of-a-shared-file`` is sound: no reader shows a picture named by a second path to one file
apart from the same picture named by its first path.

Contract: given a trace beside the file each media resource of its build
installs, the rule writes each image, sound and video a step names as the
first path, in code-unit order, of the paths its build installs the same file
at, and leaves a path no other path of its build shares a file with, a path
its build installs no file at, and a trace given no media files. Proof 3 names
each file by its bytes where the build carries them and by the address HQ
serves it from otherwise (``proof3.media_files``), and the comparison never
reports the media files themselves. Its readers are HQ's build, which installs
a media resource at each path the map names, Core, Formplayer, which hands the
path on, the Web Apps client, which asks HQ's media file view for the one
multimedia document, and CommCare Android
(``proof/android/predicates.py::test_a_picture_two_paths_name_draws_alike``).
The plausible failures: a reader that shows the second path as another
picture or none (an install refused, a file not held, a document served by its
name); the rule joining two paths that name two files, which would hide a
renamed or broken picture (``media-files-renamed``,
``broken-pictures-removed``); and the media files compared as part of the
trace.

``media-only``'s menu is published as Nova writes it, its icon at the content
path of its one picture, and with its icon at a second path the media map
names with the same multimedia document, as an app made in CommCare HQ holds
one file under two paths. HQ builds both whole and installs both paths in the
second, Core's sessions, which list that menu at the root, differ only at the
menu item's image, which the rule erases given each build's media suite and
leaves where the second path names another document. Formplayer hands the
path on, and the Web Apps client is answered the same bytes for either.
"""

from __future__ import annotations

import pytest
from lxml import etree

from proof.checks import proof3
from proof.checks.compare.trace import MEDIA_FILES, compare_traces, generated_labels
from proof.rules.conftest import (
    build_differences,
    client_differences,
    edited,
    formplayer_differences,
    published,
    runs_alike,
    served_readings,
    shown,
)
from proof.rules.media_path_of_a_shared_file import RULE, normalize

DOCUMENT = "media-only"
# A picture's two paths, the first before the second in code-unit order.
FIRST = "jr://file/commcare/image/module0_en.png"
SECOND = "jr://file/commcare/image/module0_form0_en.png"
# The path Nova's publish of ``DOCUMENT`` names the menu's icon at sorts before this one, so the rule reads this as
# that.
SHARED = "jr://file/commcare/image/module0_en.png"
IMAGE = ("trace", "/runs/*/trace/*/choices/*/image", "changed")
HQ_FILE = "https://www.commcarehq.org/hq/multimedia/file/CommCareImage/{}/{}"


def _trace(menu_image, form_image, files=None):
    """A trace of one run: a menu listing one item with ``menu_image``, and a form whose one question names
    ``form_image`` and whose choice names it too."""
    trace = {
        "runs": [
            {
                "trace": [
                    {"screen": "menu", "choices": [{"command": "m0", "text": "Visits", "image": menu_image}]},
                    {
                        "screen": "form",
                        "events": [
                            {
                                "event": "question",
                                "path": "/data/q[1]",
                                "image": form_image,
                                "audio": None,
                                "choices": [{"text": "Red", "image": form_image}],
                            }
                        ],
                    },
                ]
            }
        ]
    }
    if files is not None:
        trace[MEDIA_FILES] = dict(files)
    return trace


# The rule over traces alone ------------------------------------------------------------------------------------


def test_a_second_path_to_one_file_reads_as_the_first_and_nothing_else_is_changed():
    shared = {FIRST: "remote:x/m1", SECOND: "remote:x/m1", "jr://file/commcare/other.png": "remote:x/m2"}
    found = normalize(_trace(SECOND, SECOND, shared))
    menu, form = found["runs"][0]["trace"]
    assert menu["choices"][0]["image"] == FIRST
    assert form["events"][0]["image"] == FIRST and form["events"][0]["choices"][0]["image"] == FIRST
    # The first path stays, and so does a path no other path shares a file with.
    assert normalize(_trace(FIRST, FIRST, shared)) == _trace(FIRST, FIRST, shared)
    other = "jr://file/commcare/other.png"
    assert normalize(_trace(other, None, shared)) == _trace(other, None, shared)
    # Two paths to two files are two pictures, a path the build installs no file at is left, and a trace given no
    # media files is left as it is.
    apart = {FIRST: "remote:x/m1", SECOND: "remote:x/m2"}
    assert normalize(_trace(SECOND, SECOND, apart)) == _trace(SECOND, SECOND, apart)
    assert normalize(_trace(SECOND, SECOND, {FIRST: "remote:x/m1"})) == _trace(SECOND, SECOND, {FIRST: "remote:x/m1"})
    assert normalize(_trace(SECOND, SECOND)) == _trace(SECOND, SECOND)


def test_the_comparison_erases_only_a_path_to_a_shared_file_and_never_reports_the_media_files():
    def compared(before, after, rules):
        return shown(compare_traces(before, after, check="proof3", document="d", rules=rules))

    shared = {FIRST: "remote:x/m1", SECOND: "remote:x/m1"}
    alone = {FIRST: "remote:x/m1"}
    two_paths, one_path = _trace(SECOND, None, shared), _trace(FIRST, None, alone)
    assert compared(two_paths, one_path, ()) == [IMAGE]
    assert compared(two_paths, one_path, (RULE,)) == []
    apart = _trace(SECOND, None, {FIRST: "remote:x/m1", SECOND: "remote:x/m2"})
    assert compared(apart, one_path, (RULE,)) == [IMAGE]
    # Two builds' media files apart are no difference of the trace: proof 2 compares the media suites.
    assert compared(_trace(FIRST, None, shared), _trace(FIRST, None, alone), ()) == []


def _hq_suite(*resources):
    """HQ's media suite installing each ``(path, multimedia id)``, as ``SuiteGenerator.media_resources`` writes it."""
    media = "".join(
        f'<media path="../../{path[len("jr://file/") :].rsplit("/", 1)[0]}"><resource id="media-{index}" version="1">'
        f'<location authority="local">./{path[len("jr://file/") :]}</location>'
        f'<location authority="remote">{HQ_FILE.format(m_id, path.rsplit("/", 1)[1])}</location>'
        "</resource></media>"
        for index, (path, m_id) in enumerate(resources)
    )
    return f'<?xml version="1.0"?><suite version="1" descriptor="Media Suite File">{media}</suite>'.encode()


def test_proof_3_names_each_file_a_build_installs_by_its_bytes_or_the_document_hq_serves_it_from():
    # HQ's build carries no file: two paths whose addresses name one multimedia document are one file.
    third = "jr://file/commcare/image/other.png"
    files = proof3.media_files({"media_suite.xml": _hq_suite((FIRST, "m1"), (SECOND, "m1"), (third, "m2"))})
    assert files[FIRST] == files[SECOND] == "remote:https://www.commcarehq.org/hq/multimedia/file/CommCareImage/m1"
    assert files[third] != files[FIRST]
    # Nova's local archive carries each file: two paths are one file where their bytes are.
    suite = (
        b'<?xml version="1.0"?><suite version="1"><media path="../../commcare"><resource id="a" version="1">'
        b'<location authority="local">./commcare/a.png</location></resource></media><media path="../../commcare">'
        b'<resource id="b" version="1"><location authority="local">./commcare/b.png</location></resource></media>'
        b"</suite>"
    )
    same = proof3.media_files({"media_suite.xml": suite, "commcare/a.png": b"one", "commcare/b.png": b"one"})
    other = proof3.media_files({"media_suite.xml": suite, "commcare/a.png": b"one", "commcare/b.png": b"two"})
    assert same["jr://file/commcare/a.png"] == same["jr://file/commcare/b.png"]
    assert other["jr://file/commcare/a.png"] != other["jr://file/commcare/b.png"]
    assert proof3.media_files({}) == {}
    shown_trace = proof3.comparable_trace({"runs": []}, proof3.RUNTIMES["B"], files={"media_suite.xml": suite})
    assert MEDIA_FILES in shown_trace and MEDIA_FILES not in proof3.comparable_trace({"runs": []}, proof3.RUNTIMES["B"])
    assert RULE.applies_to("trace") and not RULE.applies_to("suite.xml")


# The readers, run ---------------------------------------------------------------------------------------------


def _two_paths(doc):
    """The menu's icon at ``SHARED`` in every language, a path the media map names with the multimedia document its
    first path names, whose map entry HQ gives an id of its own (``HQMediaMapItem.gen_unique_id``)."""
    module = doc["modules"][0]
    (first,) = set(module["media_image"].values())
    assert first < SHARED, f"the icon's path {first} does not sort before {SHARED}"
    entry = {key: value for key, value in doc["multimedia_map"][first].items() if key != "unique_id"}
    doc["multimedia_map"][SHARED] = entry
    module["media_image"] = {language: SHARED for language in doc["langs"]}


def _naming_another(files):
    """``files`` with the media suite's resource at ``SHARED`` fetched from another multimedia document: the rule's
    condition made false."""
    root = etree.fromstring(files["media_suite.xml"])
    moved = 0
    for resource in root.iter("resource"):
        locations = {location.get("authority"): location for location in resource.findall("location")}
        local, remote = locations.get("local"), locations.get("remote")
        if (
            local is not None
            and remote is not None
            and (local.text or "").strip() == "./" + SHARED[len("jr://file/") :]
        ):
            remote.text = HQ_FILE.format("another-document", SHARED.rsplit("/", 1)[1])
            moved += 1
    assert moved == 1, f"the build's media suite installs {SHARED} {moved} times"
    return {**files, "media_suite.xml": etree.tostring(root, encoding="utf-8", xml_declaration=True)}


def _traces(first, second, files, rules):
    """The two runs' traces compared as proof 3 compares them, each beside its build's media files."""
    return compare_traces(
        proof3.comparable_trace(first.trace, proof3.RUNTIMES["B"], first.admission, files[0]),
        proof3.comparable_trace(second.trace, proof3.RUNTIMES["B"], second.admission, files[1]),
        check="proof4",
        document="-",
        rules=rules,
        labels=generated_labels(first.trace, second.trace),
    )


def test_hq_builds_a_picture_two_paths_name_and_core_runs_it_alike(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        one = app.spell(doc=edited(lambda doc: None))
        two = app.spell(doc=edited(_two_paths))
        first, second, alike = runs_alike(app, core_runner, one.build, two.build, reads="menu")

    for spelled in (one, two):
        assert spelled.build.files is not None and not spelled.build.raised, spelled.build.raised
    assert shown(build_differences(one.build, two.build)), "the two spellings built the same app"
    installed = proof3.media_files(two.build.files)
    shared = [path for path, identity in installed.items() if identity == installed.get(SHARED)]
    assert len(shared) == 2, f"HQ's build does not install {SHARED} with the menu icon's file: {installed}"
    assert shown(alike) == [IMAGE], shown(alike)
    files = (one.build.files, two.build.files)
    assert shown(_traces(first, second, files, ())) == [IMAGE]
    assert _traces(first, second, files, (RULE,)) == []
    planted = _traces(first, second, (one.build.files, _naming_another(two.build.files)), (RULE,))
    assert shown(planted) == [IMAGE], "the rule joined two paths that name two documents"


@pytest.mark.reader("webapps")  # beside Formplayer, which its fixture starts: it reads the client's screens too
def test_web_apps_shows_a_picture_two_paths_name_alike(rule_documents, hq, core_runner, formplayer_runner):
    from proof.hq import operations

    with published(rule_documents[DOCUMENT], core_runner) as app:
        readings = served_readings(app, formplayer_runner, {"one": None, "two": _two_paths})
        one, two = readings["one"], readings["two"]
        # Formplayer hands each path on as it stands.
        handed = shown(formplayer_differences(one, two))
        assert handed and all(path.endswith("/imageUri") for _, path, _ in handed), handed
        # The client asks HQ's media file view for the one multimedia document under each path's name, and HQ
        # answers both with the same file.
        addresses = [
            (difference.before, difference.after)
            for difference in client_differences(one, two)
            if isinstance(difference.before, str) and isinstance(difference.after, str)
        ]
        assert len(addresses) == len(client_differences(one, two)), client_differences(one, two)
        with app.unit.fork():
            credential = operations.seed_api_user(app.unit, "shared-file-reader")
            for before, after in addresses:
                assert before.rsplit("/", 1)[0] == after.rsplit("/", 1)[0], (before, after)
                read = [operations.media_file_read(app.unit, address, credential) for address in (before, after)]
                assert [answer.status for answer in read] == [200, 200], read
                assert read[0].data == read[1].data
