"""App Preview installs the unbuilt app from HQ's own download, and a verdict HQ cached before Nova's publish
reaches it.

HQ keeps each form's last validation verdict for 7 days under the app's id and
the form's (``models/forms.py::FormBase.validation_cache``), and an import
clears nothing, so a form that failed its check in HQ before Nova's publish
replaced it keeps reading as failing there (the 7-day App Preview
statement; ``proof/hq/test_publish.py`` holds HQ's side of it).
App Preview hands Formplayer the app's own id, and Formplayer installs it
from HQ's download of the unbuilt app (``util/SessionUtils.java::
resolveInstallReference`` → ``getReferenceToLatest``: ``download_ccz`` with
``latest=save``). Here that request is answered by HQ's own
``views/cli.py::direct_ccz`` over the unit's state, in place of a stored
archive (``proof.formplayer.hq.HqViews``).

Contract: over ``navigation-base``, with one form saved broken through the
path the form builder's save writes and checked, then Nova's publish over it,
Formplayer answers App Preview with HQ's "Cannot make new version" and shows
no menu; once that form is opened and saved in HQ's form builder (Vellum)
with nothing changed, Formplayer installs the app and shows its first menu.
The plausible failures: a preview served from a released build (which a new
version validates afresh, so the stale verdict would never show), and a
download answered by the harness rather than by HQ's view.
"""

from __future__ import annotations

from proof.formplayer import apps
from proof.formplayer.hq import DOWNLOAD
from proof.formplayer.webapps import FormplayerRefused

DOCUMENT = "navigation-base"


def _preview(formplayer_runner, served, app_id):
    """App Preview's first navigation of the unbuilt app ``app_id`` (the request names the app's own id, as App
    Preview's does, and Formplayer installs whatever id it is given from the same download): Formplayer's
    answer, or the text of its refusal; and HQ's answers to Formplayer's downloads."""
    with served.run("preview"):
        web = apps.web(formplayer_runner, served, app_id=app_id)
        first = len(served.hq.exchanges)
        try:
            answer = web.navigate([], preview=True)
            text = None
        except FormplayerRefused as refused:
            answer = None
            text = refused.exchange.response.body.decode("utf-8", "replace")
        downloads = [asked.status for asked in served.hq.exchanges[first:] if asked.url_name == DOWNLOAD]
    return answer, text, downloads


def _error_text(answer, text):
    """What the client shows of Formplayer's error: its refusal's body, or the error its answer carries."""
    if text is not None:
        return text
    return str((answer or {}).get("exception") or (answer or {}).get("errors") or "")


def test_app_preview_shows_a_verdict_cached_before_novas_publish_until_the_form_builder_saves(
    hq, core_runner, formplayer_runner, editor_driver, formplayer_documents, evidence
):
    from proof.editors import vellum
    from proof.hq import operations
    from proof.hq.test_publish import _refused_by_core, _validation_errors

    with apps.published(formplayer_documents[DOCUMENT], core_runner) as published:
        unit, app_id = published.unit, published.app_id
        with unit.fork():
            app = operations.held_app(unit, app_id)
            form_id = app.get_module(0).get_form(0).unique_id
            app.get_form(form_id).source = _refused_by_core(app.get_form(form_id).source)
            app.save()
            assert _validation_errors(operations.held_app(unit, app_id))
            update = operations.with_app_id(published.export.content.upload(), app_id)
            assert operations.apply_upload(unit, update).status == 200
            with apps.served(published, formplayer_runner, label="published-over") as served:
                stale = _preview(formplayer_runner, served, app_id)
            run = vellum.open_and_save(editor_driver, unit, app_id, form_id)
            assert run.loaded and run.saved, (run.load_error, run.save_refusal)
            with apps.served(published, formplayer_runner, label="form-builder-saved") as served:
                cleared = _preview(formplayer_runner, served, app_id)

    evidence(
        "preview",
        {
            "publishedOver": {"error": _error_text(stale[0], stale[1]), "downloads": stale[2]},
            "formBuilderSaved": {"commands": len((cleared[0] or {}).get("commands") or []), "downloads": cleared[2]},
        },
    )
    # HQ's own download answered Formplayer's install request in both states: refused, then the archive.
    assert 400 in stale[2] and cleared[2] and set(cleared[2]) == {200}, (stale[2], cleared[2])
    assert "Cannot make new version" in _error_text(stale[0], stale[1])
    assert not (stale[0] or {}).get("commands")
    assert cleared[1] is None and (cleared[0] or {}).get("commands"), cleared
