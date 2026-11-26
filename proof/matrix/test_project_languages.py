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

            def read(label, document, *, kind="read", **options):
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
                assert answer["kind"] == kind, json.dumps(answer.get("findings", answer), ensure_ascii=False)
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
    # The language editor does not rename navigation badge keys. Give the
    # badge the same wording in the control language that will remain active,
    # using the actual menu settings page in that language.
    _pages.set_languages(authoring, app_id, ("hin", "en", "fra"))
    _pages.save_module_attributes(
        authoring, app_id, 1, [("custom_icon_type", "text"), ("custom_icon_text_body", "New")], "badge control"
    )
    _pages.set_languages(authoring, app_id, ("en", "fra", "hin"))
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


def test_hq_language_rename_strands_only_the_badge_with_no_remaining_language(adoption):
    import commcare_translations
    from corehq.apps.app_manager.app_strings import SelectKnownAppStrings
    from corehq.apps.app_manager.id_strings import module_custom_icon_locale
    from corehq.apps.app_manager.xform import XForm
    from lxml import etree

    from proof.hq import operations
    from proof.native.hq_support import hand_assembled_suite, known_app_strings

    authoring, app_id, original, read = adoption

    def badge_keys():
        app = operations.held_app(authoring.state, app_id)
        icon = app.get_module(1).custom_icon
        locale_id = module_custom_icon_locale(app.get_module(1), icon.form)
        default = SelectKnownAppStrings(lambda *_args, **_kwargs: {}).create_default_app_strings(app)
        catalogs = {
            "default": commcare_translations.loads(default),
            **{lang: commcare_translations.loads(known_app_strings(app, lang)) for lang in app.langs},
        }
        suite = etree.fromstring(hand_assembled_suite(app))
        assert suite.xpath("//locale[@id=$locale]", locale=locale_id), locale_id
        return app, dict(icon.text), {language: words.get(locale_id) for language, words in catalogs.items()}

    _, stored, before = badge_keys()
    assert stored == {"en": "New"}
    assert before == {"default": "New", "en": "New", "fra": "New", "hin": "New"}
    _pages.set_languages(authoring, app_id, ("eng", "fra", "hin"), renames={"en": "eng"})
    app, stored, after = badge_keys()
    assert stored == {"en": "New"}
    assert after == dict.fromkeys(["default", "eng", "fra", "hin"])

    # HQ does rename an ordinary form label in the same save.
    form = app.get_module(0).get_form(0)
    values = XForm(form.source, domain=authoring.state.domain).translations()
    assert values["eng"].findtext("{f}text[@id='visitor-label']/{f}value") == "Visitor name"
    assert "en" not in values

    answer = read("badge-stranded-by-language-rename", original, kind="account")
    assert [finding["code"] for finding in answer["findings"]] == [
        "menus-and-case-lists/badge-missing-localized-text"
    ], answer["findings"]
    assert answer["findings"][0]["place"] == {"kind": "menu", "menu": 1, "name": "Village notes"}

    _pages.save_module_attributes(
        authoring, app_id, 1, [("custom_icon_type", "text"), ("custom_icon_text_body", "New")], "repair badge language"
    )
    _, repaired, recovered = badge_keys()
    assert repaired == {"en": "New", "eng": "New"}
    assert recovered == dict.fromkeys(["default", "eng", "fra", "hin"], "New")
    assert read("badge-restored-in-active-language", original)["kind"] == "read"


def test_native_ui_translation_keeps_one_forms_button_in_each_worker_language(adoption):
    import commcare_translations
    from proof.hq import operations
    from proof.native.hq_support import known_app_strings

    authoring, app_id, original, read = adoption
    key = "forms.m0f0.submit_label"
    sibling = "forms.m1f0.submit_label"
    _pages.save_ui_translations(authoring, app_id, {"en": {key: "Finish visit"}, "fra": {key: "Terminer la visite"}})
    review = read("form-button-wording", original, expected=original["doc"], reviewChanges=True)["review"]
    assert review["kind"] == "changes", review
    application = review["application"]
    assert application["translations"]["en"][key] == "Finish visit"
    assert application["translations"]["fra"][key] == "Terminer la visite"
    rebuilt_id = operations.save_authored_app(authoring.state, application, [])
    for app in (operations.held_app(authoring.state, app_id), operations.held_app(authoring.state, rebuilt_id)):
        for language, expected in (("en", "Finish visit"), ("fra", "Terminer la visite"), ("hin", "Submit")):
            strings = commcare_translations.loads(known_app_strings(app, language))
            assert (strings[key], strings[sibling]) == (expected, "Submit")
