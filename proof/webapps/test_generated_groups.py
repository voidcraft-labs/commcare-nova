"""What a worker sees in Web Apps of the groups Nova generates to hold a form's case blocks: nothing.

Nova writes every case operation's block inside a ``nova_operations`` group,
a conditional update or close and the guards of a conditional operation
inside a ``nova_condition_<operation>`` group whose relevance is the
condition, and a root create keyed by an answer inside a one-row repeat
(``lib/commcare/xform/caseOps.ts``). None of them holds a question, and a
block or a hidden value has no control. Formplayer hands the client each
group, the keyed repeat and its row as a sub-group of the form's tree; the
client draws a group with no question in it with ``d-none``
(``form_entry/sub_group.html``, ``Group.hasAnyNestedQuestions``), so the
browser lays out no box for it.

On HQ's release of Nova's export of ``case-operation-conditional``,
``case-operation-key``, ``case-operation-query``, ``case-operation-sequence``
and ``case-capture-multiple`` (two cases ticked, then Continue), Formplayer's
own walk of the build, every text answered ``yes``, is replayed in the
browser (``proof.webapps.observe.replay``), and the page is read as the form
opens (every condition false, since nothing is answered yet) and once every
question is answered (every condition true), before Submit.

Contract: at both reads, Formplayer's tree holds the question-less groups the
form's generated nodes make, the client holds at least as many groups with no
question in them, and the browser lays out none of those (no client
rectangle), while every group that holds a question is laid out; and the
form's visible text is its title, its questions' own text and Submit, with no
line from a group's header. The lane's answer table answers no text ``yes``,
so its replays never reach a condition true. Plausible failures: a generated
group the client draws a box or a header for (an empty card a worker scrolls
past, or a caption); a group the client draws once its condition turns true;
and a read that sees no group at all, which the tree's own groups rule out.
"""

from __future__ import annotations

import copy
from collections import Counter
from dataclasses import replace

import pytest

from proof.webapps import hq as webapps_hq
from proof.webapps import observe
from proof.webapps.session import Session

DOCUMENTS = (
    "case-operation-conditional",
    "case-operation-key",
    "case-operation-query",
    "case-operation-sequence",
    "case-capture-multiple",
)
# The page read for what a form lays out: each group the client drew (how many questions it holds, whether the
# browser lays it out, its caption), and the form's visible lines, its questions', its title's and its Submit's.
LAYOUT = {
    "eval": """() => {
	const form = document.querySelector("#webforms");
	if (!form || !form.children.length) return null;
	const laidOut = (element) =>
		element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
	const lines = (element) =>
		element
			? element.innerText.split("\\n").map((line) => line.replace(/\\s+/g, " ").trim()).filter(Boolean)
			: [];
	return {
		groups: [...form.querySelectorAll(".gr")].map((group) => ({
			questions: group.querySelectorAll(".q").length,
			laidOut: laidOut(group),
			caption: (group.querySelector(".caption")?.textContent ?? "").trim(),
		})),
		text: lines(form),
		questions: [...form.querySelectorAll(".q")].flatMap(lines),
		title: lines(form.querySelector(".form-container h1, h1.title")),
		submit: lines(form.querySelector("button.submit")),
	};
}"""
}


def _questionless(tree) -> int:
    """How many sub-groups of Formplayer's form tree hold no question, however deep."""

    def holds_question(node) -> bool:
        return node.get("type") == "question" or any(holds_question(child) for child in node.get("children") or ())

    count = 0
    for node in tree or ():
        if node.get("type") == "sub-group" and not holds_question(node):
            count += 1
        count += _questionless(node.get("children") or ())
    return count


def _form_step(run):
    return next(step for step in run["steps"] if "answers" in step)


@pytest.mark.parametrize("document_id", DOCUMENTS)
def test_web_apps_lays_out_no_box_for_a_generated_group_before_or_after_its_condition_turns_true(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence, document_id
):
    from proof.formplayer.walk import Walk, load_answer_table
    from proof.observe import walks

    table = copy.deepcopy(load_answer_table())
    table["dataTypes"]["text"] = ["yes"]
    with webapps_hq.project(webapps_documents[document_id]) as project:
        with project.released(formplayer_runner) as release:
            walked = replace(Walk.of(release), answer_table=table).run()
            run = next(
                each
                for each in walked["runs"]
                if any("answers" in step for step in each["steps"]) and walks.window_of(each["script"]) is None
            )
            session = Session(release, editor_driver)
            made, kinds = observe.replay(release.doc["name"], [run], session.home)
            # The page read as the form opens (the screen read after the last choice), and once every question is
            # answered (before the form's own screen read ahead of Submit); the later one placed first.
            opened = max(
                index
                for index, kind in enumerate(kinds)
                if kind is not None and kind[0] == "screen" and len(kind) == 3 and isinstance(kind[2], int)
            )
            answered = kinds.index(("screen", 0, observe.FORM))
            made = [*made[: opened + 1], LAYOUT, *made[opened + 1 : answered], LAYOUT, *made[answered:]]
            replayed = session.run(made, deadline=180.0 + 2.0 * len(made))
    reads = {"opened": replayed.value(opened + 1), "answered": replayed.value(answered + 1)}
    evidence("layout", reads)
    assert replayed.page_errors == []

    form = _form_step(run)
    opened_tree = next(
        step["response"]["tree"]
        for step in reversed(run["steps"])
        if isinstance((step.get("response") or {}).get("tree"), list)
    )
    trees = {
        "opened": opened_tree,
        "answered": next(
            (attempt["response"]["tree"] for attempt in reversed(form["answers"]) if "tree" in attempt["response"]),
            opened_tree,
        ),
    }
    for moment, read in reads.items():
        assert read is not None, f"The page held no form {moment} on {document_id}."
        generated = _questionless(trees[moment])
        assert generated > 0, f"Formplayer's tree held no generated group {moment} on {document_id}."
        empty = [group for group in read["groups"] if group["questions"] == 0]
        assert len(empty) >= generated, (moment, read["groups"])
        assert not any(group["laidOut"] for group in empty), (moment, read["groups"])
        assert not any(group["caption"] for group in empty), (moment, read["groups"])
        assert all(group["laidOut"] for group in read["groups"] if group["questions"]), (moment, read["groups"])
        authored_captions = [group["caption"] for group in read["groups"] if group["questions"] and group["caption"]]
        leftover = (
            Counter(read["text"])
            - Counter(authored_captions)
            - Counter(read["questions"])
            - Counter(read["title"])
            - Counter(read["submit"])
        )
        assert not leftover, (moment, read["text"])
