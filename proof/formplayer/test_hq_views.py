"""Scratch: Formplayer walked over a build with HQ's own views answering it."""

from __future__ import annotations

import pytest

from proof.formplayer import apps
from proof.formplayer import hq as formplayer_hq
from proof.formplayer.walk import Walk


SCRATCH = (
    "case-operation-query",
    "search-browse",
    "case-list-browse",
    "targeted-search-hq-compile",
    "targeted-sync-on-form-entry",
    "targeted-form-link-hidden-target",
    "lookup-app",
    "case-worker-survey",
    "localization-bilingual",
    "targeted-custom-tile",
    "case-extension-registration",
    "media-only",
    "connect-deliver-default",
    "targeted-list-first-web-apps",
)


@pytest.mark.parametrize("document_id", SCRATCH)
def test_formplayer_walks_a_build_hqs_own_views_answer(hq, core_runner, formplayer_runner, evidence, document_id):
    from proof.checks import corpus

    document = corpus.load(corpus.corpus_root()).document(document_id)
    with apps.published(document, core_runner) as published:
        with formplayer_hq.serve(published.unit, document, published.app_id, runner=formplayer_runner) as served:
            walk = Walk(
                formplayer_runner, served.hq, domain=served.domain, app_id=served.build_id, scope=served.run
            )
            trace = walk.run()
            exchanges = [vars(asked) for asked in served.hq.exchanges]
    evidence("trace", trace)
    evidence("exchanges", exchanges)
    assert served.hq.failures() == [], [(a.url_name, a.raised, a.error) for a in served.hq.failures()]
    assert [run["end"] for run in trace["runs"]] and all(run["end"] != "refused" for run in trace["runs"]), [
        run["end"] for run in trace["runs"]
    ]
