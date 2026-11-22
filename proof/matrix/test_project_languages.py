"""Real language editor saves on an already adopted application."""

import json

import pytest

from proof.matrix.author import Authoring, READER
from proof.matrix.bases import _pages
from proof.matrix.registry import BASES, HQ_APPS
from proof.matrix.retain import app_reads, run_bundle


@pytest.fixture
def adoption(hq, documents):
    from corehq import privileges

    from proof.hq import operations
    from proof.hq import redis as hq_redis
    from proof.hq.check import hq_check
    from proof.hq.seams import also_granted, api_rate_limits

    base = next(base for base in BASES if base.id == "hq-languages")
    with hq_check(base.configuration) as (state, _), hq_redis.shared(None), state.committing():
        with also_granted(privileges.API_ACCESS), api_rate_limits(state):
            authoring = Authoring(state, documents, base.id, operation=state.operation)
            with authoring.step("remake-language-adoption"):
                source = json.loads((HQ_APPS / base.id / "app.json").read_text(encoding="utf-8"))
                app_id = operations.save_authored_app(state, source, [])
                credential = operations.seed_api_user(state, READER)

            def read(label, document, **options):
                answers = app_reads(authoring, app_id, credential)
                [answer] = run_bundle([{
                    "id": label, "mode": "read-back",
                    "input": {
                        "identity": "match", "claims": "counts", "appId": base.id, "document": document,
                        "application": answers["application"].retained(),
                        "source": answers["source"].retained(),
                        "currentVersion": answers["currentVersion"].retained(),
                    },
                    **options,
                }])
                assert answer["kind"] == "read", answer
                return answer

            yield authoring, app_id, documents[base.id].document, read


def test_hq_language_order_and_changed_original_wording_on_an_existing_adoption(adoption):
    authoring, app_id, original, read = adoption
    names = ("/localization/defaultLanguage", "/localization/sourceLanguage", "/appName",
             "/localization/translations/eng/tu1:3:app4:name/value")
    holds = [{"key": "app", "pointer": pointer, "value": None} for pointer in names]

    def values(label):
        return tuple(hold["found"] for hold in read(label, original, holds=holds)["held"])

    assert values("before") == ("eng", "eng", "Village round", None)
    _pages.set_languages(authoring, app_id, ("hin", "fra", "en"))
    assert values("new-default") == ("hin", "eng", "Village round", None)
    _pages.save_ui_translations(authoring, app_id, {
        "en": {"app.display.name": "Village round", "homescreen.title": "Village round"}
    })
    _pages.rename_app(authoring, app_id, "गाँव का दौरा")
    assert values("new-original") == ("hin", "hin", "गाँव का दौरा", "Village round")


def test_hq_editor_renames_two_adopted_language_codes_without_reassigning_their_text(adoption):
    from corehq.apps.app_manager.xform import XForm

    authoring, app_id, original, read = adoption
    document = original
    for expected_codes, renames in [
        (["en", "fr", "hin"], {"fra": "fr"}),
        (["eng", "fra", "hin"], {"en": "eng", "fr": "fra"}),
    ]:
        _pages.set_languages(authoring, app_id, expected_codes, renames=renames)
        review = read("-".join(expected_codes), document, expected=document["doc"], reviewChanges=True)["review"]
        assert review["kind"] == "changes", review
        target = review["target"]
        assert target["localization"] == {
            **original["doc"]["localization"],
            "wireCodes": dict(zip(["eng", "fra", "hin"], expected_codes, strict=True)),
        }
        # HQ's own XForm reader opens what Nova emits from the reviewed target. Match the form it came
        # from by its adopted ID. Distinct labels bind the observable words to each renamed language.
        emitted = review["application"]
        assert emitted["langs"] == expected_codes
        form_id = emitted["modules"][0]["forms"][0]["unique_id"]
        xml = emitted["_attachments"][f"{form_id}.xml"]
        translations = XForm(xml, domain=authoring.state.domain).translations()
        assert {code: lang.findtext("{f}text[@id='visitor-label']/{f}value") for code, lang in translations.items()} == dict(
            zip(expected_codes, ["Visitor name", "Nom du visiteur", "आगंतुक का नाम"], strict=True)
        )
        document = {**document, "doc": target}
