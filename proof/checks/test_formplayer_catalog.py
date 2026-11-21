"""Two Formplayer strings are device wording unless a release or the app's own language table supplies them."""

from copy import deepcopy
from dataclasses import replace

import pytest

from proof.checks import formplayer_catalog as catalog
from proof.checks.differences import Difference

REPEAT = "repeat.dialog.add.new"
CLEAR = "upload.clear.title"


def inputs(key, value):
    def walk(values):
        return {
            "locale": "en",
            "runs": [
                {
                    "steps": [
                        {
                            "response": {
                                "instanceXml": {"output": '<data xmlns="urn:visit"/>'},
                                "selections": ["0"],
                                "translations": values,
                            }
                        }
                    ]
                }
            ],
        }

    # These are built archive files. The source's older French table remains stored after leaving the app.
    files = {"suite.xml": b'<suite><entry><form>urn:visit</form><command id="m0-f0"/></entry></suite>'}
    tables = {"default/app_strings.txt": f"{key}={value}\n".encode(), "en/app_strings.txt": f"{key}={value}\n".encode()}
    args = {
        "advisory": catalog.ADVISORY,
        "source": {
            "langs": ["en"],
            "translation_strategy": "select-known",
            "translations": {"fra": {key: "Custom"}},
            "build_spec": {"version": "2.57.0"},
        },
        "hq_files": {**files, **tables},
        "local_files": {**files, **dict.fromkeys(tables, b"")},
        "baseline": walk({key: value}),
        "local": walk({}),
    }
    args["target"] = deepcopy(args["source"])
    return args


def row(key, value):
    return Difference(
        "proof3",
        "adopted",
        "formplayer@local.ccz",
        "/runs/*/steps/*/response/translations/*",
        f"/runs/0/steps/0/response/translations/{key}",
        "removed",
        value,
        None,
    )


@pytest.mark.parametrize(("key", "value"), [(REPEAT, "Add a new ${0}?"), (CLEAR, "Clear")])
def test_local_catalog_fallback_needs_the_real_disclosure_selected_key_archive_and_native_return_value(key, value):
    d, witnessed = row(key, value), inputs(key, value)
    assert catalog.unstated([d], **witnessed) == []
    # An empty string selects a key but passes no text through SelectKnownAppStrings' non_empty_only overlay.
    witnessed["source"]["translations"] = {"en": {key: ""}}
    assert catalog.unstated([d], **witnessed) == []
    for args in [
        {"advisory": None},
        {"target": {**witnessed["target"], "translations": {"fra": {"other": value}}}},
        {"release_differs": {"differing": ["en/app_strings.txt"]}},
        {"source": {**witnessed["source"], "translations": {"fra": {"unrelated": value}}}},
        {"source": {**witnessed["source"], "translations": {"en": {key: " "}}}},
        {"source": {**witnessed["source"], "translations": {"en": {key: value}}}},
        {"hq_files": {**witnessed["hq_files"], "en/app_strings.txt": b""}},
        {"hq_files": {**witnessed["hq_files"], "default/app_strings.txt": b""}},
        {"local_files": {**witnessed["local_files"], "en/app_strings.txt": f"{key}=Local".encode()}},
        {"local_files": {**witnessed["local_files"], "other/app_strings.txt": f"{key}=Local".encode()}},
        {"local_files": {**witnessed["local_files"], "suite.xml": b"<suite/>"}},
        {"local": {**witnessed["local"], "locale": "fra"}},
    ]:
        assert catalog.unstated([d], **(witnessed | args)) == [d]
    for path, bad in [
        ("selections", ["5"]),
        ("instanceXml", {"output": '<data xmlns="urn:different"/>'}),
        ("translations", {key: "Local"}),
    ]:
        altered = deepcopy(witnessed)
        altered["local"]["runs"][0]["steps"][0]["response"][path] = bad
        assert catalog.unstated([d], **altered) == [d]
    wrong_text = "Same on wire but not the stock value"
    altered = inputs(key, wrong_text)
    assert catalog.unstated([row(key, wrong_text)], **altered) == [row(key, wrong_text)]
    for unrelated in [
        replace(d, artifact="formplayer@B"),
        replace(d, kind="changed", after="Replacement"),
        row("forms.m0f0.submit_label", value),
    ]:
        assert catalog.unstated([unrelated], **witnessed) == [unrelated]


def test_a_changed_worker_locale_reads_the_default_catalog_only_where_its_own_language_has_none():
    value = "Add a new ${0}?"
    d, args = row(REPEAT, value), inputs(REPEAT, value)
    args["source"]["langs"] = ["fra", "en"]
    args["source"]["translations"] = {"sw": {REPEAT: "Old text"}}
    args["target"] = deepcopy(args["source"])
    args["hq_files"]["fra/app_strings.txt"] = args["local_files"]["fra/app_strings.txt"] = b""
    for trace in (args["baseline"], args["local"]):
        trace["runs"][0]["steps"][0]["request"] = {"locale": "fra"}
    assert catalog.unstated([d], **args) == []
    # A removed French override, including a whitespace-only value, cannot be lent the English default.
    args["source"]["translations"]["fra"] = {REPEAT: "French override"}
    assert catalog.unstated([d], **args) == [d]
