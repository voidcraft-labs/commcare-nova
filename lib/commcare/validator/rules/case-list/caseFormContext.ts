import {
	type BlueprintDoc,
	type Module,
	moduleFormsReadSearch,
	type Uuid,
} from "@/lib/domain";
import { moduleCaseTypeForActions } from "@/lib/domain/basicCaseSlots";
import {
	caseContextLine,
	resolveCaseFormContext,
} from "@/lib/domain/caseFormContext";
import { detailEntrySupplies } from "@/lib/domain/entryDatumSupplies";
import {
	checkExpression,
	type DatumRef,
	type Expression,
	slotContext,
	walkExpression,
} from "@/lib/domain/expression";
import { datumRefKey } from "@/lib/domain/expression/types";
import { detailBindings } from "../../../suite/case-list/detailBindings";
import { validationError } from "../../errors";
import {
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../../lookupTypeContext";

export function caseFormContext(
	mod: Module,
	uuid: Uuid,
	doc: BlueprintDoc,
	tables?: LookupTypeIndex,
) {
	const config = mod.caseListConfig;
	const source = config?.contextAboveForm;
	if (!source) return [];
	const invalid = (reason: string) => [
		validationError("CASE_FORM_CONTEXT_INVALID", "module", reason, {
			moduleUuid: uuid,
			moduleName: mod.name,
		}),
	];
	if (moduleCaseTypeForActions(doc, uuid) === "")
		return invalid(
			"This menu needs a case list or a form that opens a case to show its context.",
		);
	if (config?.selection)
		return invalid(
			"A case context above forms needs one selected case. Choose one case at a time or remove the context.",
		);
	if (source.kind === "menu-tile") {
		const target = doc.modules[source.moduleUuid];
		if (
			!target ||
			moduleCaseTypeForActions(doc, target.uuid) !== mod.caseType ||
			!target.caseListConfig?.tile
		)
			return invalid(
				"Choose another menu that shows this case type and has a Results tile.",
			);
		if (target.uuid !== uuid) {
			const expanded =
				resolveCaseFormContext(doc.modules, uuid)?.inlineModuleUuid ===
				target.uuid;
			const unavailable = borrowedDetailDependency(doc, mod, target, expanded);
			if (unavailable) return invalid(unavailable);
		}
	}

	const expression = caseContextLine(source);
	if (expression) {
		if (config?.tile?.persistOnForms)
			return invalid(
				"Choose the case tile or the one-line context to show above the form.",
			);
		const ctx = slotContext(
			doc,
			{ entity: "module", uuid, slot: "case_form_context_line" },
			tables ?? new Map(),
		);
		if (!ctx) return invalid("This context needs a case to read.");
		const [error] = semanticCheckErrors(checkExpression(expression, ctx));
		if (error)
			return invalid(
				`The context above the form needs a value this case can show. ${error.message}`,
			);
	}
	if (
		source.kind !== "line" &&
		source.expandDetails &&
		!resolveCaseFormContext(doc.modules, uuid)?.inlineModuleUuid
	)
		return invalid(
			"Expandable case context needs a tile that stays on screen and at least one field shown in Details.",
		);
	return [];
}

/** The borrowed tile keeps the owner's wire expressions; the menu that chose
 * the case supplies the worker session. A borrowed calculated field or data
 * tab can only read earlier choices and query results that exist there too. */
function borrowedDetailDependency(
	doc: BlueprintDoc,
	menu: Module,
	owner: Module,
	expanded: boolean,
): string | undefined {
	const layout = owner.caseListConfig;
	if (!layout) return;
	const source = detailBindings(doc, owner);
	const destination = detailBindings(doc, menu);
	const rows = detailEntrySupplies(doc, menu.uuid).searchResults;
	const variables = new Map<string, DatumRef>();
	const inputs = new Set<Uuid>();
	let usesSearchRows = false;
	function read(value: Expression | undefined) {
		if (!value) return;
		walkExpression(value, {
			visitExpression(node) {
				if (node.kind === "cases" && node.source === "search-results")
					usesSearchRows = true;
				if (node.kind === "selected-cases") {
					const ref = { kind: "selected-case" as const, module: node.module };
					variables.set(datumRefKey(ref), ref);
				}
			},
			visitTerm(term) {
				if (term.kind === "session-datum")
					variables.set(datumRefKey(term.datum), term.datum);
				if (term.kind === "input") inputs.add(term.searchInputUuid);
				if (term.kind === "prop" && term.via && moduleFormsReadSearch(owner))
					usesSearchRows = true;
			},
		});
	}
	for (const column of layout.columns) {
		const shown = column.visibleInList !== false && !column.notOnList;
		if (!shown && (!expanded || column.visibleInDetail === false)) continue;
		if (column.kind === "calculated") read(column.expression);
		else if (column.via && moduleFormsReadSearch(owner)) usesSearchRows = true;
	}
	if (expanded)
		for (const tab of layout.detailTabs ?? []) {
			read(tab.displayCondition);
			const source = tab.rowSource;
			if (source?.kind === "children") {
				if (moduleFormsReadSearch(owner)) usesSearchRows = true;
				read(source.condition);
			} else if (source) read(source.rows);
		}
	for (const ref of variables.values()) {
		const ownerId = source.datumId?.(ref);
		if (!ownerId || destination.datumId?.(ref) !== ownerId)
			return "This tile reads an earlier case choice that this menu does not supply. Choose a layout that uses the selected case or the same earlier choice.";
	}
	for (const input of inputs)
		if (!destination.searchInputNames?.has(input))
			return "This tile reads a Search answer that this menu does not supply. Choose a layout that uses the selected case or a search shared by both menus.";
	if (usesSearchRows && !rows)
		return "These Details read search results. Choose a menu whose search opens before the worker selects a case, or choose Details that read cases on the device.";
}
