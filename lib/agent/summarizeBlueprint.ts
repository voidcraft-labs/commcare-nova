/**
 * Compact blueprint-summary renderer. Walks `BlueprintDoc` directly and
 * emits domain-vocabulary text (`field`, `kind`, `case_property_on`) — no
 * CommCare wire terms. The SA prompt composer and the MCP `get_app`
 * tool both consume this so the two surfaces show one canonical
 * domain-vocabulary view of an app.
 */

import { countFieldsUnder } from "@/lib/doc/fieldWalk";
import type {
	BlueprintDoc,
	CaseSearchConfig,
	Column,
	Module,
	SearchInputDef,
	Uuid,
} from "@/lib/domain";
import { isContainer } from "@/lib/domain";

/**
 * Render a field and its children as nested bullet lines. Shows `id`,
 * `kind`, and the `label` / `case_property_on` hints when present. Nested
 * containers indent their children by two spaces per level so depth is
 * visually obvious.
 */
function summarizeField(
	doc: BlueprintDoc,
	uuid: Uuid,
	indent: string,
): string | undefined {
	const field = doc.fields[uuid];
	if (!field) return undefined;
	// `label` is absent on hidden, `case_property_on` is absent on
	// structural/media kinds and on non-case fields — render each
	// piece only when it's meaningful.
	const pieces: string[] = [`${indent}- ${field.id} (${field.kind})`];
	if ("label" in field && field.label) pieces[0] += `: "${field.label}"`;
	if ("case_property_on" in field && field.case_property_on) {
		pieces[0] += ` → ${field.case_property_on}`;
	}
	if (isContainer(field)) {
		const children = doc.fieldOrder[uuid] ?? [];
		const childLines = children
			.map((c) => summarizeField(doc, c, `${indent}  `))
			.filter((s): s is string => typeof s === "string");
		if (childLines.length > 0) pieces.push(childLines.join("\n"));
	}
	return pieces.join("\n");
}

/** Summarize one form: name, type, field count, nested field list. */
function summarizeForm(
	doc: BlueprintDoc,
	formUuid: Uuid,
	formIndex: number,
): string {
	const form = doc.forms[formUuid];
	if (!form) return `  - Form ${formIndex}: <missing>`;
	const count = countFieldsUnder(doc, formUuid);
	const header = `  - Form ${formIndex}: "${form.name}" (${form.type}, ${count} field${count === 1 ? "" : "s"})`;
	const extras: string[] = [];
	if (form.postSubmit) extras.push(`    post_submit: ${form.postSubmit}`);
	if (form.connect) extras.push("    [Connect enabled]");
	if (form.closeCondition) {
		const op =
			form.closeCondition.operator === "selected" ? "has selected" : "=";
		extras.push(
			`    close_condition: ${form.closeCondition.field} ${op} "${form.closeCondition.answer}"`,
		);
	}
	const topLevelFields = doc.fieldOrder[formUuid] ?? [];
	const fieldSummary =
		topLevelFields.length > 0
			? topLevelFields
					.map((u) => summarizeField(doc, u, "    "))
					.filter((s): s is string => typeof s === "string")
					.join("\n")
			: "    (no fields)";
	return [header, ...extras, fieldSummary].join("\n");
}

/**
 * Summarize a module's case list — every column and search input
 * carries its `uuid`, the SA-facing handle for the atomic-op tools
 * (`updateCaseListColumn`, `removeCaseListColumn`,
 * `reorderCaseListColumns`, and the search-input parallels). Surfacing
 * the uuids in the prompt-time summary lets the SA target follow-up
 * edits without a `getModule` round-trip after a fresh-session edit
 * resume.
 *
 * Returns `undefined` when the module has no case-list config (survey-
 * only modules; freshly created case-carrying modules). Caller
 * concatenates only when a section was produced.
 */
function summarizeCaseList(mod: Module): string | undefined {
	const config = mod.caseListConfig;
	if (config === undefined) return undefined;
	if (config.columns.length === 0 && config.searchInputs.length === 0) {
		return undefined;
	}
	const lines: string[] = ["    case_list:"];
	if (config.columns.length > 0) {
		lines.push("      columns:");
		for (const col of config.columns) {
			lines.push(`        - ${formatColumn(col)}`);
		}
	}
	if (config.searchInputs.length > 0) {
		lines.push("      search_inputs:");
		for (const input of config.searchInputs) {
			lines.push(`        - ${formatSearchInput(input)}`);
		}
	}
	if (config.filter !== undefined) {
		lines.push(`      filter: (predicate kind: ${config.filter.kind})`);
	}
	return lines.join("\n");
}

/** One-line column summary — uuid + kind + header + per-kind hint. */
function formatColumn(col: Column): string {
	const visibility =
		col.visibleInList === false || col.visibleInDetail === false
			? ` [list:${col.visibleInList ?? true} detail:${col.visibleInDetail ?? true}]`
			: "";
	const sort = col.sort
		? ` [sort:${col.sort.direction} priority:${col.sort.priority}]`
		: "";
	const body =
		col.kind === "calculated"
			? `(${col.kind}) "${col.header}"`
			: `(${col.kind}) ${col.field} → "${col.header}"`;
	return `${col.uuid}: ${body}${sort}${visibility}`;
}

/** One-line search-input summary — uuid + kind + name + label hint. */
function formatSearchInput(input: SearchInputDef): string {
	const body =
		input.kind === "simple"
			? `(simple) ${input.name} → ${input.property} (${input.type}, "${input.label}")`
			: `(advanced) ${input.name} (${input.type}, "${input.label}")`;
	return `${input.uuid}: ${body}`;
}

/**
 * Summarize a module's case-search config in one line so a fresh-
 * session SA reading the edit-mode prompt can confirm the claim cluster
 * shape and which display labels are set without a `getModule` round-
 * trip. Returns `undefined` when the module has no case-search config
 * — caller concatenates only when a section was produced.
 *
 * Output shape:
 *
 *   `case_search: claim={kind|none} display={titleSet,subtitleSet,…}`
 *
 * Claim cluster summary: the predicate's `kind` if a `claimCondition`
 * is set, otherwise `"none"`. The `dontClaimAlreadyOwned` flag is
 * appended verbatim. Display cluster summary: comma-separated list of
 * the slot names that are non-undefined; `none` when every slot is
 * cleared (rare — one-liner pinned at this width keeps the prompt
 * cheap).
 */
function summarizeCaseSearch(mod: Module): string | undefined {
	const config = mod.caseSearchConfig;
	if (config === undefined) return undefined;
	const claimKind = config.claimCondition?.kind ?? "none";
	const claimSummary = `claim={kind:${claimKind}, dontClaimAlreadyOwned:${config.dontClaimAlreadyOwned}${config.blacklistedOwnerIds !== undefined ? ", blacklistedOwnerIds:set" : ""}}`;
	const displaySlots: Array<keyof CaseSearchConfig> = [
		"searchScreenTitle",
		"searchScreenSubtitle",
		"emptyListText",
		"searchButtonLabel",
		"searchAgainButtonLabel",
		"searchButtonDisplayCondition",
	];
	const setSlots = displaySlots.filter((slot) => config[slot] !== undefined);
	const displaySummary =
		setSlots.length === 0
			? "display={none}"
			: `display={${setSlots.join(", ")}}`;
	return `    case_search: ${claimSummary} ${displaySummary}`;
}

/** Summarize a module: name, case type, forms. */
function summarizeModule(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	index: number,
): string {
	const mod = doc.modules[moduleUuid];
	if (!mod) return `- Module ${index}: <missing>`;
	const caseInfo = mod.caseType ? ` (case_type: ${mod.caseType})` : "";
	const listOnly = mod.caseListOnly ? " [case list only]" : "";
	const header = `- Module ${index}: "${mod.name}"${caseInfo}${listOnly}`;
	const sections: string[] = [header];
	const caseList = summarizeCaseList(mod);
	if (caseList) sections.push(caseList);
	const caseSearch = summarizeCaseSearch(mod);
	if (caseSearch) sections.push(caseSearch);
	const formUuids = doc.formOrder[moduleUuid] ?? [];
	const forms = formUuids
		.map((fUuid, fi) => summarizeForm(doc, fUuid, fi))
		.join("\n");
	if (forms) sections.push(forms);
	return sections.join("\n");
}

/**
 * Produce the compact text summary of the app that lands in the SA's
 * edit-mode prompt. Reads from the normalized doc directly.
 */
export function summarizeBlueprint(doc: BlueprintDoc): string {
	const lines: string[] = [];

	lines.push(`### App: "${doc.appName}"`);
	if (doc.connectType) lines.push(`Connect type: ${doc.connectType}`);

	if (doc.caseTypes?.length) {
		lines.push("");
		lines.push("**Case types:**");
		for (const ct of doc.caseTypes) {
			const props = ct.properties.map((p) => p.name).join(", ");
			const parentInfo = ct.parent_type ? ` (child of ${ct.parent_type})` : "";
			lines.push(`- ${ct.name}${parentInfo}: ${props}`);
		}
	}

	lines.push("");
	lines.push("**Structure:**");
	for (let i = 0; i < doc.moduleOrder.length; i++) {
		const moduleUuid = doc.moduleOrder[i];
		if (!moduleUuid) continue;
		lines.push(summarizeModule(doc, moduleUuid, i));
	}

	return lines.join("\n");
}
