/**
 * The wire spellings of the worker's own case, in one place.
 *
 * Four surfaces name the same casedb lookup — the suite's computed
 * `usercase_id` datum, the assertion that guards it, the XForm bind that reads
 * the datum back, and the `#user/` hashtag prefix. HQ composes all of them from
 * `UsercaseXPath().case()` (`app_manager/xpath.py`), so Nova composes them from
 * one selector too. Spelling any of them out separately would let the entry's
 * assertion and the datum it guards disagree about which case they mean, and
 * the disagreement would be invisible: both are well-formed XPath, and a
 * `count(...) = 1` that never matches blocks entry into the form with nothing
 * on screen naming the cause.
 */

import { USERCASE_CASE_TYPE } from "@/lib/domain";

/** `suite_xml/sections/entries.py::EntriesHelper.get_extra_case_id_datums`. */
export const USERCASE_DATUM_ID = "usercase_id";

/**
 * `UsercaseXPath.case()`: the worker's case found by a `casedb` join on
 * `hq_user_id`, never by an id HQ chose. That join is why Nova is free to pick
 * the case id when it materializes the row.
 */
export const USERCASE_CASE_SELECTOR = `instance('casedb')/casedb/case[@case_type='${USERCASE_CASE_TYPE}'][hq_user_id=instance('commcaresession')/session/context/userid]`;

/** The computed datum's `function`. Selects rather than prompts, so the entry
 *  carries no `requires_selection` for it. */
export const USERCASE_ID_FUNCTION = `${USERCASE_CASE_SELECTOR}/@case_id`;

/**
 * The entry assertion HQ pairs with the datum.
 *
 * An equality, not a lower bound — two usercases in restore fail it exactly as
 * zero do. On a target domain without the paid `USERCASE` privilege no rows
 * exist at all, so this blocks entry into the form rather than degrading the
 * write. Nova cannot see a target's plan, so that travels as a preflight
 * attention edge rather than an authoring gate.
 */
export const USERCASE_MISSING_ASSERT_TEST = `count(${USERCASE_CASE_SELECTOR}) = 1`;

/** HQ's own locale id for that assertion's message. */
export const USERCASE_MISSING_LOCALE_ID = "case_autoload.usercase.case_missing";

/** `xform.py::SESSION_USERCASE_ID` — what the XForm's `case/@case_id` reads. */
export const SESSION_USERCASE_ID = `instance('commcaresession')/session/data/${USERCASE_DATUM_ID}`;

/**
 * What a worker sees when the assertion fails.
 *
 * CommCare throws `NoLocalizedTextException` on a locale id with no
 * app_strings entry, so this ships with the assertion. It replaces HQ's own
 * default (`app_strings.py`: "This form affects the user case, but no user
 * case id was found. Please contact your supervisor."), which names an
 * internal record and an id a frontline worker has no way to look at. The
 * reader here is standing in a clinic with a form that will not open, so the
 * message says what is missing in their terms and what usually fixes it.
 */
export const USERCASE_MISSING_MESSAGE =
	"This form saves to your own worker record, and there isn't one on this device yet. Syncing usually brings it down. If it doesn't, your supervisor can check your account.";
