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
//   - `<title>` references `<locale id="cchq.case"/>`. Nova's compiler
//     registers its value in every emitted app-string table. HQ independently
//     adds the same id when it generates its app strings.
//
//   - One `<field>` per field of the list's order plan
//     (`lib/domain/caseListOrder.ts::caseListOrderPlan`), in the config's
//     exact Results UUID permutation: every column of a list with no tile
//     layout, a column hidden from Results as HQ's `invisible` field, and
//     in a tile list the columns shown on Results. Then one field per
//     carrier, the hidden sort field HQ appends for a rule no stored column
//     takes.
//
// The `<sort>` blocks are resolved once from the plan by
// `sortKeys.ts::planSortNodes` and threaded through the per-column
// emitter via `CaseListEmitContext.sortByUuid`. The per-column emitter
// looks up its directive by `column.uuid` and emits the matching `<sort>`
// block on short detail.
//
// Position counter convention: the 1-based position passed to the
// per-column header-locale composer is the column's index in the complete
// Results-ordered source sequence plus one. Hiding a column renumbers no
// other — toggling `visibleInList` doesn't churn locale ids. Mirrors CCHQ's
// `commcare-hq/corehq/apps/app_manager/id_strings.py::detail_column_header_locale`'s
// `column.id`-keyed numbering convention.
//
// The compiler owns the shared title locale; this emitter returns column
// strings only. Core has no ambient cchq.case mapping.
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

import type { Element } from "domhandler";
import {
	el,
	type WireElementContext,
	xel,
} from "@/lib/commcare/elementBuilders";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import { serializeXml } from "@/lib/commcare/serializeXml";
import { w } from "@/lib/commcare/xpath/wire/builders";
import { toWire } from "@/lib/commcare/xpath/wire/fromExpression";
import {
	caseDbInstance,
	type InstanceDecl,
	InstanceSink,
} from "@/lib/commcare/xpath/wire/instances";
import type { WireExpr } from "@/lib/commcare/xpath/wire/tree";
import {
	type BlueprintDoc,
	type CaseTileGrouping,
	effectiveCaseTypes,
	type Module,
	orderedColumns,
	type TranslationUnitId,
} from "@/lib/domain";
import { simplifyForEmission } from "@/lib/domain/expression";
import type { Expression } from "@/lib/domain/expression/types";
import {
	type ModuleExpressionContexts,
	moduleExpressionContexts,
} from "../../expressionContext";
import type { AssetManifest } from "../../multimedia/assetWirePath";
import { buildCarrierField, buildColumnField } from "./columns";
import {
	EMPTY_CASE_LIST_TEXT,
	emptyCaseListTextLocaleId,
	SELECT_TEXT,
	selectTextLocaleId,
} from "./detailTexts";
import { moduleCaseListOrderPlan } from "./orderPlanOptions";
import { planSortNodes } from "./sortKeys";
import { buildTileGroupElement } from "./tileGroup";
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
	readonly displayCondition?: Expression;
}

/**
 * The Register action CCHQ mounts on `m{N}_case_short` for a module's
 * `case_list_form` (`DetailContributor.get_case_list_form_action`): it
 * pushes the target form's command, the target entry's computed datums,
 * and `return_to`. Nova emits it only for a search-first host, where its
 * relevancy reads the inline results instance, so the `relevant`
 * attribute is always present (HQ emits it under
 * `FOLLOWUP_FORMS_AS_CASE_LIST_FORM`, the capability the publish path
 * requires).
 */
export interface RegisterActionContext {
	/** `m{H}-f0`, the no-matches form's command in its hidden module. */
	readonly commandId: string;
	/** The target entry's non-selection datums, in entry order. */
	readonly datums: readonly { readonly id: string; readonly value: WireExpr }[];
	/** The `<action relevant>` XPath. */
	readonly relevant: WireExpr;
}

/**
 * The `auto_launch` XPath expression CCHQ uses for single-select
 * modules when auto-launch is enabled. Lifted verbatim from
 * `commcare-hq/corehq/apps/app_manager/suite_xml/sections/details.py::AUTO_LAUNCH_EXPRESSIONS["single-select"]`.
 * The `$next_input` reference is a session-scoped variable CCHQ's
 * runtime resolves at evaluation time; Nova represents the variable
 * with a closed tree arm because it is part of CCHQ's runtime
 * vocabulary, not Nova's authoring surface.
 */
const AUTO_LAUNCH_SINGLE_SELECT_EXPR = w.or(
	w.eq(w.nextInputVar(), w.str("")),
	w.eq(
		w.call("count", [
			w.instance(caseDbInstance(), [
				w.step("casedb"),
				w.step("case", [
					w.eq(w.context([w.attr("case_id")]), w.nextInputVar()),
				]),
			]),
		]),
		w.num(0),
	),
);

/**
 * Compose the suite-XML `<detail>` block for one module's case-list
 * short detail. Returns the concatenated XML plus the locale-id →
 * header-string map the surrounding compiler threads into
 * `app_strings.txt`.
 *
 * `doc` is the source `BlueprintDoc`. The order plan reads its case-type
 * catalog for each property's data type and select options, and type
 * checks calculated columns against the same admission set as the
 * validator (declared properties + writer-derived + standard).
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
export function buildShortDetail(args: {
	readonly module: Module;
	readonly moduleIndex: number;
	readonly doc: BlueprintDoc;
	readonly target?: DetailTarget;
	readonly searchAction?: SearchActionContext;
	/** The Register action of a search-first host with a no-matches form;
	 *  case target only, like `searchAction`. */
	readonly registerAction?: RegisterActionContext;
	/** The case-target rows' source; see `CaseListEmitContext.caseSource`. */
	readonly caseSource?: "casedb" | "results:inline";
	readonly assets?: AssetManifest;
	readonly lookupNaming?: LookupWireNaming;
	/**
	 * The target project space holds `USH_EMPTY_CASE_LIST_TEXT`, so the
	 * detail carries the empty-list text, as HQ's build of the same app
	 * there does.
	 */
	readonly emptyCaseListText?: boolean;
}): {
	readonly element: Element;
	readonly strings: Record<string, string>;
	readonly translationUnits: Record<string, TranslationUnitId>;
	readonly instances: readonly InstanceDecl[];
} {
	const { module: mod, moduleIndex, doc } = args;
	const target: DetailTarget = args.target ?? "case";
	const detailId = `m${moduleIndex}_${target}_short`;
	const instances = new InstanceSink();
	const wire: WireElementContext = { mode: { target: "suite" }, instances };
	const expressions = moduleExpressionContexts(
		doc,
		mod.uuid,
		args.lookupNaming,
	);

	// `<action>` lives only on the case-target detail per the
	// canonical fixture. A `searchAction` arg passed alongside
	// `target: "search"` would be a logic error at the orchestrator
	// (the search-target detail is the action's destination, not
	// its host); the emitter ignores the arg defensively.
	const searchAction = target === "case" ? args.searchAction : undefined;
	const registerAction = target === "case" ? args.registerAction : undefined;
	const texts = detailTexts(moduleIndex, args.emptyCaseListText === true);

	// Early-exit shape: no caseListConfig OR no case type. The
	// resulting detail still carries a title — CCHQ's
	// `commcare-hq/corehq/apps/app_manager/suite_xml/xml_models.py::Detail`
	// model declares `title` as a non-optional `NodeField`, so a
	// zero-field detail still emits the `<title>` element.
	if (!mod.caseType || !mod.caseListConfig) {
		return {
			element: buildDetailShell(
				detailId,
				[],
				searchAction,
				registerAction,
				undefined,
				texts.elements,
				moduleIndex,
				expressions,
				wire,
				args.lookupNaming,
			),
			strings: { ...texts.strings },
			translationUnits: {},
			instances: instances.declarations(),
		};
	}

	const config = mod.caseListConfig;
	const caseProperties =
		effectiveCaseTypes(doc).find((type) => type.name === mod.caseType)
			?.properties ?? [];
	const plan = moduleCaseListOrderPlan(
		mod,
		doc,
		args.assets !== undefined,
		args.lookupNaming,
	);
	const sortNodes = planSortNodes(plan);
	const ctx: CaseListEmitContext = {
		wire,
		moduleIndex,
		sortByUuid: sortNodes.byUuid,
		detailKind: "short",
		target,
		...(args.caseSource !== undefined && { caseSource: args.caseSource }),
		caseProperties,
		caseType: mod.caseType,
		proseDoc: doc,
		expressions,
		...(config.tile !== undefined && { tileLayout: config.tile }),
		...(args.assets && { assets: args.assets }),
		...(args.lookupNaming && { lookupNaming: args.lookupNaming }),
	};

	const fields: Element[] = [];
	const strings: Record<string, string> = { ...texts.strings };
	const translationUnits: Record<string, TranslationUnitId> = {};

	// Walk the plan's fields, which keep the config's exact Results UUID
	// permutation. A shown field's header locale keeps its 1-based position
	// in the complete Results sequence, so hiding a column renumbers no
	// other; a hidden field has no locale. Long detail deliberately uses its
	// independent Details order instead.
	const resultsPosition = new Map(
		orderedColumns(config, "list").map((column, index) => [
			column.uuid,
			index + 1,
		]),
	);
	for (const field of plan.fields) {
		const emission = buildColumnField({
			column: field.column,
			position: resultsPosition.get(field.column.uuid) ?? field.position + 1,
			ctx,
			hidden: field.hidden,
		});
		fields.push(emission.element);
		Object.assign(strings, emission.strings);
		Object.assign(translationUnits, emission.translationUnits);
	}
	for (const carrier of sortNodes.carriers) {
		fields.push(buildCarrierField(carrier.property, carrier.directive, wire));
	}

	return {
		element: buildDetailShell(
			detailId,
			fields,
			searchAction,
			registerAction,
			config.tile?.grouping,
			texts.elements,
			moduleIndex,
			expressions,
			wire,
			args.lookupNaming,
		),
		strings,
		translationUnits,
		instances: instances.declarations(),
	};
}

/**
 * String adapter — serializes `buildShortDetail`'s Element for callers
 * that assert against the rendered XML string (the test surface).
 * `compileCcz` itself calls `buildShortDetail` directly.
 */
export function emitShortDetail(args: {
	readonly module: Module;
	readonly moduleIndex: number;
	readonly doc: BlueprintDoc;
	readonly target?: DetailTarget;
	readonly searchAction?: SearchActionContext;
}): CaseListEmission {
	const { element, strings, translationUnits, instances } =
		buildShortDetail(args);
	return { xml: serializeXml(element), strings, translationUnits, instances };
}

/**
 * The texts HQ's build gives a short detail, with their app strings: the
 * select button's on every short detail, the empty list's where the target
 * holds `USH_EMPTY_CASE_LIST_TEXT`. Nova's own system copy, so every
 * language takes it verbatim.
 */
function detailTexts(
	moduleIndex: number,
	emptyCaseListText: boolean,
): {
	readonly elements: readonly Element[];
	readonly strings: Readonly<Record<string, string>>;
} {
	const selectId = selectTextLocaleId(moduleIndex);
	const emptyId = emptyCaseListTextLocaleId(moduleIndex);
	return {
		elements: [
			el("select_text", {}, [el("text", {}, [el("locale", { id: selectId })])]),
			...(emptyCaseListText
				? [
						el("no_items_text", {}, [
							el("text", {}, [el("locale", { id: emptyId })]),
						]),
					]
				: []),
		],
		strings: {
			[selectId]: SELECT_TEXT,
			...(emptyCaseListText && { [emptyId]: EMPTY_CASE_LIST_TEXT }),
		},
	};
}

/**
 * Build the surrounding `<detail>` Element. The title routes through
 * the compiler-registered `cchq.case` locale; the field Elements slot in between
 * the title and the optional `<action>`.
 *
 * When `searchAction` is supplied (the case-target detail of a
 * search-enabled module), an `<action>` Element is appended after the
 * `<field>` block. The action mounts only on the case target;
 * search-target details never carry an action child, so the caller
 * passes `searchAction: undefined` for the search target.
 *
 * `texts` (`detailTexts`) close the detail, where HQ's built suites hold
 * them: HQ assigns both after it builds the detail's fields, actions and
 * tile group (`DetailContributor.build_detail`).
 */
function buildDetailShell(
	detailId: string,
	fields: readonly Element[],
	searchAction: SearchActionContext | undefined,
	registerAction: RegisterActionContext | undefined,
	grouping: CaseTileGrouping | undefined,
	texts: readonly Element[],
	moduleIndex: number,
	expressions: ModuleExpressionContexts,
	wire: WireElementContext,
	lookupNaming?: LookupWireNaming,
): Element {
	const titleEl = el("title", {}, [
		el("text", {}, [el("locale", { id: "cchq.case" })]),
	]);
	const children: Element[] = [titleEl, ...fields];
	// HQ adds the register action before the search action
	// (`DetailContributor.build_detail`: `add_register_action`, then
	// `get_case_search_action`).
	if (registerAction !== undefined) {
		children.push(buildRegisterActionBlock(registerAction, moduleIndex, wire));
	}
	if (searchAction !== undefined) {
		children.push(
			buildSearchActionBlock(
				searchAction,
				moduleIndex,
				expressions,
				wire,
				lookupNaming,
			),
		);
	}
	if (grouping !== undefined)
		children.push(buildTileGroupElement(grouping, wire));
	children.push(...texts);
	return el("detail", { id: detailId }, children);
}

/**
 * The Register action's bytes, pinned to
 * `commcare-hq/corehq/apps/app_manager/tests/data/case_list_form/case-list-form-suite.xml`
 * plus the `relevant` partial of `tests/test_case_list_form.py`:
 * `<action relevant><display><text><locale id="case_list_form.m{N}"/></text></display>
 * <stack><push><command/><datum…/><datum id="return_to"/></push></stack></action>`.
 */
function buildRegisterActionBlock(
	action: RegisterActionContext,
	moduleIndex: number,
	wire: WireElementContext,
): Element {
	return xel("action", { xpath: { relevant: action.relevant } }, wire, [
		el("display", {}, [
			el("text", {}, [el("locale", { id: `case_list_form.m${moduleIndex}` })]),
		]),
		el("stack", {}, [
			el("push", {}, [
				xel("command", { xpath: { value: w.str(action.commandId) } }, wire),
				...action.datums.map((datum) =>
					xel(
						"datum",
						{ attributes: { id: datum.id }, xpath: { value: datum.value } },
						wire,
					),
				),
				xel(
					"datum",
					{
						attributes: { id: "return_to" },
						xpath: { value: w.str(`m${moduleIndex}`) },
					},
					wire,
				),
			]),
		]),
	]);
}

/**
 * Build the `<action>` Element CCHQ mounts on `m{N}_case_short` when
 * the module has a case-search config. The element renders as the
 * search button at the top of the case list. CCHQ's runtime fires the
 * action's `<stack>` push frame to navigate into the search command
 * (`search_command.{m}`) when the user activates the action.
 *
 * The `auto_launch` attribute carries an XPath expression. CCHQ's
 * convention from `details.py::AUTO_LAUNCH_EXPRESSIONS`: `false()`
 * when off; the single-select expression `$next_input = '' or
 * count(instance('casedb')/casedb/case[@case_id=$next_input]) = 0`
 * when on. Nova emits the single-select form because Nova's authoring
 * surface does not expose multi-select case selection (the
 * multi-select wire shape is a CCHQ-specific runtime affordance).
 *
 * `redo_last="false"` ships unconditionally. CCHQ's
 * `commcare-hq/corehq/apps/app_manager/suite_xml/sections/details.py::DetailContributor._get_action_kwargs`
 * binds `redo_last` to its `in_search` parameter; the `<action>` here
 * mounts only on the case-target detail (`m{N}_case_short`), where
 * `in_search=False`. Verified against
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml::detail[@id='m0_case_short']/action`.
 *
 * `relevant` carries the search-button display-condition predicate
 * when authored. The on-device XPath emitter produces the wire string
 * the runtime evaluates against the casedb / session instances; the
 * serializer handles attribute-value escaping at render time so the
 * raw XPath flows straight through.
 */
function buildSearchActionBlock(
	searchAction: SearchActionContext,
	moduleIndex: number,
	expressions: ModuleExpressionContexts,
	wire: WireElementContext,
	lookupNaming?: LookupWireNaming,
): Element {
	const moduleId = `m${moduleIndex}`;
	const autoLaunchExpr = searchAction.autoLaunch
		? AUTO_LAUNCH_SINGLE_SELECT_EXPR
		: w.call("false", []);

	// The single-select action's XPath attributes are distinct from its
	// literal redo_last flag.
	const actionExpressions: { auto_launch: WireExpr; relevant?: WireExpr } = {
		auto_launch: autoLaunchExpr,
	};
	if (searchAction.displayCondition !== undefined) {
		// `simplifyForEmission` strips any redundant boolean identity (a
		// `match-all` left inside an authored `and`) so the `relevant`
		// expression doesn't carry a `true() and …` conjunct — the same
		// normalize the filter surfaces + the HQ-JSON
		// `search_button_display_condition` apply.
		actionExpressions.relevant = toWire(
			simplifyForEmission(searchAction.displayCondition),
			{
				target: "suite",
				types: expressions({ slot: "search_button_display_condition" }),
				bindings:
					lookupNaming === undefined
						? {}
						: { lookup: { naming: lookupNaming, instanceScope: "suite" } },
			},
		);
	}

	return xel(
		"action",
		{ attributes: { redo_last: "false" }, xpath: actionExpressions },
		wire,
		[
			el("display", {}, [
				el("text", {}, [el("locale", { id: `case_search.${moduleId}` })]),
			]),
			el("stack", {}, [
				el("push", {}, [
					el("mark", {}),
					xel(
						"command",
						{ xpath: { value: w.str(`search_command.${moduleId}`) } },
						wire,
					),
				]),
			]),
		],
	);
}
