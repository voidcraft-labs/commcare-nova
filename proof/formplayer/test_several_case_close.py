"""A form over several selected cases closes each under its close condition, and sends no block where it does not.

Nova writes a several-case form's own close as one close-only block in each
selected case's row, ``nova_close_selected_cases``: inside the row's
``nova_condition_close`` group, whose relevance is the close condition, where
the form closes under one, and directly in the row's ``nova_operations``
group where it closes every selected case
(``lib/commcare/xform/caseOps.ts::saveToCaseBlockShape``). Core leaves a
group that is not relevant, and every node in it, out of the submission
(``XFormSerializingVisitor::serializeNode``), so where the condition does not
hold the submission carries no case block for a selected case, and HQ records
no transaction for it (``casexml/apps/case/xform.py::_extract_case_blocks``,
``form_processor/backends/sql/update_strategy.py::SqlCaseUpdateStrategy.update_from_case_update``,
over ``_apply_case_update`` and ``add_transaction_for_form``).

Contract, on ``targeted-several-case-close`` published as Nova publishes it,
released and served by HQ's own views (``proof.formplayer.hq``), each form
opened in Formplayer's own application by the Web Apps client's requests with
two of the menu's three samples chosen together, submitted, and taken by HQ's
receiver, each in a fork of its own so every form meets the same open
samples:

- "Close if finished", whose outcome holds ``pending`` and whose condition asks
  for ``done``: HQ takes the form, its instance names both chosen samples and
  holds no case block for either, and each stays open with no transaction of
  the form and its ``modified_on`` and ``server_modified_on`` where they were;
- "Close finished", whose outcome holds ``done`` under the same condition: the
  instance holds one close block for each chosen sample, and HQ closes each
  with a transaction of the form;
- "Close all", with no condition: the same, each chosen sample closed.

In every run the sample left unchosen is untouched: open, no transaction of
the form, and its dates where they were.

The lane's walk chooses one case from a list at a time
(``proof.formplayer.walk``), so it never sends a selection of several; this
test sends one as the client sends it (``selected_values`` beside
``use_selected_values``). The plausible failures: a block Formplayer submits
for a case the condition leaves open (HQ would record a transaction and move
the case's dates without closing it, the defect the condition group fixes); a
condition read in the wrong row or not at all (no case closed where it holds,
or every case closed where it does not); a block written for one row alone
(one chosen case left open); and a close that reaches a case no one chose.
"""

from __future__ import annotations

import pytest
from lxml import etree

from proof.formplayer import apps
from proof.formplayer.walk import USE_SELECTED_VALUES, screen_kind

DOCUMENT = "targeted-several-case-close"
# The menu that selects several samples, and its three close forms.
MENU = "Batches"
NOT_HELD = "Close if finished"
HELD = "Close finished"
EVERY_TIME = "Close all"
# How many of the list's samples the worker chooses together; the lane's case database holds three
# (``proof.observe.casedata.CASES_PER_TYPE``), so one stays unchosen.
CHOSEN = 2
# The screens between the app's first and the form: the menu, the form's command and the case list, in either
# order, with room for none of them to repeat.
MAX_SCREENS = 6
CASE = "{http://commcarehq.org/case/transaction/v2}case"
CLOSE = "{http://commcarehq.org/case/transaction/v2}close"
INSTANCE_ID = "{http://openrosa.org/jr/xforms}instanceID"
# The selected-cases repeat Nova writes for a several-case form, whose ``ids`` holds the cases chosen.
SELECTED_CASES = "nova_selected_cases"
PARSER = etree.XMLParser(resolve_entities=False, no_network=True)


def _opened(web, title):
    """The form ``title`` of the menu, opened with the first ``CHOSEN`` samples its list offers chosen together, as
    the Web Apps client asks for each screen: the form's screen, the samples chosen, and every sample offered."""
    wanted = [MENU, title]
    selections: list[str] = []
    chosen = offered = None
    response = web.navigate(selections)
    for _ in range(MAX_SCREENS):
        kind = screen_kind(response)
        if isinstance(response, dict) and isinstance(response.get("selections"), list):
            selections = [str(selection) for selection in response["selections"]]
        if kind == "form":
            assert response.get("title") == title, (title, response.get("title"))
            assert chosen is not None, f"Formplayer opened {title!r} with no case list before it."
            return response, chosen, offered
        if kind == "commands":
            names = [command["displayText"] for command in response.get("commands") or []]
            assert wanted and wanted[0] in names, f"Formplayer offers {names} where {title!r} needs {wanted}."
            selections = [*selections, str(names.index(wanted.pop(0)))]
            response = web.navigate(selections)
        elif kind == "entities":
            assert chosen is None, f"Formplayer asked for a second case list on the way to {title!r}."
            assert response.get("multiSelect"), f"The list before {title!r} does not select several cases."
            offered = [entity["id"] for entity in response.get("entities") or []]
            assert len(offered) > CHOSEN, f"The list before {title!r} offers {offered}, too few to leave one out."
            chosen = offered[:CHOSEN]
            selections = [*selections, USE_SELECTED_VALUES]
            response = web.navigate(selections, selected_values=chosen)
        else:
            raise AssertionError(f"Formplayer answered {kind} on the way to {title!r}: {response}")
    raise AssertionError(f"Formplayer showed {MAX_SCREENS} screens without opening {title!r}.")


def _held(domain, case_ids):
    """What HQ holds of each case: closed or not, its two dates, and the forms of its transactions."""
    from corehq.form_processor.models import CaseTransaction, CommCareCase

    found = {}
    for case_id in case_ids:
        case = CommCareCase.objects.get_case(case_id, domain)
        found[case_id] = {
            "closed": case.closed,
            "modified_on": case.modified_on.isoformat(),
            "server_modified_on": case.server_modified_on.isoformat(),
            "forms": [transaction.form_id for transaction in CaseTransaction.objects.get_transactions(case_id)],
        }
    return found


def _submitted(instance: bytes):
    """What a submission says: its instance id, the cases its selected-cases repeat names, and each case block's
    case id with whether it closes the case."""
    root = etree.fromstring(instance, PARSER)
    (instance_id,) = [element.text for element in root.iter(INSTANCE_ID)]
    (repeat,) = [
        element
        for element in root.iter()
        if isinstance(element.tag, str) and etree.QName(element).localname == SELECTED_CASES
    ]
    blocks = [(block.get("case_id"), block.find(CLOSE) is not None) for block in root.iter(CASE)]
    return {"instance_id": instance_id, "selected": (repeat.get("ids") or "").split(), "blocks": blocks}


def _closed_by_form(title, ran):
    """Each chosen case closed, with a transaction of the submitted form and one close block of the instance; the
    unchosen case untouched."""
    form = ran["submitted"]["instance_id"]
    assert sorted(ran["submitted"]["blocks"]) == sorted((case_id, True) for case_id in ran["chosen"]), (title, ran)
    for case_id in ran["chosen"]:
        after = ran["after"][case_id]
        assert after["closed"] is True, (title, case_id, after)
        assert form in after["forms"] and form not in ran["before"][case_id]["forms"], (title, case_id, after)


def _untouched(title, ran, case_ids):
    """Each of ``case_ids`` open, with no transaction of the submitted form, its dates where they were."""
    form = ran["submitted"]["instance_id"]
    for case_id in case_ids:
        before, after = ran["before"][case_id], ran["after"][case_id]
        assert after["closed"] is False, (title, case_id, after)
        assert form not in after["forms"], (title, case_id, after)
        assert after == before, (title, case_id, before, after)


def test_a_several_case_close_closes_each_chosen_case_only_where_its_condition_holds(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    from corehq.form_processor.models import XFormInstance

    runs = {}
    with apps.published(formplayer_documents[DOCUMENT], core_runner) as published:
        with apps.served(published, formplayer_runner) as served:
            for title in (NOT_HELD, HELD, EVERY_TIME):
                with served.run(title.lower().replace(" ", "-")):
                    web = apps.web(formplayer_runner, served)
                    form, chosen, offered = _opened(web, title)
                    before = _held(served.domain, offered)
                    sent = len(served.hq.submissions)
                    answer = web.submit(form["session_id"], {})
                    submissions = served.hq.submissions[sent:]
                    assert answer.get("status") == "success", (title, answer)
                    assert len(submissions) == 1, (title, len(submissions))
                    submitted = _submitted(submissions[0].instance)
                    taken = XFormInstance.objects.get_form(submitted["instance_id"], served.domain)
                    runs[title] = {
                        "chosen": chosen,
                        "unchosen": [case_id for case_id in offered if case_id not in chosen],
                        "submitted": submitted,
                        "taken": taken.is_normal,
                        "before": before,
                        "after": _held(served.domain, offered),
                        "instance": submissions[0].instance.decode("utf-8"),
                    }
    evidence("runs", runs)
    for title, ran in runs.items():
        # The several-case path was taken, and HQ took the form whole, whatever it did to the cases.
        assert sorted(ran["submitted"]["selected"]) == sorted(ran["chosen"]), (title, ran["submitted"])
        assert ran["taken"] is True, (title, ran)
        _untouched(title, ran, ran["unchosen"])
    not_held = runs[NOT_HELD]
    assert not_held["submitted"]["blocks"] == [], (NOT_HELD, not_held["submitted"])
    _untouched(NOT_HELD, not_held, not_held["chosen"])
    _closed_by_form(HELD, runs[HELD])
    _closed_by_form(EVERY_TIME, runs[EVERY_TIME])


def test_basic_automatic_multi_selection_uses_the_whole_datum_and_refuses_overflow(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    from dataclasses import replace

    from proof.formplayer.webapps import FormplayerRefused
    from proof.observe.casedata import document_case_database

    document = formplayer_documents[DOCUMENT]
    database = document_case_database(document)
    seed = next(case for case in database.cases if case.case_type == 'sample')
    # One more than the browser's explicit page, and names that sort opposite
    # the order used to restore these cases. The actual restore supplies the oracle.
    cases = tuple(replace(seed, case_id=f'auto-{i:03}', name=f'{101 - i:03}') for i in range(101))

    def change(maximum):
        def configure(stored):
            short = stored['modules'][0]['case_details']['short']
            short['auto_select'] = True
            short['max_select_value'] = maximum
            short['sort_elements'] = [{'field': 'case_name', 'type': 'plain', 'direction': 'ascending',
                                       'blanks': 'last', 'doc_type': 'SortElement'}]

        return configure

    def choose_command(response, title):
        assert screen_kind(response) == 'commands', response
        titles = [command['displayText'] for command in response['commands']]
        return [*response.get('selections', []), str(titles.index(title))]

    observations = {}
    with apps.published(document, core_runner) as published:
        for name, batch, maximum in [('all', cases, 101), ('overflow', cases, 100), ('empty', (), 100)]:
            with apps.served(published, formplayer_runner, label=name, change=change(maximum),
                             database=replace(database, cases=batch)) as served, served.run(name):
                web = apps.web(formplayer_runner, served)
                top = web.navigate()
                menu = choose_command(top, MENU)
                form_path = None
                try:
                    response = web.navigate(menu, cases_per_page=7)
                    if screen_kind(response) == 'commands':
                        # Case-first menus can already contain the automatic
                        # selection before we choose the form's command.
                        form_path = choose_command(response, EVERY_TIME)
                        response = web.navigate(form_path, cases_per_page=7)
                except FormplayerRefused as refusal:
                    assert name == 'overflow', refusal
                    exchange = refusal.exchange
                    observations[name] = {'status': exchange.response.status,
                                          'body': exchange.response.body.decode()}
                    assert '101' in str(refusal) and '100' in str(refusal), refusal
                    assert not served.hq.submissions
                    continue
                observations[name] = {'screen': screen_kind(response), 'selection': response.get('selections')}
                if name == 'overflow':
                    # A handled response in place of the HTTP error is also a
                    # native refusal, provided it reports both limits and no form.
                    assert screen_kind(response) == 'notification' and '101' in str(response) and '100' in str(response), response
                elif name == 'empty':
                    assert screen_kind(response) == 'entities' and not response.get('entities'), response
                else:
                    assert screen_kind(response) == 'form' and response['title'] == EVERY_TIME, response
                    restored = [case.get('case_id') for data in served.hq.restores[:1]
                                for case in etree.fromstring(data, PARSER).iter(CASE)
                                if (case.get('case_id') or '').startswith('auto-')]
                    assert len(restored) == len(cases)
                    assert restored != [case.case_id for case in sorted(cases, key=lambda case: case.name)]
                    assert form_path is not None, response
                    # As the Web Apps breadcrumb does, trim the form command.
                    # The retained batch leads straight back to its command menu.
                    previous = web.navigate(form_path[:-1], cases_per_page=7)
                    assert screen_kind(previous) == 'commands', previous
                    first = web.navigate([], cases_per_page=7)
                    assert screen_kind(first) == 'commands', first
                    assert MENU in [command['displayText'] for command in first['commands']], first
                    response = web.navigate(choose_command(previous, EVERY_TIME), cases_per_page=7)
                    result = web.submit(response['session_id'], {})
                    assert result['status'] == 'success', result
                    (submission,) = served.hq.submissions
                    submitted = _submitted(submission.instance)
                    assert submitted['selected'] == restored
                    assert sorted(submitted['blocks']) == sorted((record.case_id, True) for record in batch)
                    assert all(row['closed'] for row in _held(served.domain, restored).values())
                    observations[name]['orderedCaseIds'] = restored
                if name != 'all':
                    assert not served.hq.submissions
    evidence('automatic-multiple-case-selection', observations)



@pytest.mark.parametrize("kind", ["close", "followup", "answer"])
def test_the_authored_bounded_case_list_selects_101_and_refuses_the_102nd(
    hq, formplayer_runner, formplayer_documents, evidence, kind,
):
    import json
    from dataclasses import replace
    from pathlib import Path

    from proof.formplayer.hq import serve
    from proof.formplayer.webapps import FormplayerRefused
    from proof.hq.check import hq_check
    from proof.matrix import registry
    from proof.matrix.authoring import Authoring
    from proof.observe import casedata, publish

    followup = kind != "close"
    witness = json.loads((Path(__file__).parent / "fixtures" / "bounded-flat-close-case-list.json").read_text())
    doc = formplayer_documents["hq-bounded-flat-close"]
    database = casedata.document_case_database(doc)
    seed = next(case for case in database.cases if case.case_type == "sample")
    cases = tuple(replace(seed, case_id=f"bounded-{index:03}", name=f"Sample {index:03}")
                  for index in range(witness["overflowCount"]))
    observations = {}
    with hq_check(doc.exports["minimum"].configuration.hq()) as (unit, _):
        with unit.operation("the stock bounded flat close", doc.id.encode()):
            app_id, refusal, _ = publish.create_authored(unit, doc)
            assert refusal is None, refusal
            if followup:
                author = Authoring(unit, {}, doc.id, operation=unit.operation)
                change = "limit_101_with_visible_question" if kind == "answer" else "limit_101_outside_flat_close"
                registry.named_change(change)(author, app_id)
        for batch, count in (("at-maximum", witness["selectedCount"]), ("overflow", witness["overflowCount"])):
            overflow = batch == "overflow"
            supplied = replace(database, cases=cases[:count])
            with serve(unit, doc, app_id, runner=formplayer_runner, database=supplied, label=batch) as served:
                with served.run(batch):
                    web = apps.web(formplayer_runner, served)
                    page = web.navigate()
                    assert screen_kind(page) == "commands", page
                    (menu,) = [str(index) for index, command in enumerate(page["commands"])
                               if command["displayText"] == witness["menu"]]
                    try:
                        page = web.navigate([menu], cases_per_page=witness["pageSize"])
                        if screen_kind(page) == "commands":
                            (form,) = [str(index) for index, command in enumerate(page["commands"])
                                       if command["displayText"] == witness["form"]]
                            page = web.navigate([*page["selections"], form], cases_per_page=witness["pageSize"])
                    except FormplayerRefused as error:
                        assert overflow, error
                        message = str(error)
                    else:
                        if not overflow:
                            assert screen_kind(page) == "form" and page["title"] == witness["form"], page
                            ids = {case.case_id for case in supplied.cases}
                            before = _held(served.domain, sorted(ids)) if followup else None
                            answers = {}
                            if kind == "answer":
                                question, = [node for node in page["tree"] if node.get("type") == "question"]
                                answers[question["ix"]] = "Reviewed"
                            result = web.submit(page["session_id"], answers)
                            assert result["status"] == "success", result
                            (submission,) = served.hq.submissions
                            if followup:
                                payload = etree.fromstring(submission.instance, PARSER)
                                assert not list(payload.iter(CASE))
                                assert payload.findtext("{*}outcome") == ("Reviewed" if kind == "answer" else "done")
                                assert _held(served.domain, sorted(ids)) == before
                                observations[batch] = {"caseTransactions": 0, "offered": count}
                            else:
                                submitted = _submitted(submission.instance)
                                assert len(submitted["selected"]) == count and set(submitted["selected"]) == ids
                                assert sorted(submitted["blocks"]) == sorted((case_id, True) for case_id in ids)
                                observations[batch] = {"selected": submitted["selected"], "blocks": submitted["blocks"]}
                            continue
                        assert screen_kind(page) == "notification", page
                        message = str(page)
                    assert str(witness["selectedCount"]) in message and str(count) in message, message
                    assert not served.hq.submissions
                    observations[batch] = {"message": message}
    evidence("bounded-case-list", observations)
