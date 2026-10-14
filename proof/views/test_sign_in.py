"""HQ's own sign-in form, as every person the lane signs in signs in (``proof/formplayer/hq.py::sign_in``).

Contract: a person is signed in by HQ's own sign-in view, never by a session
the harness makes beside it. A mobile worker posts their project space's
sign-in page (``hqwebapp/views.py::domain_login``) with the name they were
given, a web user HQ's own (``login``) with their email address, and HQ's
form checks the password before the view signs the person in and sets the
session the browser then holds. The plausible failures: a sign-in that
signs anyone in whatever they type (a session made without the form, or a
form whose fields HQ reads under other names, so it never checks the
password), and one that signs no one in (a session cookie that names no
user, or a field HQ's form does not take, which would leave every later
request of the lane signed out).
"""

from __future__ import annotations

import hashlib

import pytest

DOCUMENT = "media-only"
PASSWORD = "proof-sign-in-password"


def test_a_person_signs_in_through_hqs_own_form_with_their_password_and_not_with_another(
    hq, core_runner, view_documents, published
):
    from corehq.apps.users.models import CommCareUser, WebUser
    from django.contrib.auth import SESSION_KEY
    from django.contrib.sessions.backends.cache import SessionStore

    from proof.formplayer import hq as formplayer_hq
    from proof.hq import redis as hq_redis

    document = view_documents[DOCUMENT]
    with published(document, "minimum", core_runner) as (unit, _app_id, _):
        with hq_redis.shared(None), unit.committing():
            with unit.operation("people", hashlib.sha256(b"sign-in-people").digest()):
                formplayer_hq.default_roles(unit)
                worker = CommCareUser.create(
                    unit.domain,
                    f"proof-signer@{unit.domain}.commcarehq.org",
                    PASSWORD,
                    created_by=None,
                    created_via=None,
                )
                admin = WebUser.create(unit.domain, "proof-signer@example.com", PASSWORD, None, None, is_admin=True)
            for kind, person in (("worker", worker), ("web user", admin)):
                signed_in = formplayer_hq.sign_in(unit, person, PASSWORD, f"right-{kind}")
                # The session HQ set names the person HQ signed in, in HQ's own session store.
                assert SessionStore(session_key=signed_in.session).get(SESSION_KEY) == str(
                    person.get_django_user().pk
                ), kind
                assert signed_in.csrf, kind
                with pytest.raises(formplayer_hq.SignInRefused):
                    formplayer_hq.sign_in(unit, person, "another-password", f"wrong-{kind}")
