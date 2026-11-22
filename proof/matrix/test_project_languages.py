"""A new default and then a different original wording on an already adopted application."""

import json

from proof.matrix.author import Authoring, READER
from proof.matrix.bases import _pages, languages
from proof.matrix.registry import HQ_APPS
from proof.matrix.retain import app_reads, run_bundle


def test_hq_language_order_and_changed_original_wording_on_an_existing_adoption(hq, documents):
    from corehq import privileges

    from proof.hq import operations
    from proof.hq import redis as hq_redis
    from proof.hq.check import hq_check
    from proof.hq.seams import also_granted, api_rate_limits

    base = languages.BASE
    original = documents[base.id].document
    names = ("/localization/defaultLanguage", "/localization/sourceLanguage", "/appName",
             "/localization/translations/eng/tu1:3:app4:name/value")
    holds = [{"key": "app", "pointer": pointer, "value": None} for pointer in names]

    def read(label):
        answers = app_reads(authoring, app_id, credential)
        request = {
            "id": label, "mode": "read-back", "holds": holds,
            "input": {
                "identity": "match", "claims": "counts", "appId": base.id, "document": original,
                "application": answers["application"].retained(),
                "source": answers["source"].retained(),
                "currentVersion": answers["currentVersion"].retained(),
            },
        }
        [answer] = run_bundle([request])
        assert answer["kind"] == "read", answer
        return tuple(hold["found"] for hold in answer["held"])

    with hq_check(base.configuration) as (state, _), hq_redis.shared(None), state.committing():
        with also_granted(privileges.API_ACCESS), api_rate_limits(state):
            authoring = Authoring(state, documents, base.id, operation=state.operation)
            with authoring.step("remake-language-adoption"):
                source = json.loads((HQ_APPS / base.id / "app.json").read_text(encoding="utf-8"))
                app_id = operations.save_authored_app(state, source, [])
                credential = operations.seed_api_user(state, READER)
            assert read("before") == ("eng", "eng", languages.NAME, None)
            _pages.set_languages(authoring, app_id, ("hin", "fra", "en"))
            assert read("new-default") == ("hin", "eng", languages.NAME, None)
            # The UI translations editor preserves the English app title. Renaming the app now distinguishes
            # the actual source from the new default with HQ's own two saves.
            _pages.save_ui_translations(authoring, app_id, {
                "en": {"app.display.name": languages.NAME, "homescreen.title": languages.NAME}
            })
            _pages.rename_app(authoring, app_id, "गाँव का दौरा")
            assert read("new-original") == ("hin", "hin", "गाँव का दौरा", languages.NAME)
