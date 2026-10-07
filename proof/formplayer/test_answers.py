"""HQ's answers to Formplayer: each of its six requests answered, anything else refused by name.

Contract (``proof.formplayer.answers``): the answers serve the session's
user (only for a body signed with the shared key, as HQ's ``formplayer_auth``
requires), the app's archive by its id, the restore, a submission's instance,
a search's parameters and a claim, each kept as Formplayer sent it; any other
request raises, naming the route. Plausible failures: an unanswered route
answered empty (Formplayer would show an empty list and the observation would
read it as the app's), a session answered for an unsigned request (the
harness would run without Formplayer's own signing), or a submission whose
instance is lost among its parts.
"""

from __future__ import annotations

import json

import pytest

from proof.formplayer.answers import HqAnswers, digest
from proof.formplayer.client import AUTH_KEY, FormplayerRunnerError, HqAnswer, HqRequest


def _answers(**more):
    return HqAnswers(domain="space", username="worker", archives={"app-1": b"zip"}, restore=b"<restore/>", **more)


def _request(method, path, body=b"", query="", headers=()):
    return HqRequest(method=method, path=path, query=query, headers=tuple(headers), body=body)


def test_the_session_is_answered_for_a_signed_request_and_refused_for_another_key():
    answers = _answers(toggles=("B_FLAG", "A_FLAG"))
    body = json.dumps({"sessionId": "key", "domain": "space"}).encode()
    signed = _request("POST", "/hq/admin/session_details/", body, headers=[("X-MAC-DIGEST", digest(AUTH_KEY, body))])
    answered = answers(signed)
    assert answered.status == 200
    details = json.loads(answered.body)
    assert details["username"] == "worker" and details["domains"] == ["space"] and details["authToken"] == "key"
    assert details["enabled_toggles"] == ["A_FLAG", "B_FLAG"] and details["permissions"] == ["edit_data"]

    forged = _request("POST", "/hq/admin/session_details/", body, headers=[("X-MAC-DIGEST", digest("other", body))])
    with pytest.raises(FormplayerRunnerError, match="not signed with the key"):
        answers(forged)


def test_a_session_of_another_project_space_is_not_found():
    answers = _answers()
    body = json.dumps({"sessionId": "key", "domain": "elsewhere"}).encode()
    request = _request("POST", "/hq/admin/session_details/", body, headers=[("X-MAC-DIGEST", digest(AUTH_KEY, body))])
    assert answers(request).status == 404


def test_the_archive_and_the_restore_are_served_and_an_unknown_app_is_not_found():
    answers = _answers()
    served = answers(_request("GET", "/a/space/apps/api/download_ccz/", query="app_id=app-1&latest=save"))
    assert (served.status, served.body) == (200, b"zip")
    assert answers(_request("GET", "/a/space/apps/api/download_ccz/", query="app_id=other")).status == 404
    restored = answers(_request("GET", "/a/space/phone/restore/", query="version=2.0&since=token"))
    assert (restored.status, restored.body) == (200, b"<restore/>")
    assert answers.asked == [("archive", "app-1"), ("archive", "other"), ("restore", "since")]


def test_a_submission_keeps_its_instance_and_its_files_and_gets_what_submit_answers():
    received = []

    def submit(submission):
        received.append(submission)
        return HqAnswer(201, b"<ok/>")

    answers = _answers(submit=submit)
    boundary = "proof-boundary"
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="photo.jpg"; filename="photo.jpg"\r\n'
        "Content-Type: image/jpeg\r\n\r\nJPEG\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="xml_submission_file"; filename="xml_submission_file.xml"\r\n'
        "Content-Type: text/xml\r\n\r\n<data><name>Ana</name></data>\r\n"
        f"--{boundary}--\r\n"
    ).encode()
    request = _request(
        "POST", "/a/space/receiver/app-1/", body, headers=[("Content-Type", f"multipart/form-data; boundary={boundary}")]
    )
    assert answers(request) == HqAnswer(201, b"<ok/>")
    (submission,) = received
    assert submission.instance == b"<data><name>Ana</name></data>"
    assert submission.files == (("photo.jpg", b"JPEG"),)
    assert answers.submissions == [submission]


def test_a_search_is_handed_its_parameters_and_one_with_no_search_given_raises():
    seen = []

    def search(asked):
        seen.append(asked)
        return HqAnswer(200, b"<results/>")

    answers = _answers(search=search)
    body = b"case_type=patient&_xpath_query=name+%3D+%27it%27s%27&_xpath_query=match-all()&blank="
    assert answers(_request("POST", "/a/space/phone/search/app-1/", body)).body == b"<results/>"
    (asked,) = seen
    assert asked.values("_xpath_query") == ("name = 'it's'", "match-all()")
    assert asked.values("case_type") == ("patient",) and asked.values("blank") == ("",)
    with pytest.raises(FormplayerRunnerError, match="no `search`"):
        _answers()(_request("POST", "/a/space/phone/search/app-1/", body))


def test_a_claim_is_kept_and_answered_as_a_case_the_worker_already_holds():
    answers = _answers()
    assert answers(_request("POST", "/a/space/phone/claim-case/", b"case_id=abc")).status == 204
    assert answers.claims[0].values("case_id") == ("abc",)


def test_a_route_the_answers_do_not_hold_raises_naming_it_and_so_does_another_project_space():
    answers = _answers()
    with pytest.raises(FormplayerRunnerError, match="GET /a/space/phone/keys/"):
        answers(_request("GET", "/a/space/phone/keys/"))
    with pytest.raises(FormplayerRunnerError, match="/a/elsewhere/phone/restore/"):
        answers(_request("GET", "/a/elsewhere/phone/restore/"))
    assert answers.asked == []
