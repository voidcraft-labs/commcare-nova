# CommCare HQ's own fixtures

Copied byte for byte from `corehq/apps/app_manager/tests/data/` of CommCare HQ
at commit `d6c6e16d8ae12a5d0680fe6cce5c51a8b4c8708b`, the `commcare-hq` pin in
`proof/pins.json`, keeping HQ's directory layout:

- `form_preparation_v2/subcase-repeat.json` and `multiple_subcase_repeat.json`:
  application sources, with the XForms HQ's build makes of their first form,
  `subcase-repeat.xml` and `multiple_subcase_repeat.xml`
  (`tests/test_form_preparation_v2.py::SubcaseRepeatTest`).
- `original_form.xml` and `form_preparation_v2_advanced/subcase_original.xml`:
  the stored XForms HQ's advanced tests start from, with HQ's builds
  `form_preparation_v2_advanced/update_case.xml`, `open_update_case.xml`,
  `subcase-repeat.xml` and `subcase-repeat-multiple.xml`
  (`FormPreparationV2TestAdvanced` and `SubcaseRepeatTestAdvanced`).
- `save_to_case_in_groups.xml`: a stored XForm holding Save to Case blocks
  in a repeat and in a group (`tests/test_get_questions.py`).

`publishedCaseBlocks.test.ts` reads them as HQ's own evidence. Refresh them
from the checkout when the pin moves.
