/**
 * What an advanced action of CommCare HQ can express: whether a case change
 * of an advanced form can take a load (`LoadUpdateAction`) or an open action
 * (`AdvancedOpenCaseAction`), or takes a Save to Case block instead.
 *
 * Each predicate returns the first clause that holds, in the order below,
 * or `undefined` where none does and the action is eligible. The
 * placement procedure (`placement.ts::planPlacements`) tries the action before Save to
 * Case, which is always eligible, so an operation for which a clause holds
 * takes Save to Case. The values and conditions an action takes are the
 * basic slots': a value is a bare read of a question, never a label or a
 * group (a capture's link reads its `nova_url_` sibling, a name its
 * `nova_trimmed_` sibling); a condition is one question compared with one
 * value, whose answer holds no `'` (`xform.py::XForm.action_relevance`
 * interpolates it between single quotes), without the own case's
 * double-quote rule (HQ's advanced save strips nothing,
 * `views/forms.py::edit_advanced_form_actions`).
 *
 * A load, the own arm of a follow-up or close form, an update or close of a
 * case the form loads, or the worker's record:
 *
 * - `scope`: no load takes the change (its target is no case the form
 *   loads, or it is not the form's first change of the worker's record), or
 *   it runs in a repeat, where a load runs once.
 * - `value-not-a-question`: a write value or a rename is not a bare
 *   question read, or reads a question inside a repeat
 *   (`xform.py::_create_casexml_advanced` binds each update to one path;
 *   `helpers/validators.py::IndexedFormBaseValidator.check_paths`).
 * - `write-condition`: a write, or an update, carries a condition: a
 *   `ConditionalCaseUpdate` holds none, and a `LoadUpdateAction` states a
 *   condition only for its close (`models/form_actions.py::AdvancedAction`).
 * - `condition-not-stateable`: a close's condition is not stateable.
 * - `via-on-indexed-load`: a write goes to a case above the load, and the
 *   load is chosen under an earlier one (`check_case_properties`'
 *   `subcase_names`, `^[a-zA-Z][\w_-]*$`, no `/`).
 * - `owner`: the owner is anything but one question's answer. A load's
 *   `owner_id` key names a question path, and no generated node stands for
 *   a load's owner.
 * - `retype`: `case_type` is a reserved word (`case-reserved-words.json`).
 * - `link-target`: the change adds or changes a link; a load's one index is
 *   its chain's (`LoadUpdateAction.case_index`).
 *
 * An open action, a `create` or a registration's own arm:
 *
 * - `keyed`: the id comes from an answer; an open action's id is `uuid()` or
 *   its session value.
 * - `value-not-a-question`: the name or a write value is not a bare question
 *   read, or reads a question in another repeat than the create's (the
 *   page's "Inside the wrong repeat!").
 * - `name-repeat`: the name's question stands in another repeat than the
 *   create's; the page recomputes `repeat_context` from the name on save
 *   (`static/app_manager/js/forms/advanced/actions.js`, `repeat_context`).
 * - `write-condition`: a write carries a condition.
 * - `condition-not-stateable`: the create's condition (a registration's open
 *   and close conditions) is not stateable.
 * - `owner`: the owner is not the worker, `unowned` or one question's answer.
 * - `link-target`: a link names no case the form loads and no earlier create
 *   placed on an open action, or names no case at all: the page offers loads
 *   and earlier open actions as parents (`advanced/actions.js`), and HQ's
 *   validator refuses any other tag (`check_actions`, "missing parent tag").
 * - `link-renamed-load`: a link names a load whose session value HQ's
 *   child-module alignment renames; `_create_casexml_advanced` indexes it by
 *   the value before alignment (`add_parent_datums`).
 * - `repeat-shared`: the create's repeat holds another open action and fewer
 *   than two of them carry indices, so both would write the row's one
 *   `case` (`xform.py::get_action_path`,
 *   `AdvancedFormActions.count_subcases_per_repeat_context`). Decided in
 *   operation order: an earlier create keeps its open action.
 * - `type-not-a-menu`: no menu of the app has the case type
 *   (`xform.py::check_case_type`).
 * - `case-changed-before-create`: another change updates or closes the case
 *   it creates, which HQ's build writes after every Save to Case block, so
 *   that change would run first. A close that shares the open action is its
 *   `close_condition`.
 *
 * No action meets the basic slots' `appended-name-taken` (a
 * question named like the block HQ's build appends): every derived tag
 * steps around the names where HQ appends its `case_<tag>`
 * (`advancedTags.ts::allocateAdvancedTags`), and a question that takes a
 * held tag's name is refused at the gate (`HELD_BLOCK_PATH_TAKEN`). One
 * clause waits on a run the proof lane makes and is not
 * tried: `worker-property-name` (a worker property named outside HQ's
 * grammar).
 *
 * The clauses themselves are the domain's (`lib/domain/advancedEntryDatums.ts`:
 * `advancedLoadOf`, `opensCase`, `loadClause`, `openActionClause`), because
 * the session values an advanced form's entry gives read which change takes
 * an open action or the worker's load. This module asks them of one form.
 */

import type {
	AdvancedIneligibility,
	BlueprintDoc,
	CaseOperation,
	Uuid,
} from "@/lib/domain";
import {
	advancedLoadOf,
	loadClause,
	type OpenActionView,
	openActionClause,
	opensCase,
} from "@/lib/domain/advancedEntryDatums";
import { type CaseSlotFacts, caseSlotFacts } from "@/lib/domain/basicCaseSlots";
import { planPlacements } from "./placement";

export type { AdvancedIneligibility } from "@/lib/domain";

function operationOf(
	f: CaseSlotFacts,
	operationUuid: Uuid | "own",
): CaseOperation {
	const operation =
		operationUuid === "own"
			? f.own
			: f.operations.find((op) => op.uuid === operationUuid);
	if (operation === undefined)
		throw new Error(
			`Nova was asked whether the case change ${operationUuid} of form ${f.formUuid} can be a case action in CommCare HQ, and the form holds no such change.`,
		);
	return operation;
}

/**
 * Why `operationUuid` of `formUuid` (or its own arm, `"own"`) cannot take a
 * load of an advanced form: the first clause that holds, or `undefined`
 * where it can.
 */
export function loadIneligibility(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operationUuid: Uuid | "own",
): AdvancedIneligibility | undefined {
	const f = caseSlotFacts(doc, formUuid);
	const operation = operationOf(f, operationUuid);
	const load = advancedLoadOf(f, operation);
	return load === undefined ? "scope" : loadClause(f, operation, load);
}

/**
 * The open actions the advanced plan of `formUuid` places before
 * `operation`, which its open action's clauses read.
 */
export function openActionViewBefore(
	doc: BlueprintDoc,
	f: CaseSlotFacts,
	operation: CaseOperation,
): OpenActionView {
	const { placements } = planPlacements(doc, f.formUuid, {
		moduleKind: "advanced",
	});
	const opens = new Map<
		Uuid,
		{ readonly repeat: Uuid | undefined; readonly indexed: boolean }
	>();
	for (const earlier of f.operations) {
		if (earlier.uuid === operation.uuid) break;
		if (!opensCase(f, earlier)) continue;
		if (placements.get(earlier.uuid)?.placement.kind !== "advanced") continue;
		opens.set(earlier.uuid, {
			repeat: earlier.action === "create" ? earlier.forEach?.repeat : undefined,
			indexed: (earlier.links ?? []).length > 0,
		});
	}
	return { opens };
}

/**
 * Why `operationUuid` of `formUuid` (or its own arm, `"own"`) cannot take an
 * open action of an advanced form: the first clause that holds, or
 * `undefined` where it can. The clauses that read other open actions read
 * the ones the form's advanced plan places before it.
 */
export function openActionIneligibility(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operationUuid: Uuid | "own",
): AdvancedIneligibility | undefined {
	const f = caseSlotFacts(doc, formUuid);
	const operation = operationOf(f, operationUuid);
	return openActionClause(
		f,
		operation,
		openActionViewBefore(doc, f, operation),
	);
}
