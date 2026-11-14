"""What a worker meets in Web Apps at a Text question with a number keypad: a phone number box.

``targeted-number-keypad``: one menu of clients whose registration "Register"
asks a name and a phone number on a number keypad, which Nova writes as
``<input appearance="numeric">`` over a ``xsd:string`` bind
(``lib/commcare/xform/appearance.ts::fieldAppearance``). The client draws
``PhoneEntry`` for a text question whose style holds ``numeric``
(``form_entry/entries.js::getEntry``): a text box with ``inputmode="tel"``
(``entry_numeric.html``) that takes an answer only where it matches
``^[+-]?\\d*(\\.\\d+)?$`` and otherwise shows "This does not appear to be a
valid phone/numeric number" under the question and sends Formplayer nothing
(``PhoneEntry.getErrorMessage``, ``FreeTextEntry.onPreProcess``), so the
earlier answer is the one the form holds.

Contract, on HQ's release of Nova's export: a worker opens "Register", types
a name, then ``+254712``, then ``0712``, then ``12 34`` into "Phone number".
The phone box is an input with ``inputmode="tel"`` and the name's box has no
such mode; the client sent Formplayer ``+254712`` and ``0712`` as given (a
leading zero and a plus sign kept), each accepted, and never ``12 34``; the
client refused ``12 34`` itself, showing its message under "Phone number" and
under no other question, with ``12 34`` still in the box. Plausible failures:
a runtime drawing a plain text box for the question (no keypad mode, and
``12 34`` sent and kept), an export whose appearance the build dropped, a
number sent with its leading zero or plus sign lost, and a refusal shown
under another question.
"""

from __future__ import annotations

from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session

DOCUMENT = "targeted-number-keypad"
APP = "Client phones"
# The form's questions, by the index the client writes for each: the name, then the phone number.
NAME = "0"
PHONE = "1"
# What a worker types into the phone number box, in order: the client sends the first two, and refuses the third.
SENT = ["+254712", "0712"]
REFUSED = "12 34"
# The client's own message for an answer PhoneEntry refuses (``entries.js::PhoneEntry.getErrorMessage``).
PHONE_REFUSAL = "This does not appear to be a valid phone/numeric number"
# The page read for each question's box: its label, the element the client drew, and the keypad mode it asks for.
BOXES = {
    "eval": """() => [...document.querySelectorAll("#webforms .q")].map((question) => {
	const box = question.querySelector(".widget textarea.textfield, .widget input.form-control");
	return {
		label: (question.querySelector(".caption, legend, label")?.textContent ?? "").replace(/\\s+/g, " ").trim(),
		element: box ? box.tagName.toLowerCase() : null,
		inputmode: box ? box.getAttribute("inputmode") : null,
	};
})"""
}


def test_web_apps_draws_a_phone_number_box_that_sends_what_its_pattern_takes_and_refuses_the_rest(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    typed = [
        *steps.open_app(APP),
        *steps.choose("Clients"),
        *steps.choose("Register"),
        *steps.answer(NAME, "Ada"),
        *(step for answer in SENT for step in steps.answer(PHONE, answer)),
    ]
    # The refused answer's own step: the answer step's wait, after its mark.
    refused_at = len(typed) + 1
    made = [*typed, *steps.answer(PHONE, REFUSED), steps.SCREEN, BOXES]
    with webapps_hq.project(webapps_documents[DOCUMENT]) as project:
        with project.released(formplayer_runner) as release:
            run = Session(release, editor_driver).run(made)
    (shown,) = run.screens
    boxes = run.value(-1)
    sent = [(exchange.request_json(), exchange.json()) for exchange in run.answered("answer")]
    evidence("number-keypad", {"screen": shown, "boxes": boxes, "sent": sent, "refused": run.value(refused_at)})
    assert run.page_errors == []

    # The phone number's box asks for the telephone keypad; the name's, a plain text area, asks for none.
    name_box, phone_box = boxes
    assert name_box["label"].startswith("Name") and phone_box["label"].startswith("Phone number"), boxes
    assert (phone_box["element"], phone_box["inputmode"]) == ("input", "tel"), phone_box
    assert name_box["element"] is not None and name_box["inputmode"] != "tel", name_box

    # Formplayer was sent each number as typed, and accepted each; the refused one was never sent.
    phone_answers = [(request["answer"], reply.get("status")) for request, reply in sent if request.get("ix") == PHONE]
    assert phone_answers == [(answer, "accepted") for answer in SENT], phone_answers

    # The client refused the last number itself, under the phone number alone, and left it in the box.
    assert run.value(refused_at) == "refused", run.outcomes[refused_at]
    name, phone = shown["form"]["questions"]
    assert phone["errors"] == [PHONE_REFUSAL], phone
    assert phone["answer"] == REFUSED, phone
    assert name["errors"] == [], name
