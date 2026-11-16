"""What CommCare HQ stores for a date and time a form submits.

HQ's form processing rewrites every date-and-time string of a submission to
UTC with six fraction digits and ``Z``
(``corehq/form_processor/utils/xform.py::adjust_datetimes``, through
``adjust_text_to_datetime`` and ``dimagi/utils/parsing.py::json_format_datetime``).
Nova writes that text on the phone (``lib/commcare/xform/datetimeCaseValue.ts``),
so the phone, HQ and every other phone hold one text for a moment and a list
ordered by the property orders by the moment.

Contract, over HQ's own ``adjust_datetimes`` and each row of
``fixtures/stored-instant-vectors.json`` (held to
``lib/domain/__tests__/hqInstantText.vectors.ts`` by
``lib/domain/__tests__/temporalValues.test.ts``):

- the text Nova writes for a moment comes back as it is;
- the text a device wrote for the same moment before, its clock in the
  device's zone with Core's ``%Z`` offset, comes back as that same text;
- text that is no date and time is left as it is.

Plausible failures: the reading of ``json_format_datetime`` being wrong (three
fraction digits, an offset), so HQ rewrites what Nova wrote; HQ moving a day
for a moment near UTC midnight; a device-offset spelling HQ does not read.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

ROWS = json.loads((Path(__file__).parent / "fixtures" / "stored-instant-vectors.json").read_text())["rows"]


def _adjusted(text):
    from corehq.form_processor.utils.xform import adjust_datetimes

    return adjust_datetimes({"form": {"seen_at": text}})["form"]["seen_at"]


@pytest.mark.parametrize("row", ROWS, ids=[row["id"] for row in ROWS])
def test_hq_keeps_the_text_nova_writes_for_a_moment(hq, row):
    assert _adjusted(row["text"]) == row["text"]


@pytest.mark.parametrize(
    ("row", "zone"),
    [(row, zone) for row in ROWS for zone in row["deviceTexts"]],
    ids=[f"{row['id']}-{zone}" for row in ROWS for zone in row["deviceTexts"]],
)
def test_hq_stores_a_device_offset_spelling_of_the_same_moment_as_that_text(hq, row, zone):
    assert _adjusted(row["deviceTexts"][zone]) == row["text"]


def test_hq_leaves_text_that_names_no_moment_as_it_is(hq):
    assert _adjusted("sometime tuesday") == "sometime tuesday"
