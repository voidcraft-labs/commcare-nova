"""The release's id and the working app's id in a runtime URL, read as one.

A runtime URL is an address a running app sends HQ a request at: the
suite's search and case fixture URLs, the profile's ``PostURL`` and
``ota-restore-url``, and each request a reader sends to them. A device on A
installs HQ's release, a copy of the app with an id of its own, and its
suite and profile name that copy's id; Nova's local archive names the
working app's id, which is what HQ's own ``create_all_files()`` of the
working app writes. HQ answers both: its receiver takes a form under either
id (``corehq/apps/receiverwrapper/util.py::get_app_and_build_ids`` reads a
build's ``copy_of`` as its app), and its search and restore views read the
app the id names (``corehq/apps/case_search/utils.py::get_app_context``).
The records write the two ids ``@build`` and ``@app``
(``proof/formplayer/observe.py::marked``, ``proof/android/observe.py``).

The condition: a release is a copy of the working app as it stood, so the
two ids answer alike only while the app holds no change since its release.
HQ answers a search under the release's id from the release's search
configuration and under the working app's from the app as it is now, so
they differ once the app is saved again without a release. The lane
releases every state before it serves it, so the condition holds for every
request the lane compares.

It covers the address alone. A form received under the working app's id
carries no ``build_id`` (``get_app_and_build_ids``), and HQ's answer to
Formplayer's submit then names the saved form by its data node's ``name``
(``corehq/form_processor/submission_post.py::SubmissionPost._get_form_name``):
that answer is another path of the record, which the rule does not read.

The rule reads one artifact, ``request-url``, the address of a request a
reader sent HQ, as a string as its record holds it: the judges hand it the
``path`` of each submission in Formplayer's trace (``proof/checks/served.py``)
and each address a device's answer holds (``proof/checks/android.py``). It
writes ``@build`` as ``@app`` where the address is a project space's receiver
(``/a/<domain>/receiver/<id>/`` and ``receiver/secure/<id>/``,
``corehq/apps/receiverwrapper/urls.py``), search (``phone/search/<id>/``),
restore (``phone/restore/<id>/``) or case fixture (``phone/case_fixture/<id>/``,
``corehq/apps/ota/urls.py``), each under the project space's own prefix
(``urls.py::domain_specific``), and leaves every other address, and every
other id, as it is.
"""

from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit

from proof.rules import SpellingRule

# What the records write for the release's id and for the working app's (``proof.formplayer.observe``).
BUILD = "@build"
APP = "@app"
# The runtime views that take an app's id as the path's last segment, by the segments after ``/a/<domain>/``.
RUNTIME_VIEWS = frozenset(
    {
        ("receiver",),
        ("receiver", "secure"),
        ("phone", "search"),
        ("phone", "restore"),
        ("phone", "case_fixture"),
    }
)


def _runtime_id_at(segments):
    """The place of the app's id in a path's segments (its leading empty segment kept) where the path is one of
    ``RUNTIME_VIEWS`` under a project space, ending in ``/``; None otherwise."""
    if len(segments) < 5 or segments[0] != "" or segments[1] != "a" or not segments[2] or segments[-1] != "":
        return None
    if tuple(segments[3:-2]) not in RUNTIME_VIEWS:
        return None
    return len(segments) - 2


def normalize(address):
    if not isinstance(address, str):
        return address
    parts = urlsplit(address)
    segments = parts.path.split("/")
    at = _runtime_id_at(segments)
    if at is None or segments[at] != BUILD:
        return address
    segments[at] = APP
    return urlunsplit(parts._replace(path="/".join(segments)))


RULE = SpellingRule(
    "runtime-url-app-id",
    "request-url",
    "The release's id and the working app's id in a runtime URL (a receiver, search, restore or case fixture"
    " address), which HQ answers alike while the release is the app as it stands; the lane releases every state"
    " before it serves it.",
    normalize,
    readers=(
        ("formplayer", "test_formplayer_walks_the_release_alike_under_either_app_id"),
        ("android", "test_a_device_reads_an_archive_alike_under_either_app_id"),
    ),
)
