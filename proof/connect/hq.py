"""HQ's side of the Connect proof: a submission as HQ's receiver reads it, and what HQ's Connect repeater forwards.

Connect never sees a form. It sees the JSON HQ's Connect repeater posts
(``corehq/motech/repeaters/models.py::ConnectFormRepeater``), which HQ's own
payload generator builds from the form HQ holds
(``repeater_generators.py::ConnectFormRepeaterPayloadGenerator.get_payload``):
the form through HQ's form API resource (``api/resources/v0_4.py::
XFormInstanceResource`` over ``api/util.py::form_to_es_form``), kept to its
domain, id, app id, build id, received time and metadata, with every block
in Connect's namespace put back at its path under ``form``. So the payload's
shape is HQ's, produced here by that code and never written by hand.

The form it reads is the one HQ's receiver makes of a submission, by the
receiver's own steps in the receiver's order
(``form_processor/submission_post.py::SubmissionPost.run``, up to its case
processing): the app and build the receiver's URL names
(``receiverwrapper/util.py::get_app_and_build_ids``), the submission parsed
and its datetimes adjusted (``parsers/form.py::process_xform_xml``), and the
request's properties and the meta scrub put on the form
(``SubmissionPost._post_process_form``). HQ's case processing and its save
are not run here (proof 3 holds HQ's case processing of every submission,
``proof.observe.sessions``): neither changes a field the payload reads.

``forwards`` is the repeater's own word on whether it forwards the form
(``FormRepeater.allowed_to_forward``).
"""

from __future__ import annotations

import json
from dataclasses import dataclass


@dataclass(frozen=True)
class Forwarded:
    """What HQ's Connect repeater makes of one submission."""

    app_id: str | None
    build_id: str | None
    forwards: bool
    payload: dict


def receiver_url(domain, receiver_id):
    """The receiver's path for a submission posted under ``receiver_id`` (an app's or a build's id), or with none."""
    from django.urls import reverse

    if receiver_id is None:
        return reverse("receiver_post", args=[domain])
    return reverse("receiver_post_with_app_id", args=[domain, receiver_id])


def forwarded(state, submission_xml: bytes, receiver_id: str | None) -> Forwarded:
    """HQ's Connect payload for ``submission_xml`` posted to the unit's project space under ``receiver_id``.

    ``receiver_id`` is the id in the URL the device posts to: the id HQ's
    build writes into its profile's ``PostURL``
    (``app_manager/models/applications.py::ApplicationBase.post_url``), or
    None for a post to the project space's receiver with no app named.
    """
    from corehq.apps.receiverwrapper.util import get_app_and_build_ids
    from corehq.form_processor.parsers.form import process_xform_xml
    from corehq.form_processor.submission_post import SubmissionPost
    from corehq.motech.repeaters.models import ConnectFormRepeater

    domain = state.domain
    app_id, build_id = get_app_and_build_ids(domain, receiver_id)
    post = SubmissionPost(
        instance=submission_xml,
        attachments={},
        domain=domain,
        app_id=app_id,
        build_id=build_id,
        path=receiver_url(domain, receiver_id),
    )
    form = process_xform_xml(domain, post.instance, post.attachments, post.auth_context.to_json()).submitted_form
    post._post_process_form(form)
    repeater = ConnectFormRepeater(domain=domain)
    payload = json.loads(repeater.generator.get_payload(None, form))
    return Forwarded(
        app_id=app_id, build_id=build_id, forwards=bool(repeater.allowed_to_forward(form)), payload=payload
    )
