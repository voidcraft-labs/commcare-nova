"""A worker backs up to the first of two same-list choices and submits the new pair through Web Apps."""

from dataclasses import replace

from lxml import etree

from proof.formplayer import apps
from proof.formplayer.walk import questions, screen_kind
from proof.observe.casedata import document_case_database

DOCUMENT = "targeted-independent-form-choices"


def _first_list(web):
    selections = []
    for _ in range(5):
        response = web.navigate(selections)
        selections = list(map(str, response.get("selections", selections)))
        if screen_kind(response) == "entities":
            return selections, response
        assert screen_kind(response) == "commands", response
        offered = [command["displayText"] for command in response["commands"]]
        title = next((label for label in ["People", "Visit two people"] if label in offered), None)
        assert title, offered
        selections.append(str(offered.index(title)))
    raise AssertionError("No record list after opening People and its visit form")


def _people(response):
    assert screen_kind(response) == "entities", response
    assert not response.get("multiSelect"), response
    return [entity["id"] for entity in response["entities"]]


def _open_pair(web, prefix, first, second, available):
    following = web.navigate([*prefix, first])
    assert set(_people(following)) == set(available), following
    chosen = list(map(str, following.get("selections", [*prefix, first])))
    form = web.navigate([*chosen, second])
    assert screen_kind(form) == "form" and form.get("title") == "Visit two people", form
    return form


def test_two_choices_from_one_list_return_to_the_first_and_submit_the_new_pair(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    from corehq.form_processor.models import CommCareCase

    doc = formplayer_documents[DOCUMENT]
    database = document_case_database(doc)
    sample = next(row for row in database.cases if row.case_type == "person")
    extra = replace(sample, case_id="proof-person-separate", name="Fourth person")
    list_only = replace(sample, case_id="proof-list-only", name="Standalone list only")
    database = replace(database, cases=(*database.cases, extra, list_only))
    with apps.published(doc, core_runner) as published, apps.served(
        published, formplayer_runner, database=database
    ) as served, served.run("choose-another-pair"):
        web = apps.web(formplayer_runner, served)
        prefix, first_list = _first_list(web)
        available = _people(first_list)
        # The document's own sample people (its review menu adds some) and the extra one.
        assert len(available) >= 4, available
        first, second, third, fourth = available[:4]
        assert list_only.case_id not in available
        old = _open_pair(web, prefix, first, second, available)

        # Web Apps requests the recorded selection prefix again when the worker goes back.
        assert _people(web.navigate(prefix)) == available
        form = _open_pair(web, prefix, third, fourth, available)
        assert form["session_id"] != old["session_id"]
        (note,) = [q for q in questions(form["tree"]) if q.get("type") == "question"]
        value = "Visited these two people"

        def notes(case_id):
            row = CommCareCase.objects.get_case(case_id, served.domain)
            return tuple(row.get_case_property(key) for key in ["first_note", "second_note"])

        before = {key: notes(key) for key in available}
        answered = web.answer(form["session_id"], note["ix"], value)
        assert any(q.get("answer") == value for q in questions(answered["tree"])), answered
        # Retrieve the saved working form through Formplayer's normal current
        # endpoint. It keeps this session's opening instructions and answers.
        reopened = apps.web(formplayer_runner, served)
        current = reopened.form_request("current", form["session_id"])
        assert any(q.get("answer") == value for q in questions(current["tree"])), current
        sent = len(served.hq.submissions)
        submitted = reopened.submit(form["session_id"], {note["ix"]: value})
        assert submitted.get("status") == "success" and len(served.hq.submissions) == sent + 1, submitted
        instance = served.hq.submissions[-1].instance
        submitted_data = etree.fromstring(instance, etree.XMLParser(resolve_entities=False, no_network=True))
        names = {row.case_id: row.name for row in database.cases}
        assert [submitted_data.findtext("{*}" + node) for node in ("earlier_value", "first_record", "starting_record")] == [
            "Before", names[third], names[fourth]
        ]
        after = {key: notes(key) for key in available}
        assert after == {**before, third: (value, before[third][1]), fourth: (before[fourth][0], value)}
        evidence("form-entry-choices", {"offered": available, "before": before, "after": after,
                                        "instance": served.hq.submissions[-1].instance.decode("utf-8")})


def test_form_link_opens_both_assigned_records_without_another_choice(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    from corehq.form_processor.models import CommCareCase

    doc = formplayer_documents[DOCUMENT]
    database = document_case_database(doc)
    sample = next(row for row in database.cases if row.case_type == "person")
    first, second = (f"{DOCUMENT}-person-{position}" for position in (1, 2))
    selected = (replace(sample, case_id=first, name="Assigned first"),
                replace(sample, case_id=second, name="Assigned second"))
    database = replace(database, cases=(*database.cases, *selected))
    with apps.published(doc, core_runner) as published, apps.served(
        published, formplayer_runner, database=database
    ) as served, served.run("open-assigned-pair"):
        web = apps.web(formplayer_runner, served)
        selections = []
        for title in ["Notes", "Open the assigned pair"]:
            menu = web.navigate(selections)
            labels = [command["displayText"] for command in menu["commands"]]
            selections = [*map(str, menu.get("selections", selections)), str(labels.index(title))]
        preparation = web.navigate(selections)
        assert screen_kind(preparation) == "form" and preparation["title"] == "Open the assigned pair"
        question, = (q for q in questions(preparation["tree"]) if q.get("type") == "question")
        web.answer(preparation["session_id"], question["ix"], "Ready")
        submitted = web.submit(preparation["session_id"], {question["ix"]: "Ready"})
        paired = submitted["nextScreen"]
        assert submitted["status"] == "success" and screen_kind(paired) == "form", submitted
        assert paired["title"] == "Visit two people", paired
        note, = (q for q in questions(paired["tree"]) if q.get("type") == "question")
        value = "Both assigned records"
        web.answer(paired["session_id"], note["ix"], value)
        assert web.submit(paired["session_id"], {note["ix"]: value})["status"] == "success"
        assert CommCareCase.objects.get_case(first, served.domain).get_case_property("first_note") == value
        assert CommCareCase.objects.get_case(second, served.domain).get_case_property("second_note") == value
        evidence("form-link-assigned-choices", {"first": first, "second": second, "form": paired["title"],
                                                "instance": served.hq.submissions[-1].instance.decode("utf-8")})
