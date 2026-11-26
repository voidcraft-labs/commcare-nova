"""The released Web App accepts a normal upload and sends the original image bytes."""

from lxml import etree

from proof.formplayer.walk import CAPTURES_DIR
from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session


def test_worker_attaches_an_unchanged_photo_to_a_face_question(hq, core_runner, formplayer_runner, editor_driver,
                                                              webapps_documents, evidence):
    name = "proof-image.jpg"
    content = (CAPTURES_DIR / name).read_bytes()
    with webapps_hq.project(webapps_documents["targeted-face-photo"]) as project:
        with project.released(formplayer_runner) as release:
            session = Session(release, editor_driver)
            run = session.run([*steps.open_app(release.doc["name"]), *steps.choose("Visits"), *steps.choose("Record visit"),
                               *steps.answer_media("0", "image", name, content, "image/jpeg"), *steps.submit_and_land()])
            submission, = session.hq.submissions
    assert not run.page_errors, run.page_errors
    submitted = etree.fromstring(submission.instance).findtext("{*}portrait")
    assert submitted and dict(submission.files)[submitted] == content, (submitted, submission.files)
    evidence("face-upload", {"submitted": submitted, "size": len(content), "instance": submission.instance.decode()})
