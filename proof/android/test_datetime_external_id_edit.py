"""The Android worker compares the retained Basic datetime write as a day."""

from datetime import datetime, timezone

import pytest
from lxml import etree

from proof.android import observe
from proof.android.hq import DevicePeer
from proof.editors import compare, pages
from proof.editors.test_datetime_external_id import BASE, CASE, DAY, MOMENT, QUESTION, RECORD
from proof.formplayer import hq as hq_forms
from proof.hq import operations
from proof.hq.check import hq_check
from proof.matrix import ops
from proof.matrix.authoring import Authoring
from proof.observe.casedata import CaseDatabase, CaseRecord, USER_ID, USERNAME
from proof.observe.record import Blobs

pytestmark = pytest.mark.reader("android")


def test_installed_android_compares_the_direct_external_id_day_before_saving(hq, editor_driver, monkeypatch):
    from corehq.form_processor.models import CommCareCase

    with hq_check(BASE.configuration) as (state, record):
        authoring = Authoring(state=state, documents={}, base=BASE.id, driver=editor_driver, operation=state.operation)
        app_id = BASE.build(authoring)
        for menu, form in BASE.vellum:
            ops.builder_save(authoring, app_id, menu, form)
        ops.set_json(
            authoring, app_id, "/modules/0/forms/3/actions/update_case/update/external_id",
            {"question_path": QUESTION, "update_mode": "edit", "doc_type": "ConditionalCaseUpdate"},
        )
        form_id = operations.held_app(state, app_id).modules[0].forms[3].unique_id
        saved = pages.fresh_section_save(editor_driver, state, pages.CASE_MANAGEMENT, app_id, form_id)
        assert saved.save is not None and not saved.refused, (saved.alerts, saved.unsent, saved.response)
        mapping = operations.held_app(state, app_id).get_form(form_id).actions.update_case.update["external_id"]
        assert (mapping.question_path, mapping.update_mode) == (QUESTION, "edit")

        built = compare.build(state, app_id, record)
        assert not built.errors, built.errors
        tree = etree.fromstring(built.files["modules-0/forms-3.xml"])
        (bind,) = tree.xpath("//*[local-name()='bind'][contains(@nodeset,'/update/external_id')]")
        assert bind.get("calculate") == QUESTION
        assert bind.get("type") is None
        relevance = bind.get("relevant")
        assert relevance.startswith(f"count({QUESTION}) > 0 and instance('casedb')")
        assert relevance.endswith(f"/external_id != {QUESTION}")

        original_receipts = DevicePeer._stored

        def read_saved_external_id(peer, submissions):
            rows = original_receipts(peer, submissions)
            for receipt in rows:
                case = CommCareCase.objects.get_case(RECORD, state.domain)
                receipt["storedExternalId"] = case.external_id
            return rows

        monkeypatch.setattr(DevicePeer, "_stored", read_saved_external_id)
        database = CaseDatabase(
            USER_ID, USERNAME, (),
            (CaseRecord(RECORD, "household", "One household", USER_ID, MOMENT, MOMENT, DAY, ()),),
        )
        with hq_forms.serve(state, None, app_id, database=database, platforms={"android"}) as served:
            archive = observe.release_archive(served)
            # Android enters date and time to the minute. The sibling saves that same answer.
            for label, moment, want_leaf, want_external_id in (
                ("same-day", "2025-04-06T06:24:00.000Z", None, DAY),
                ("next-day", "2025-04-07T06:24:00.000Z", "2025-04-07", "2025-04-07"),
                ("untouched", None, None, None),
            ):
                blobs, sent, stored = Blobs(), [], []
                before = datetime.now(timezone.utc).replace(second=0, microsecond=0)
                result = observe.app(
                    served, blobs, label=f"edit-external-id-{label}", archive=archive,
                    commands=["m0-f3"], questions={QUESTION: [moment] if moment else []},
                    delivered=True, sent=sent, stored=stored, installation_languages=("en",),
                )
                after = datetime.now(timezone.utc).replace(second=0, microsecond=0)
                walk = blobs.get_json(result["answer"])["walks"]["m0-f3"]
                assert len(sent) == 1, walk
                receipt, = stored
                assert receipt["form"]["normal"], receipt
                for submission in (sent[0], receipt["form"]["xml"].encode()):
                    root = etree.fromstring(submission)
                    update = root.find(f"{{{CASE}}}case/{{{CASE}}}update")
                    external = update.find(f"{{{CASE}}}external_id")
                    instant = update.findtext(f"{{{CASE}}}seen_at")
                    selected = datetime.fromisoformat(instant)
                    if moment is None:
                        # The native DateTimeWidget always returns its displayed day and time.
                        # Its Joda clock uses the host wall clock, outside the lane's XPath clock.
                        assert before <= selected <= after
                        assert external is not None and external.text == instant[:10]
                        assert receipt["storedExternalId"] == instant[:10], receipt
                    else:
                        assert selected == datetime.fromisoformat(moment)
                        assert receipt["storedExternalId"] == want_external_id, receipt
                        if want_leaf is None:
                            assert external is None
                        else:
                            assert external is not None and external.text == want_leaf
