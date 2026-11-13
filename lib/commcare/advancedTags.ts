/**
 * The case tags of an advanced form's actions.
 *
 * Every load and open action of an HQ advanced form carries a `case_tag`,
 * the name the form's other actions and HQ's build use for it: an index
 * names its parent by tag, and HQ writes an action's case block at the
 * data-root element `case_<tag>`
 * (`corehq/apps/app_manager/models/form_actions.py::AdvancedAction.form_element_name`).
 *
 * A derived tag is the one a person adding the action on HQ's case
 * configuration page gets
 * (`static/app_manager/js/forms/advanced/case_config_ui.js::addFormAction`):
 * a load `load_<case type><n>`, the worker's load `autoload_commcare-user<n>`
 * (the page's auto-select prefix `auto` on the worker's case type), and an
 * open action `open_<case type>_<n>`. The page uses the module's case type
 * for every new action; Nova uses the action's own, which names what the tag
 * holds and passes the same check. Nova spells a case type's `-` as `_`
 * (the worker's load is `autoload_commcare_user<n>`), since the tag names
 * the element `case_<tag>` and Nova's XForm element names hold no `-`; the
 * page's check accepts either. `n` starts at the action's position among
 * the form's loads or open actions and steps up past any tag already taken,
 * and past any tag whose `case_<tag>` element an existing name holds where
 * HQ's build appends it (the data root, or an open action's repeat row), so
 * a case block never lands beside a question of its name: HQ appends it by
 * name without looking (`xform.py::get_action_path`), and the question's
 * bind and every read of its path would then reach the block too.
 *
 * A held tag (where a published app keeps the action) is kept as held, and
 * taken before any tag is derived.
 */

import { USERCASE_CASE_TYPE } from "@/lib/domain/usercase";
import { CASE_TYPE_REGEX } from "./constants";

/**
 * The tag check of HQ's case configuration page
 * (`static/app_manager/js/forms/advanced/actions.js::actionBase.validate`).
 */
export const HQ_CASE_TAG_PATTERN = /^[a-zA-Z][\w_-]*(\/[a-zA-Z][\w_-]*)*$/;

/** The data-root element HQ writes an advanced action's case block at. */
export function advancedCaseBlockName(tag: string): string {
	return `case_${tag}`;
}

export interface AdvancedTagLoad {
	readonly caseType: string;
	/** The worker's own record, loaded from the session's user case. */
	readonly worker: boolean;
	readonly held?: string;
}

export interface AdvancedTagOpen {
	readonly caseType: string;
	readonly held?: string;
	/** Where the open action runs in a repeat: every name the repeat's rows
	 *  hold, beside which HQ's build appends its `case_<tag>` when another
	 *  open action shares the repeat. */
	readonly rowNames?: ReadonlySet<string>;
}

/**
 * The tag of every load (in `load_update_cases` order) and every open action
 * (in `open_cases` order) of one advanced form. `rootNames` is every element
 * name the form's data root holds: its root questions' ids, Nova's generated
 * root names and the root Connect block ids.
 */
export function allocateAdvancedTags(input: {
	readonly loads: readonly AdvancedTagLoad[];
	readonly opens: readonly AdvancedTagOpen[];
	readonly rootNames: ReadonlySet<string>;
}): { readonly loads: readonly string[]; readonly opens: readonly string[] } {
	const taken = new Set<string>();
	for (const action of [...input.loads, ...input.opens])
		if (action.held !== undefined) taken.add(action.held);
	const free = (tag: string, rowNames: ReadonlySet<string> | undefined) =>
		!taken.has(tag) &&
		!input.rootNames.has(advancedCaseBlockName(tag)) &&
		rowNames?.has(advancedCaseBlockName(tag)) !== true;
	const derive = (
		caseType: string,
		position: number,
		spell: (type: string, n: number) => string,
		rowNames?: ReadonlySet<string>,
	): string => {
		// A case type holds letters, digits, `-` and `_`, and every tag
		// spelled from one starts with its prefix's letter, so it passes HQ's
		// check and holds no `/`.
		if (!CASE_TYPE_REGEX.test(caseType))
			throw new Error(
				`Nova was asked for the case tag of an advanced action on the case type "${caseType}", which is not a case type CommCare accepts: a case type holds only letters, digits, "-" and "_". The app's case types are checked before it is emitted, so this one should not have reached the tags.`,
			);
		// The tag names the data-root element `case_<tag>`, and a tag is held
		// to `advancedTagSchema`, which holds no `-`, so the case type's `-`
		// is spelled `_` (`commcare-user` gives `autoload_commcare_user0`). Two
		// types that differ only there step `n` apart below, so tags stay
		// distinct.
		const spelledType = caseType.replaceAll("-", "_");
		let n = position;
		while (!free(spell(spelledType, n), rowNames)) n++;
		const tag = spell(spelledType, n);
		taken.add(tag);
		return tag;
	};
	const loads = input.loads.map((load, position) => {
		if (load.held !== undefined) return load.held;
		const caseType = load.worker ? USERCASE_CASE_TYPE : load.caseType;
		return derive(caseType, position, (type, n) =>
			load.worker ? `autoload_${type}${n}` : `load_${type}${n}`,
		);
	});
	const opens = input.opens.map(
		(open, position) =>
			open.held ??
			derive(
				open.caseType,
				position,
				(type, n) => `open_${type}_${n}`,
				open.rowNames,
			),
	);
	return { loads, opens };
}
