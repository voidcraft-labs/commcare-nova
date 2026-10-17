/**
 * Step `post-submit`: every form's after-submit destination as the offered
 * set now reads it (part 06 of step 2's plan, 3. After-submit destinations,
 * "Stored shape and migration"). A form's effective destination is its
 * stored value, or for an absent slot what the default returned before the
 * cutover (`formerDefaultPostSubmit`, frozen here because the tree's default
 * now reads the menu's selection and whether it is on the menu). Each form
 * takes the first row that holds for it:
 *
 *   1. with or without links, an effective `previous` or `module` in a menu
 *      step `hidden-from-menu` has just taken off the menu is written
 *      `firstMenu`, the list of menus on both runtimes;
 *   2. with no links, an effective `previous` or `module` under a parent
 *      that selects several cases is written `firstMenu`;
 *   3. with no links, an effective `previous` in a menu that selects several
 *      cases is written `module`;
 *   4. holding links, an absent slot whose default now changes is written
 *      as its effective destination, so nothing changes for a worker;
 *   5. holding links and an explicit destination, the form is left as it is;
 *   6. a no-matches form holding `app_home` is written `firstMenu`, which
 *      sends the same bytes.
 *
 * Every write is explicit, so no absent slot changes meaning at the
 * cutover. Rows 1 to 3 each get one `after-submit-destination-moved` line,
 * naming the form, with `detail.from`, `detail.to`, `detail.cause`
 * (`off-the-menu`, `multi-select-parent` or `multi-select-menu`) and
 * `detail.menu`, the name of the form's menu. Rows 4 to 6 change nothing a
 * worker sees and get none.
 *
 * No stored document holds `hiddenFromMenu` before the cutover, so a menu
 * that holds it here is one step `hidden-from-menu` just marked.
 */

import { asUuid, defaultPostSubmit, type FormType } from "@/lib/domain";
import type { JsonRecord, RawDocument } from "../oldShape";
import type { CutoverStep, DocumentChange } from "../transform";
import { writableRecord } from "./caseLists";
import { isRecord, rawText } from "./relativePaths";

/** The form types that load a case, which the default sends back to it. */
const CASE_LOADING_FORM_TYPES: ReadonlySet<string> = new Set([
	"followup",
	"close",
]);

/**
 * The after-submit default before the cutover, frozen as it ran: `app_home`
 * for a registration or a survey, and for a case-loading form `module` in a
 * menu that opens on Search and `previous` everywhere else.
 */
function formerDefaultPostSubmit(
	formType: string,
	searchFirst: boolean,
): string {
	if (!CASE_LOADING_FORM_TYPES.has(formType)) return "app_home";
	return searchFirst ? "module" : "previous";
}

/**
 * Whether the stored menu opens on Search: an ordinary stored search
 * configuration (not the owner-only one) with `searchFirst` set, as
 * `lib/domain/modules.ts::moduleOpensOnSearch` reads it.
 */
function rawOpensOnSearch(module: JsonRecord): boolean {
	const config = module.caseSearchConfig;
	return (
		isRecord(config) &&
		!("searchActionEnabled" in config) &&
		config.searchFirst === true
	);
}

/** Whether the stored menu selects several cases. */
function rawSelectsSeveral(module: JsonRecord | undefined): boolean {
	const list = module?.caseListConfig;
	return (
		isRecord(list) &&
		isRecord(list.selection) &&
		list.selection.kind === "multiple"
	);
}

/** The facts of one stored menu the rows read. */
interface MenuFacts {
	readonly name: string;
	readonly searchFirst: boolean;
	readonly multiSelect: boolean;
	readonly parentMultiSelect: boolean;
	readonly offTheMenu: boolean;
}

function menuFacts(document: RawDocument, module: JsonRecord): MenuFacts {
	const parentUuid = module.parentModuleUuid;
	const parent =
		typeof parentUuid === "string" ? document.modules[parentUuid] : undefined;
	return {
		name: rawText(module.name),
		searchFirst: rawOpensOnSearch(module),
		multiSelect: rawSelectsSeveral(module),
		parentMultiSelect: rawSelectsSeveral(parent),
		offTheMenu: module.hiddenFromMenu === true,
	};
}

type Move = {
	readonly to: string;
	readonly cause?: "off-the-menu" | "multi-select-parent" | "multi-select-menu";
};

/** The row a form takes, as the write it makes; `undefined` for none. */
function moveOf(form: JsonRecord, facts: MenuFacts): Move | undefined {
	const type = rawText(form.type);
	const stored =
		typeof form.postSubmit === "string" ? form.postSubmit : undefined;
	const effective = stored ?? formerDefaultPostSubmit(type, facts.searchFirst);
	const holdsLinks = Array.isArray(form.formLinks) && form.formLinks.length > 0;
	const returnsToMenu = effective === "previous" || effective === "module";
	if (returnsToMenu && facts.offTheMenu) {
		return { to: "firstMenu", cause: "off-the-menu" };
	}
	if (!holdsLinks && returnsToMenu && facts.parentMultiSelect) {
		return { to: "firstMenu", cause: "multi-select-parent" };
	}
	if (!holdsLinks && effective === "previous" && facts.multiSelect) {
		return { to: "module", cause: "multi-select-menu" };
	}
	if (holdsLinks && stored === undefined) {
		const now = defaultPostSubmit(type as FormType, {
			searchFirst: facts.searchFirst,
			multiSelect: facts.multiSelect,
			parentMultiSelect: facts.parentMultiSelect,
			offTheMenu: facts.offTheMenu,
		});
		return now === effective ? undefined : { to: effective };
	}
	if (
		isRecord(form.entry) &&
		form.entry.kind === "search-no-matches" &&
		stored === "app_home"
	) {
		return { to: "firstMenu" };
	}
	return undefined;
}

export const postSubmitStep: CutoverStep = {
	id: "post-submit",
	apply(document) {
		const changes: DocumentChange[] = [];
		for (const moduleUuid of document.moduleOrder) {
			const module = document.modules[moduleUuid];
			if (module === undefined) continue;
			const facts = menuFacts(document, module);
			for (const formUuid of document.formOrder[moduleUuid] ?? []) {
				const form = document.forms[formUuid];
				if (form === undefined) continue;
				const move = moveOf(form, facts);
				if (move === undefined) continue;
				const from =
					typeof form.postSubmit === "string"
						? form.postSubmit
						: formerDefaultPostSubmit(rawText(form.type), facts.searchFirst);
				writableRecord(form).postSubmit = move.to;
				if (move.cause === undefined) continue;
				changes.push({
					reason: "after-submit-destination-moved",
					entity: {
						type: "form",
						uuid: asUuid(formUuid),
						nameAtMigration: rawText(form.name),
					},
					detail: { from, to: move.to, cause: move.cause, menu: facts.name },
				});
			}
		}
		return changes;
	},
};
