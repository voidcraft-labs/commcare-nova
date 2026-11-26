"""What a worker sees in Web Apps of a label whose value holds formatting.

``targeted-styled-value``: the survey menu "Styles" holds the form "Styled
label", whose one question is labelled ``Styled `` then the value of a Hidden
Value calculated as ``'**x**'`` (``proof/targeted/documents/styledValue.ts``).
Formplayer hands the client each question's ``caption_markdown``, Core's
markdown form of the label with every output's text spliced in as written
(``FormEntryCaption.getSpecialFormQuestionText``, ``FormDef.fillTemplateString``),
and the client renders it as markdown into the question's caption
(``form_entry/form_ui.js``, ``caption_markdown``'s ``markdown.render``;
``partials/form_entry/question.html``, ``.caption-text``).

Contract, on HQ's release of Nova's export: Formplayer's answer to the client
opening the form holds the question's ``caption_markdown`` as
``Styled **x**``, and the caption the client draws reads ``Styled x``, the
value in bold, with no asterisk. That is the order Preview plays
(``lib/preview/engine/labelRefs.ts``): the value substituted, then the label
formatted. Plausible failures: a runtime that formats a label before it
splices its values in, so a worker reads the asterisks, and a label written
with no markdown form, so the client draws ``caption`` as typed.
"""

from __future__ import annotations

import pytest

from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session

DOCUMENT = "targeted-styled-value"
APP = "Styled values"
# The label as Core splices its value in (``styledValue.ts::STYLED_LABEL_LEAD`` and ``STYLED_VALUE``), and as the
# client draws it once rendered.
SPLICED = "Styled **x**"
DRAWN = "Styled x"
# The page read for each question's caption: its text, and the text of each bold element the client rendered in it.
CAPTIONS = {
    "eval": """() => [...document.querySelectorAll("#webforms .q")].map((question) => {
	const caption = question.querySelector(".caption-text .webapp-markdown-output");
	return {
		text: (caption?.textContent ?? "").replace(/\\s+/g, " ").trim(),
		bold: caption ? [...caption.querySelectorAll("strong, b")].map((element) => element.textContent) : [],
	};
})"""
}


def _questions(exchanges):
    """Every question of every form tree Formplayer answered the client with, in order."""
    found = []
    for exchange in exchanges:
        try:
            answer = exchange.json()
        except ValueError:
            continue
        tree = answer.get("tree") if isinstance(answer, dict) else None
        if isinstance(tree, list):
            found.extend(item for item in tree if isinstance(item, dict))
    return found


@pytest.mark.reader("webapps")
def test_web_apps_formats_a_label_after_its_value_is_spliced_in(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    made = [
        *steps.open_app(APP),
        *steps.choose("Styles"),
        *steps.choose("Styled label"),
        steps.SCREEN,
        CAPTIONS,
    ]
    with webapps_hq.project(webapps_documents[DOCUMENT]) as project:
        with project.released(formplayer_runner) as release:
            session = Session(release, editor_driver)
            run = session.run(made)
            french = session.run(made, worker_language="fr", name="webapps-french")
    captions = run.value(-1)
    handed = [
        question.get("caption_markdown")
        for question in _questions(run.formplayer)
        if str(question.get("caption") or "").startswith("Styled")
    ]
    evidence("label-values", {"screen": run.screens, "captions": captions, "handed": handed})
    assert run.page_errors == [] and french.page_errors == []
    (translated,) = [caption for caption in french.value(-1) if caption["text"].startswith("Zone")]
    assert translated == {"text": "Zone nord, secteur nord", "bold": []}, translated
    assert any(question.get("caption") == "Zone nord, secteur nord" for question in _questions(french.formplayer))

    # Formplayer handed the client the label's markdown form with the value spliced in as written.
    assert handed and set(handed) == {SPLICED}, handed
    # The client rendered it: the value in bold, and no asterisk left.
    (caption,) = [caption for caption in captions if caption["text"].startswith("Styled")]
    assert caption == {"text": DRAWN, "bold": ["x"]}, caption
