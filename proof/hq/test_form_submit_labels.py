"""Per-language submit buttons as built by HQ, including the default used by a missing language."""

from proof.checks.compare.app_strings import parse_app_strings
from proof.rules.conftest import edited, published


def test_form_submit_labels_keep_present_blank_and_missing_languages(hq, documents):
    def configure(body):
        body["langs"] = ["en", "fra", "es"]
        body["modules"][0]["forms"][0]["submit_label"] = {"en": "Send referral", "fra": ""}

    with published(documents["case-list-inline"], None, configuration="maximum") as app:
        changed = app.spell(doc=edited(configure))
    assert changed.build.files is not None and not changed.build.raised, changed.build.raised
    assert changed.stored["modules"][0]["forms"][0]["submit_label"] == {"en": "Send referral", "fra": ""}
    for language, expected in [("en", "Send referral"), ("fra", None), ("es", "Submit"), ("default", "Send referral")]:
        contents = changed.build.files[f"{language}/app_strings.txt"]
        assert parse_app_strings(contents).get("forms.m0f0.submit_label") == expected
