/**
 * The add-ons one emitted app needs on CommCare HQ.
 *
 * HQ's add-ons decide which controls its app, menu and form pages offer
 * (`add_ons.py::show`). An app needs a slug when its content uses what the
 * slug's page shows, so a person editing it in HQ meets the control for what
 * Nova wrote. Every slug but `advanced_itemsets` is needed exactly where
 * HQ's own in-use predicate says it is in use (`add_ons.py::_ADD_ONS`, each
 * entry's `used_in_module` or `used_in_form`). `advanced_itemsets` has no
 * predicate in HQ; Nova needs it where a form's source holds an `<itemset>`,
 * so HQ's form page keeps the add-on on for a form whose choices come from a
 * lookup table or from the worker's cases.
 *
 * `menu_mode`, `case_detail_overwrite` and `empty_case_lists` are never
 * needed: Nova writes nothing that uses them.
 *
 * An advanced form needs `subcases` and `conditional_form_actions` whatever
 * it holds, because HQ's two predicates hold for every form that is not a
 * basic one (`_uses_conditional_form_actions`, and `subcases`'s
 * `used_in_form`). An advanced menu's product list counts toward
 * `conditional_enum` and `enum_image` (`_uses_detail_format`), and toward
 * nothing else.
 *
 * Computed over the emitted application, never the document, so it reads the
 * same bytes HQ's predicates read.
 */

import { existsOne } from "domutils";
import type { DetailPair, HqAnyForm, HqApplication } from "./types";
import { parseXml } from "./xmlParse";

/** Every slug an app can need, in HQ's registry order. */
export const NEEDED_ADD_ON_SLUGS = [
	"advanced_itemsets",
	"calc_xpaths",
	"case_list_menu_item",
	"conditional_enum",
	"conditional_form_actions",
	"display_conditions",
	"enum_image",
	"register_from_case_list",
	"subcases",
	"submenus",
] as const;

export type NeededAddOn = (typeof NEEDED_ADD_ON_SLUGS)[number];

/** Every column of some details, with its format as HQ reads it: a string. */
function detailColumns(...pairs: readonly DetailPair[]) {
	return pairs.flatMap((details) =>
		[...details.short.columns, ...details.long.columns].map((column) => ({
			useXpathExpression: column.useXpathExpression,
			format: column.format as string,
		})),
	);
}

/** The slugs one form's own actions need. */
function formActionAddOns(form: HqAnyForm): readonly NeededAddOn[] {
	if (form.doc_type === "AdvancedForm") {
		return ["conditional_form_actions", "subcases"];
	}
	const { actions } = form;
	return [
		...(actions.open_case.condition.type === "if" ||
		actions.close_case.condition.type === "if"
			? (["conditional_form_actions"] as const)
			: []),
		...(actions.subcases.length > 0 ? (["subcases"] as const) : []),
	];
}

/** Whether an XForm's source holds an `<itemset>`, in any namespace prefix. */
function holdsItemset(xform: string): boolean {
	return existsOne(
		(element) => element.name.split(":").pop() === "itemset",
		parseXml(xform).children,
	);
}

/** The slugs `app` needs, each once, in `NEEDED_ADD_ON_SLUGS` order. */
export function addOnsNeededBy(
	app: Pick<HqApplication, "modules" | "_attachments">,
): readonly NeededAddOn[] {
	const needed = new Set<NeededAddOn>();
	for (const module of app.modules) {
		// `_uses_calculated_property` reads the case details alone;
		// `_uses_detail_format` reads an advanced menu's product list too.
		const caseColumns = detailColumns(module.case_details);
		const formatColumns =
			module.doc_type === "AdvancedModule"
				? detailColumns(module.case_details, module.product_details)
				: caseColumns;
		if (caseColumns.some((column) => column.useXpathExpression)) {
			needed.add("calc_xpaths");
		}
		if (module.case_list.show) needed.add("case_list_menu_item");
		if (formatColumns.some((column) => column.format === "conditional-enum")) {
			needed.add("conditional_enum");
		}
		if (formatColumns.some((column) => column.format === "enum-image")) {
			needed.add("enum_image");
		}
		if (module.module_filter) needed.add("display_conditions");
		if (module.case_list_form.form_id) needed.add("register_from_case_list");
		if (module.root_module_id) needed.add("submenus");
		const forms: readonly HqAnyForm[] = module.forms;
		for (const form of forms) {
			for (const slug of formActionAddOns(form)) needed.add(slug);
			if (form.form_filter) needed.add("display_conditions");
			const source = app._attachments[`${form.unique_id}.xml`];
			if (source !== undefined && holdsItemset(source)) {
				needed.add("advanced_itemsets");
			}
		}
	}
	return NEEDED_ADD_ON_SLUGS.filter((slug) => needed.has(slug));
}
