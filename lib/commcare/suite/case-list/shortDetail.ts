// lib/commcare/suite/case-list/shortDetail.ts
//
// Suite-XML emission for the case-list short detail —
// `<detail id="m{n}_<target>_short">`. Walks
// `module.caseListConfig.columns`, filters by `column.visibleInList`
// (absent ≡ visible), and concatenates one `<field>` per surviving
// column into the surrounding `<detail>` shell.
//
// One emitter, two targets. The `target` parameter
// (`"case"` / `"search"`) selects which of the two CCHQ wire ids
// the same `caseListConfig` projects onto. The emit content is
// identical between the two targets except for three load-bearing
// slots: the `<detail id>` attribute, the column header locale ids,
// and (when calc columns walk cross-case) the `<template>` xpath's
// instance reference. Driven by the orchestrator at
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml`,
// which pins the structural identity between `m0_case_short` and
// `m0_search_short` (same fields, same sort, same column ordering).
//
// The `<detail>` shell carries:
//
//   - `id="m{moduleIndex}_{target}_short"` — the canonical short-
//     detail identifier CCHQ binds entries against. CCHQ's
//     `commcare-hq/corehq/apps/app_manager/id_strings.py::detail`
//     helper returns the same `m{module.id}_{detail_type}` shape
//     for both targets; the surrounding entry's
//     `detail-select="m{N}_case_short"` attribute references the
//     case target, while `<remote-request>`'s `<datum>` references
//     the search target via `detail-select="m{N}_search_short"`.
//
//   - `<title>` referencing `<locale id="cchq.case"/>` — CCHQ's
//     built-in case-detail title locale, registered with
//     `default="Case"` at
//     `commcare-hq/corehq/apps/app_manager/id_strings.py::_case_detail_title_locale`.
//     No app-strings entry needed; the runtime resolves the
//     fallback.
//
//   - One `<field>` per column where `visibleInList ?? true`, in
//     `caseListConfig.columns` order.
//
// Per-column sort directives are resolved once by
// `sortKeys.ts::buildSortDirectives(mod, doc)` and threaded through
// the per-column emitter via `CaseListEmitContext.sortByUuid`. The
// per-column emitter looks up its directive by `column.uuid` and
// emits the matching `<sort>` block on short detail.
//
// Position counter convention: the 1-based position passed to the
// per-column header-locale composer is the column's source-array
// index plus one. The visibility filter affects which fields render,
// not their position numbers — toggling `visibleInList` doesn't
// churn locale ids. Mirrors CCHQ's
// `commcare-hq/corehq/apps/app_manager/id_strings.py::detail_column_header_locale`'s
// `column.id`-keyed numbering convention.
//
// The emitter does NOT register the `<title>` text into app_strings
// — `cchq.case` is CCHQ's built-in locale with a runtime fallback.
// Authors who want to override the title register `cchq.case`
// themselves at the app-strings layer (Nova has no such authoring
// surface today; the runtime fallback is the rendered title).
//
// Search-action element. When the parent module has a
// `caseSearchConfig`, the case-target short detail carries a
// `<action>` child after the `<field>` block — the affordance the
// runtime renders as the "Search Cases" button on top of the case
// list. The action's `auto_launch` attribute carries the wire
// expression CCHQ chooses based on `WireShape.autoLaunch`:
// `false()` when off; the canonical
// `commcare-hq/corehq/apps/app_manager/suite_xml/sections/details.py::AUTO_LAUNCH_EXPRESSIONS["single-select"]`
// expression when on. The `<action>` element only mounts on the
// case-target detail (the `m{N}_case_short` wire id); the search-
// target detail (`m{N}_search_short`) carries no `<action>` because
// the search results screen is itself the action's destination.
// Verified against
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml::detail[@id='m0_case_short']/action`
// (present) and the same fixture's `detail[@id='m0_search_short']`
// (no `<action>` child).

import type { BlueprintDoc, Module } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate/types";
import { emitCaseListFilter } from "../../predicate";
import { escapeXml } from "../../xml";
import { emitColumnField } from "./columns";
import { buildSortDirectives } from "./sortKeys";
import type {
	CaseListEmission,
	CaseListEmitContext,
	DetailTarget,
} from "./types";

/**
 * Optional search-action context passed by the orchestrator at
 * `lib/commcare/compiler.ts` when the module has a
 * `caseSearchConfig`. Carries the `WireShape.autoLaunch` flag the
 * orchestrator already computed via `compileForPlatform`, plus the
 * optional `searchButtonDisplayCondition` predicate the case-search
 * config carries. When this arg is present, the short-detail emitter
 * renders an `<action>` child after the `<field>` block on the
 * case-target detail; when absent, no `<action>` element is emitted
 * (the case-list-only path for modules without case search).
 *
 * `displayCondition` lands on the `<action relevant>` attribute when
 * set — CCHQ's
 * `commcare-hq/corehq/apps/app_manager/suite_xml/sections/details.py::DetailContributor._get_relevant_expression`
 * puts the search-config's display-condition predicate there to
 * gate visibility of the search affordance. When the predicate is
 * absent, the `relevant` attribute is omitted entirely (CCHQ's
 * default: action always visible).
 */
export interface SearchActionContext {
	readonly autoLaunch: boolean;
	readonly displayCondition?: Predicate;
}

/**
 * The `auto_launch` XPath expression CCHQ uses for single-select
 * modules when auto-launch is enabled. Lifted verbatim from
 * `commcare-hq/corehq/apps/app_manager/suite_xml/sections/details.py::AUTO_LAUNCH_EXPRESSIONS["single-select"]`.
 * The `$next_input` reference is a session-scoped variable CCHQ's
 * runtime resolves at evaluation time; Nova passes the expression
 * through unchanged because the variable is part of CCHQ's runtime
 * vocabulary, not Nova's authoring surface.
 */
const AUTO_LAUNCH_SINGLE_SELECT_EXPR =
	"$next_input = '' or count(instance('casedb')/casedb/case[@case_id=$next_input]) = 0";

/**
 * Compose the suite-XML `<detail>` block for one module's case-list
 * short detail. Returns the concatenated XML plus the locale-id →
 * header-string map the surrounding compiler threads into
 * `app_strings.txt`.
 *
 * `doc` is the source `BlueprintDoc`. The emitter consults it for
 * two reasons: (1) `buildSortDirectives` walks the doc's case-type
 * declarations to resolve the comparator type for property-rooted
 * sort directives, (2) `buildSortDirectives` runs the predicate AST
 * type checker against the same admission set as the validator
 * (declared properties + writer-derived + standard) for calculated-
 * column sort directives. Tests that don't exercise sort behavior
 * pass an empty doc.
 *
 * `target` selects between the two wire ids the same
 * `caseListConfig` projects onto — `"case"` (the local case-list
 * detail) or `"search"` (the search-results detail; emitted only
 * when the parent module has `caseSearchConfig`). The orchestrator
 * at `lib/commcare/compiler.ts` calls this once per active target.
 * Defaults to `"case"` so existing callers (and tests) that don't
 * thread a target stay on the case-list path unchanged.
 *
 * When `module.caseListConfig` is absent OR the module has no case
 * type, the emitter returns a minimal title-only `<detail>` block.
 * The validator's `columnReferences` rule (and its sibling rules)
 * gate non-empty configs against presence of `mod.caseType`, so a
 * populated config without a case type would fail validation
 * upstream — the absence-arm here is the structural fallback.
 */
export function emitShortDetail(args: {
	readonly module: Module;
	readonly moduleIndex: number;
	readonly doc: BlueprintDoc;
	readonly target?: DetailTarget;
	readonly searchAction?: SearchActionContext;
}): CaseListEmission {
	const { module: mod, moduleIndex, doc } = args;
	const target: DetailTarget = args.target ?? "case";
	const detailId = `m${moduleIndex}_${target}_short`;
	// `<action>` lives only on the case-target detail per the
	// canonical fixture. A `searchAction` arg passed alongside
	// `target: "search"` would be a logic error at the orchestrator
	// (the search-target detail is the action's destination, not
	// its host); the emitter ignores the arg defensively.
	const searchAction = target === "case" ? args.searchAction : undefined;

	// Early-exit shape: no caseListConfig OR no case type. The
	// resulting detail still carries a title — CCHQ's
	// `commcare-hq/corehq/apps/app_manager/suite_xml/xml_models.py::Detail`
	// model declares `title` as a non-optional `NodeField`, so a
	// zero-field detail still emits the `<title>` element.
	if (!mod.caseType || !mod.caseListConfig) {
		return {
			xml: emitDetailShell(detailId, [], searchAction, moduleIndex),
			strings: {},
		};
	}

	const config = mod.caseListConfig;
	const ctx: CaseListEmitContext = {
		moduleIndex,
		sortByUuid: buildSortDirectives(mod, doc),
		detailKind: "short",
		target,
	};

	const fields: string[] = [];
	const strings: Record<string, string> = {};

	// Walk every column in source-array order. Position is 1-based
	// against the source array — the 1-based counter advances for
	// every slot, including columns hidden from this surface, so the
	// header-locale suffix matches CCHQ's
	// `id_strings.py::detail_column_header_locale` convention which
	// keys off `column.id` (the source-array index regardless of
	// visibility).
	for (let i = 0; i < config.columns.length; i++) {
		const column = config.columns[i];
		// Visibility filter: absent slot ≡ visible. The schema
		// preserves the slot's presence so the editor can distinguish
		// "user explicitly toggled off" from "user never toggled".
		if (column.visibleInList === false) continue;
		const emission = emitColumnField({
			column,
			position: i + 1,
			ctx,
		});
		fields.push(emission.xml);
		Object.assign(strings, emission.strings);
	}

	return {
		xml: emitDetailShell(detailId, fields, searchAction, moduleIndex),
		strings,
	};
}

/**
 * Build the surrounding `<detail>` element. The title routes
 * through the built-in `cchq.case` locale; field lines slot in
 * between the title and the closing tag.
 *
 * The two-line indent style mirrors the surrounding compiler's
 * suite-XML layout — `<detail>` and its children indent by two
 * spaces from the `<suite>` root; nested `<field>` content adds
 * two more.
 *
 * When `searchAction` is supplied (the case-target detail of a
 * search-enabled module), an `<action>` element is appended after
 * the `<field>` block. The action mounts only on the case target;
 * search-target details never carry an action child, so the
 * caller passes `searchAction: undefined` for the search target.
 */
function emitDetailShell(
	detailId: string,
	fields: readonly string[],
	searchAction: SearchActionContext | undefined,
	moduleIndex: number,
): string {
	const titleBlock = [
		`    <title>`,
		`      <text>`,
		`        <locale id="cchq.case"/>`,
		`      </text>`,
		`    </title>`,
	].join("\n");

	const actionBlock =
		searchAction !== undefined
			? emitSearchActionBlock(searchAction, moduleIndex)
			: undefined;

	const bodyLines: string[] = [titleBlock];
	if (fields.length > 0) {
		bodyLines.push(fields.join("\n"));
	}
	if (actionBlock !== undefined) {
		bodyLines.push(actionBlock);
	}

	return [
		`  <detail id="${detailId}">`,
		bodyLines.join("\n"),
		`  </detail>`,
	].join("\n");
}

/**
 * Compose the `<action>` element CCHQ mounts on `m{N}_case_short`
 * when the module has a case-search config. The element renders as
 * the search button at the top of the case list. CCHQ's runtime
 * fires the action's `<stack>` push frame to navigate into the
 * search command (`search_command.{m}`) when the user activates
 * the action.
 *
 * The `auto_launch` attribute carries an XPath expression. CCHQ's
 * convention from `details.py::AUTO_LAUNCH_EXPRESSIONS`: `false()`
 * when off; the single-select expression `$next_input = '' or
 * count(instance('casedb')/casedb/case[@case_id=$next_input]) = 0`
 * when on. Nova emits the single-select form because Nova's
 * authoring surface does not expose multi-select case selection
 * (the multi-select wire shape is a CCHQ-specific runtime
 * affordance).
 *
 * `redo_last="false"` ships unconditionally. CCHQ's
 * `commcare-hq/corehq/apps/app_manager/suite_xml/sections/details.py::DetailContributor._get_action_kwargs`
 * binds `redo_last` to its `in_search` parameter; the `<action>`
 * here mounts only on the case-target detail
 * (`m{N}_case_short`), where `in_search=False`. Verified against
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml::detail[@id='m0_case_short']/action`.
 */
function emitSearchActionBlock(
	searchAction: SearchActionContext,
	moduleIndex: number,
): string {
	const moduleId = `m${moduleIndex}`;
	const autoLaunchExpr = searchAction.autoLaunch
		? AUTO_LAUNCH_SINGLE_SELECT_EXPR
		: "false()";
	// `relevant` carries the search-button display-condition predicate
	// when authored. The on-device XPath emitter produces the wire
	// string the runtime evaluates against the casedb / session
	// instances; the attribute escapes for XML attribute-value
	// embedding so any inner string literal containing `<` / `>` /
	// `"` stays well-formed.
	const relevantAttr =
		searchAction.displayCondition !== undefined
			? ` relevant="${escapeXml(emitCaseListFilter(searchAction.displayCondition))}"`
			: "";
	return [
		`    <action auto_launch="${autoLaunchExpr}" redo_last="false"${relevantAttr}>`,
		`      <display>`,
		`        <text>`,
		`          <locale id="case_search.${moduleId}"/>`,
		`        </text>`,
		`      </display>`,
		`      <stack>`,
		`        <push>`,
		`          <mark/>`,
		`          <command value="'search_command.${moduleId}'"/>`,
		`        </push>`,
		`      </stack>`,
		`    </action>`,
	].join("\n");
}
