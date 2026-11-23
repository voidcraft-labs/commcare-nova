// lib/commcare/suite/case-list/longDetail.ts
//
// Suite-XML emission for the case-list long detail —
// `<detail id="m{n}_<target>_long">`. Walks
// `module.caseListConfig.columns`, filters by `column.visibleInDetail`
// (absent ≡ visible), and concatenates one `<field>` per surviving
// column into the surrounding `<detail>` shell.
//
// One emitter, two targets. The `target` parameter
// (`"case"` / `"search"`) selects which of the two CCHQ wire ids
// the same `caseListConfig` projects onto. The case-rooted block
// renders against `instance('casedb')`; the search-rooted block
// renders against `instance('results')`. Calc-column cross-case
// references rewrite their root accordingly. The canonical fixture
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml`
// pins the structural identity between `m0_case_long` and
// `m0_search_long`.
//
// Per-column wire shape lives in `columns.ts`. Long-detail
// divergences flow through the `CaseListEmitContext.detailKind`
// discriminator:
//
//   - Locale ids carry the `case_long` substring per CCHQ's
//     `commcare-hq/corehq/apps/app_manager/id_strings.py::detail`
//     helper.
//
//   - `<sort>` blocks are suppressed on the non-nodeset long
//     detail per CCHQ's
//     `commcare-hq/corehq/apps/app_manager/detail_screen.py::FormattedDetailColumn.sort_node`
//     short-circuit. The canonical fixture
//     `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml::<detail id="m0_case_long">`
//     confirms zero `<sort>` blocks despite a multi-key sort active
//     on the parent module's short detail.
//
//   - `phone` columns emit `<template form="phone">` per
//     `detail_screen.py::Phone.template_form` — verified at
//     `commcare-hq/corehq/apps/app_manager/tests/data/suite/normal-suite.xml::<detail id="m0_case_long">`'s
//     phone field.
//
// Fields walk the config's exact Details UUID permutation,
// so rearranging Results cannot disturb the confirmation screen. Position
// counter convention: the 1-based position passed to the per-column header-
// locale composer is the field's index among the columns Details shows plus
// one: the long detail HQ JSON stores holds those alone
// (`hqJson/caseList.ts::projectCaseListForHq`), and HQ's build numbers each
// by its index in the stored detail (`column.id + 1` in
// `commcare-hq/corehq/apps/app_manager/id_strings.py::detail_column_header_locale`,
// over `models/case_list.py::Detail.get_columns`).
//
// The compiler owns the shared cchq.case title locale in every app-string
// table. Core has no ambient mapping for this id.

import type { Element } from "domhandler";
import { el, xel } from "@/lib/commcare/elementBuilders";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import { serializeXml } from "@/lib/commcare/serializeXml";
import {
	type InstanceDecl,
	InstanceSink,
} from "@/lib/commcare/xpath/wire/instances";
import {
	type BlueprintDoc,
	effectiveCaseTypes,
	type Module,
	orderedColumns,
	type TranslationUnitId,
	type Uuid,
} from "@/lib/domain";
import { caseColumnRestingKey } from "@/lib/domain/caseListOrder";
import { detailTabForColumn, detailTabSpans } from "@/lib/domain/detailTabs";
import { detailColumnRowScope } from "@/lib/domain/expression/detailRowScope";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import { moduleExpressionContexts } from "../../expressionContext";
import { detailTabVariableNames } from "../../formLinkProjection";
import { lookupTypeIndexFromNaming } from "../../lookup/naming";
import type { AssetManifest } from "../../multimedia/assetWirePath";
import type { ColumnFieldWordOf } from "../../wireIdentity";
import { w } from "../../xpath/wire/builders";
import { serializeWire } from "../../xpath/wire/serialize";
import { columnPropertyPath } from "../wire";
import {
	buildColumnField,
	mergeFieldStrings,
	suiteMappingCondition,
} from "./columns";
import { detailBindings } from "./detailBindings";
import { detailTabConditionWire } from "./detailTabCondition";
import { detailTabOrderPriorities } from "./detailTabOrder";
import { detailTabRowNodes } from "./detailTabRows";
import { withDetailLoadBehavior } from "./optimizations";
import { columnProperty, columnStoredAsExpression } from "./orderPlanOptions";
import { keyDirective, type ResolvedSortDirective } from "./sortKeys";
import type {
	CaseListEmission,
	CaseListEmitContext,
	DetailTarget,
} from "./types";

/**
 * Empty sort-directive map for long-detail emission. The long-detail
 * surface emits no `<sort>` blocks regardless of authored sort
 * directives, so wiring a sort lookup map at this layer would just
 * burn cycles for an answer the per-column emitter ignores. The
 * `CaseListEmitContext` shape carries the slot uniformly across
 * surfaces; long detail passes this empty map and the per-column
 * emitter's long-detail short-circuit guards the unused lookup.
 */
const EMPTY_SORT_DIRECTIVES: ReadonlyMap<Uuid, ResolvedSortDirective> =
	new Map();

/**
 * Compose the suite-XML `<detail>` block for one module's case-list
 * long detail. Returns the concatenated XML plus the locale-id →
 * header-string map the surrounding compiler threads into
 * `app_strings.txt`.
 *
 * `doc` is accepted as part of the uniform per-detail emission
 * surface — both short and long detail emitters take the same
 * arg shape. Long detail doesn't read it (no sort directives, no
 * per-property type lookup needed for the non-nodeset case) but
 * the symmetry simplifies the compiler's call site.
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
export function buildLongDetail(args: {
	readonly module: Module;
	readonly moduleIndex: number;
	readonly doc: BlueprintDoc;
	readonly target?: DetailTarget;
	/** The case-target rows' source; see `CaseListEmitContext.caseSource`. */
	readonly caseSource?: CaseListEmitContext["caseSource"];
	readonly assets?: AssetManifest;
	readonly lookupNaming?: LookupWireNaming;
	/** The word the archive's target keeps each column's property under (`CaseListEmitContext.columnFieldWord`). */
	readonly columnFieldWord?: ColumnFieldWordOf;
}): {
	readonly element: Element;
	readonly strings: Record<string, string>;
	readonly translationUnits: Record<string, TranslationUnitId>;
	readonly instances: readonly InstanceDecl[];
	readonly conditionReads: readonly InstanceDecl[];
} {
	const { module: mod, moduleIndex } = args;
	const target: DetailTarget = args.target ?? "case";
	const detailId = `m${moduleIndex}_${target}_long`;
	const instances = new InstanceSink();
	const detailConditionReads = new InstanceSink();

	// Early-exit shape: no caseListConfig OR no case type. The
	// resulting detail still carries a title — CCHQ's
	// `commcare-hq/corehq/apps/app_manager/suite_xml/xml_models.py::Detail`
	// model declares `title` as a non-optional `NodeField`, so a
	// zero-field detail still emits the `<title>` element.
	if (!mod.caseType || !mod.caseListConfig) {
		return {
			element: buildDetailShell(detailId, []),
			strings: {},
			translationUnits: {},
			instances: [],
			conditionReads: [],
		};
	}

	const config = mod.caseListConfig;
	const caseTypes = effectiveCaseTypes(args.doc);
	const caseProperties =
		caseTypes.find((type) => type.name === mod.caseType)?.properties ?? [];
	const ctx: CaseListEmitContext = {
		detailBindings: detailBindings(args.doc, mod),
		wire: { mode: { target: "suite" }, instances },
		moduleIndex,
		sortByUuid: EMPTY_SORT_DIRECTIVES,
		detailKind: "long",
		optimizations: config.optimizations === true,
		detailTile: config.detailTile,
		target,
		...(args.caseSource !== undefined && { caseSource: args.caseSource }),
		caseProperties,
		caseType: mod.caseType,
		caseTypes,
		proseDoc: args.doc,
		expressions: moduleExpressionContexts(
			args.doc,
			mod.uuid,
			args.lookupNaming,
		),
		...(args.assets && { assets: args.assets }),
		...(args.lookupNaming && { lookupNaming: args.lookupNaming }),
		...(args.columnFieldWord && { columnFieldWord: args.columnFieldWord }),
	};

	const fields: Element[] = [];
	const strings: Record<string, string> = {};
	const translationUnits: Record<string, TranslationUnitId> = {};

	// Walk every column in the config's exact Details UUID permutation,
	// independently of Results. Position is 1-based among the columns Details
	// shows, the stored long detail HQ's build numbers its header locales by.
	// Visibility filter: absent slot ≡ visible. The schema preserves the
	// slot's presence so the editor can distinguish "user explicitly toggled
	// off" from "user never toggled".
	const shownColumns = orderedColumns(config, "detail").filter(
		(column) => column.visibleInDetail !== false,
	);
	const lookupTypes = lookupTypeIndexFromNaming(args.lookupNaming);
	const priorities = new Map(
		config.detailTabs?.map((tab) => [
			tab.uuid,
			detailTabOrderPriorities(
				tab,
				mod,
				args.doc,
				args.lookupNaming,
				args.columnFieldWord,
			),
		]),
	);
	for (let i = 0; i < shownColumns.length; i++) {
		const column = shownColumns[i];
		const owner = detailTabForColumn(config, column.uuid);
		const row = detailColumnRowScope(args.doc, mod, column, lookupTypes);
		const child = row?.kind === "case" ? row.caseType : undefined;
		const onDataTab = owner?.rowSource !== undefined && !config.detailTile;
		const hidden = !!(onDataTab && owner.orderFields?.includes(column.uuid));
		const priority = onDataTab
			? priorities.get(owner.uuid)?.get(column.uuid)
			: undefined;
		const { restingKey, restingComparator } = caseColumnRestingKey(
			column,
			!onDataTab || hidden,
			(c) => columnProperty(c, { caseType: child ?? mod.caseType }, caseTypes),
			args.assets !== undefined,
		);
		const directive =
			priority === undefined
				? restingKey &&
					// A data tab's rows are cases of the device's case database.
					keyDirective(
						restingKey,
						column,
						{ type: restingComparator },
						"casedb",
						(uuid, entry, field) =>
							suiteMappingCondition(uuid, entry, field, ctx),
					)
				: {
						...(column.kind === "calculated" || columnStoredAsExpression(column)
							? { kind: "calculated" as const }
							: {
									kind: "property" as const,
									xpath: columnPropertyPath(column),
								}),
						type: "text" as const,
						direction: "asc" as const,
						order: priority,
					};
		const emission = buildColumnField({
			column,
			position: i + 1,
			hidden,
			ctx: {
				...ctx,
				...(child && {
					caseType: child,
					caseProperties:
						caseTypes.find((type) => type.name === child)?.properties ?? [],
				}),
				...(directive && { sortByUuid: new Map([[column.uuid, directive]]) }),
			},
		});

		fields.push(emission.element);
		mergeFieldStrings(strings, translationUnits, emission);
	}

	let children = fields;
	if (config.detailTabs) {
		const spans = detailTabSpans(config.detailTabs, shownColumns);
		if (!spans)
			throw new Error("The detail tabs do not cover the fields shown.");
		children = spans.map(({ tab, start, end }, index) => {
			const locale = `m${moduleIndex}.${target}_long.tab.${index + 1}.title`;
			strings[locale] = tab.title;
			translationUnits[locale] = makeTranslationUnitId(
				"detail-tab",
				tab.uuid,
				"title",
			);
			const relevant =
				tab.displayCondition &&
				detailTabConditionWire(
					tab.displayCondition,
					tab.uuid,
					ctx.expressions,
					"suite",
					target === "search" ? "results" : (ctx.caseSource ?? "casedb"),
					args.lookupNaming,
					ctx.detailBindings,
				);
			return xel(
				"detail",
				{
					xpath: {
						relevant,
						nodeset: detailTabRowNodes(
							tab,
							ctx.caseSource ?? (target === "search" ? "results" : "casedb"),
							ctx.expressions,
							args.lookupNaming,
							ctx.detailBindings,
						),
					},
				},
				{ mode: { target: "suite" }, instances, detailConditionReads },
				[
					el("title", {}, [el("text", {}, [el("locale", { id: locale })])]),
					...fields.slice(start, end),
				],
			);
		});
		const names = detailTabVariableNames(args.doc, mod.uuid);
		if (names.length > 0) {
			const relativeId = serializeWire(
				w.context([w.self(), w.attr("case_id")]),
				{ target: "suite" },
			).text;
			children.push(
				el(
					"variables",
					{},
					names.map((name) => el(name, { function: relativeId })),
				),
			);
		}
	}
	return {
		element: withDetailLoadBehavior(
			buildDetailShell(detailId, children),
			config,
			config.columns.filter((column) => column.visibleInDetail !== false),
		),
		strings,
		translationUnits,
		instances: instances.declarations(),
		conditionReads: detailConditionReads.declarations(),
	};
}

/**
 * String adapter — serializes `buildLongDetail`'s Element for callers
 * that assert against the rendered XML string (the test surface).
 * `compileCcz` itself calls `buildLongDetail` directly.
 */
export function emitLongDetail(args: {
	readonly module: Module;
	readonly moduleIndex: number;
	readonly doc: BlueprintDoc;
	readonly target?: DetailTarget;
}): CaseListEmission {
	const { element, strings, translationUnits, instances } =
		buildLongDetail(args);
	return { xml: serializeXml(element), strings, translationUnits, instances };
}

/**
 * Build the surrounding `<detail>` Element. The title routes through
 * the compiler-registered `cchq.case` locale; the field Elements slot in between
 * the title and the closing tag.
 */
function buildDetailShell(
	detailId: string,
	fields: readonly Element[],
): Element {
	const titleEl = el("title", {}, [
		el("text", {}, [el("locale", { id: "cchq.case" })]),
	]);
	return el("detail", { id: detailId }, [titleEl, ...fields]);
}
