import { type RuntimeTarget, runtimeUrls } from "@/lib/commcare/runtimeTarget";
/**
 * After-submit links: the ONE projection both wire paths and the validator
 * read.
 *
 * A form's `formLinks` say where the app goes after the form is submitted:
 * the links are checked in order, the first whose condition holds is
 * followed, and `postSubmit` is where it goes when none does. CommCare has
 * no such notion. Its session stack executes EVERY `<create>` whose `if`
 * holds and lands on the LAST one pushed (`commcare-core
 * CommCareSession::executeStackOperations` / `::finishAndPop`), and
 * CommCare HQ emits each link's XPath as that link's raw `if`
 * (`workflow.py::EndOfFormNavigationWorkflow::_get_link_frame`). So "first
 * true wins" is something Nova has to BUILD: every link's guard carries the
 * negation of every conditional link before it, which makes the guards
 * mutually exclusive whatever the runtime does with several true frames.
 *
 * This module owns that construction and everything around it that the
 * local suite and the HQ JSON must agree on byte for byte:
 *
 *   - the guard plan (`planFormLinkGuards`): link i's guard is
 *     `(c_i) and not(c_1) and … and not(c_{i-1})` (the first link stays bare
 *     `c_1`, byte-identical to HQ's first frame; later positive operands are
 *     parenthesized so a top-level `or` cannot leak past the conjunction); a
 *     terminal unconditional link is the exhaustive else (`not(c_1) and …`)
 *     and suppresses the fallback frame; the fallback frame, when one is
 *     needed, is guarded by `not(g_1) and … and not(g_n)` over the EMITTED
 *     guards, which is the literal HQ derives (`::_get_fallback_frame`:
 *     `' and '.join(f'not({condition})' …)`) from the `xpath`s Nova sends it;
 *   - the frame children (`targetFrameChildren`): HQ's
 *     `WorkflowHelper.get_frame_children` exactly — module command, the
 *     longest common prefix (by datum id) of every form entry's datum list
 *     in the target module, the form command, then the target form's
 *     remaining datums; a flat module target is the module command alone,
 *     while a child-module target carries the root command path
 *     (`_frame_children_for_module(include_user_selections=False)`);
 *   - datum matching: HQ's `_get_datums_matched_to_source` /
 *     `_find_best_match` (first source datum in source order with the same
 *     case type: same id keeps the target id, a different id carries the
 *     source id) and `_get_datums_matched_to_manual_values` (every manual
 *     name lands on the target datum it names; a selection datum nobody
 *     names is what HQ raises on, and what Nova refuses at the gate);
 *   - the `previous` frame (`previousFrameChildren`): the source entry's own
 *     frame children with the last child popped, popping again while the
 *     child just popped was a non-selection datum (`WORKFLOW_PREVIOUS` arm
 *     of `::_get_static_stack_frame`) — so a registration form's frame loses
 *     its function datum AND its form command and lands on the module menu,
 *     while a followup in a forms-first module keeps `[m, m-f]`.
 *
 * One Core fact decides how strict the matching is. An unmatched selection
 * datum does NOT make the runtime prompt for it: HQ yields it as a
 * self-named session reference (`<datum id="case_id"
 * value="instance('commcaresession')/session/data/case_id"/>`), Core
 * raises when that session node is absent (`StackFrameStep.defineStep`). If
 * the node exists with an empty value, `CommCareSession.syncState` stores it
 * and `getFirstMissingDatum` only checks `containsKey`, so the target form
 * opens with an empty case id. Neither state prompts for a missing case. The projection therefore REPORTS every unmatched
 * selection datum (`unmatched` / `missing`) and the validator refuses the
 * document; the bytes are still total for parity's sake, but only links whose
 * frames resolve reach the wire.
 */

import { descendantFieldUuids, orderedFormUuids } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	caseSelectionCardinality,
	type DatumEntry,
	type DatumRef,
	datumRefKey,
	deriveCaseWriteInventory,
	type Expression,
	type FormLink,
	type FormLinkTarget,
	moduleParent,
	projectedModulePreorder,
	rootSelectionAlignment,
	type Uuid,
} from "@/lib/domain";
import { slotContext } from "@/lib/domain/expression/context";
import { formStructure } from "@/lib/domain/expression/formStructure";
import type { FormExpressionSlotRef } from "@/lib/domain/expression/types";
import { caseTypeDepthMap } from "./caseTypeDepths";
import { caseWriteAdmissionIssues } from "./caseWriteAdmission";
import { CASE_TYPE_REGEX, XML_ELEMENT_NAME_REGEX } from "./constants";
import { moduleExpressionContexts } from "./expressionContext";
import { buildFormActions } from "./formActions";
import {
	type LookupWireNaming,
	lookupTypeIndexFromNaming,
} from "./lookup/naming";
import {
	deriveCaseSelectionDatum,
	deriveSessionDatums,
	newCaseIdDatumId,
	type SessionDatum,
	type StackQueryData,
	sessionDatumRequiresSelection,
} from "./session";
import { subcaseSessionDatumId } from "./subcaseWire";
import {
	buildInlineSearch,
	type InlineSearchEmission,
	inlineSearchQueryMetadata,
	moduleIsSearchFirst,
} from "./suite/case-search/inlineSearch";
import type { FormActions } from "./types";
import { USERCASE_DATUM_ID } from "./usercaseWire";
import type { AttachmentUrlTarget } from "./xform/captureUrlNode";
import { formNodeProjection } from "./xpath/formNodeProjection";
import { w } from "./xpath/wire/builders";
import { toWire, type WireTermBindings } from "./xpath/wire/fromExpression";
import { selectedCasesInstance, sessionInstance } from "./xpath/wire/instances";
import { caseById, casePropertyStep } from "./xpath/wire/rowScope";
import { serializeWire } from "./xpath/wire/serialize";
import type { WireExpr } from "./xpath/wire/tree";

// ── Frame vocabulary ─────────────────────────────────────────────────────

/**
 * One session datum as the frame algorithm sees it: HQ's
 * `WorkflowDatumMeta` (`id`, `requires_selection`, `case_type`, `function`).
 */
export interface FrameDatum {
	readonly id: string;
	/** A nodeset datum the person selects; a function datum is computed. */
	readonly requiresSelection: boolean;
	readonly maximum?: number;
	/** The case type the datum selects or creates; absent when it has none. */
	readonly caseType?: string;
	/** Stable Preview bridge for a selectable datum after root alignment and
	 * frame-prefix projection. This is internal provenance, never suite wire. */
	readonly selectionSourceModuleUuid?: Uuid;
	/** The XPath a function datum evaluates (`uuid()`). */
	readonly function?: WireExpr;
	/** HQ `WorkflowDatumMeta.from_parent_module`: this datum was copied from
	 * the root module only as a child-entry placeholder. It is emitted in the
	 * entry but cannot automatically satisfy an after-submit target. */
	readonly fromParentModule?: true;
	/**
	 * Re-renders `function` with every `instance('commcaresession')/session/data/<id>`
	 * it reads supplied by the caller — how the grouped-tile companion datum
	 * follows HQ's `_replace_session_references_in_stack` without reading
	 * XPath back out of a string.
	 */
	readonly renderFunction?: (
		sessionRef: (datumId: string) => WireExpr,
	) => WireExpr;
	readonly renderFormLinkFunction?: SessionDatum["renderFormLinkFunction"];
	/**
	 * Present on the `<query>` session child of a search-first module (HQ
	 * `WorkflowQueryMeta`). `id` is the storage instance; `caseType` is the
	 * module's; `requiresSelection` is HQ's `not prompts and default_search`.
	 */
	readonly query?: {
		/** The datum that reads the results, whose session value the frame's
		 *  query fetches (`source_id`). */
		readonly nextDatumId: string;
		readonly caseFixtureUrl: string;
		/** Whether that datum is a multiple selection (`instance-datum`). */
		readonly nextDatumIsCollection: boolean;
	};
}

export type FrameChild =
	| { readonly type: "command"; readonly id: string }
	| { readonly type: "datum"; readonly datum: FrameDatum };

/** A frame child after matching: what the `<create>` carries. */
export type MatchedChild =
	| { readonly type: "command"; readonly id: string }
	| {
			readonly type: "datum";
			readonly id: string;
			readonly value: WireExpr;
	  }
	/** HQ `WorkflowQueryMeta.to_stack_datum`: fetch the selected case into
	 *  a search-first module's results instance before its datum reads it. */
	| {
			readonly type: "query";
			readonly id: string;
			readonly value: string;
			readonly data: readonly StackQueryData[];
	  };

/** `instance('commcaresession')/session/data/<id>`, HQ's `session_var`. */
export function sessionDataRef(datumId: string): WireExpr {
	return w.instance(sessionInstance(), [
		w.step("session"),
		w.step("data"),
		w.step(datumId),
	]);
}

/** Compare projected values under the same session wire target. */
function formLinkValueText(value: WireExpr): string {
	return serializeWire(value, { target: "suite" }).text;
}

// ── Context ──────────────────────────────────────────────────────────────

/**
 * What the projection needs beyond the document: the sorted module / form
 * sequences (the suite's `m{i}` / `m{i}-f{j}` positions) and each form's
 * expanded actions (the datum list depends on which cases the form opens).
 */
export interface FormLinkProjectionContext {
	/** The authored owner survives wire-only placement into a generated menu. */
	readonly expressionDoc: BlueprintDoc;
	/** Neutral task reads do not compile selector or query expressions. */
	readonly entryMetadataOnly: boolean;
	readonly onParentSelectionConflict?: (moduleUuid: Uuid) => void;
	/** Export-only observer of an HQ root alignment that would bypass a bound. */
	readonly onHqSelectionBoundMismatch?: (
		issue: HqSelectionBoundMismatch,
	) => void;
	readonly runtimeTarget?: RuntimeTarget;
	readonly moduleOrder: readonly Uuid[];
	readonly formOrder: Readonly<Record<string, readonly Uuid[]>>;
	readonly formActions: (formUuid: Uuid) => FormActions;
	/**
	 * Where a capture's case-bound link resolves, as the context's caller
	 * hands it to the emitter (`expandDoc`'s `attachmentTarget`); null writes
	 * no link. A question about the form's case writes reads it here, so it
	 * cannot be asked against a different target than the actions were.
	 */
	readonly attachmentTarget: AttachmentUrlTarget | null;
	readonly lookupNaming?: LookupWireNaming;
	/** The running Preview's existing fallback when its worker row is absent. */
	readonly workerProperty?: WireTermBindings["workerProperty"];
	/** Entry datums by form, derived once per context: a form target's frame
	 *  reads every form of its module, once per link, once per pass. The
	 *  context is built over one immutable document, so the memo is sound. */
	readonly entryDatums: Map<Uuid, readonly SessionDatum[]>;
	/** The module whose menu selection supplies each selectable datum. Kept
	 * out of `SessionDatum` because it is projection provenance, never wire. */
	readonly selectionSourceModules: WeakMap<SessionDatum, Uuid>;
	readonly chainDatumIds: WeakMap<SessionDatum, string>;
	readonly alignedSelectionSources: WeakMap<SessionDatum, Uuid>;
	readonly tileGroupingSources: WeakMap<SessionDatum, Uuid>;
	readonly datumIds: Map<Uuid, readonly EntryDatumId[]>;
	/** Stable command identity for runtime projections; never emitted on wire. */
	readonly commandTargets: WeakMap<
		FrameChild,
		{ moduleUuid: Uuid; formUuid?: Uuid }
	>;
	/** Root-computed datums copied into a child entry by `add_parent_datums`.
	 * Weak provenance keeps the session wire object unchanged. */
	readonly fromParentModuleDatums: WeakSet<SessionDatum>;
	/** Each search-first module's inline search, built once per context. */
	readonly inlineSearches: Map<Uuid, InlineSearchEmission>;
	/** The datum each placed `<query>` feeds (HQ `WorkflowQueryMeta.next_datum`). */
	readonly queryNextDatums: WeakMap<SessionDatum, SessionDatum>;
}

export interface HqSelectionBoundMismatch {
	readonly moduleUuid: Uuid;
	readonly sourceModuleUuid: Uuid;
	readonly targetModuleUuid: Uuid;
	readonly sourceMaximum: number;
	readonly targetMaximum: number;
}

/**
 * The case type a module's forms act on, or `""` when the module has none:
 * a case type is "in play" when the module owns one AND either browses cases
 * without forms or carries at least one non-survey form. The expander gates
 * `buildFormActions` on this and the compiler gates the entry's case datum
 * on it, so the projection must read the same answer.
 */
export function moduleCaseTypeForActions(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): string {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined || !mod.caseType) return "";
	const formUuids = doc.formOrder[moduleUuid] ?? [];
	const hasCases =
		mod.caseListOnly === true ||
		formUuids.some((formUuid) => doc.forms[formUuid]?.type !== "survey");
	return hasCases ? mod.caseType : "";
}

export function formLinkProjectionContext(
	doc: BlueprintDoc,
	opts: {
		readonly expressionDoc?: BlueprintDoc;
		readonly entryMetadataOnly?: boolean;
		readonly onParentSelectionConflict?: (moduleUuid: Uuid) => void;
		readonly onHqSelectionBoundMismatch?: (
			issue: HqSelectionBoundMismatch,
		) => void;
		readonly runtimeTarget?: RuntimeTarget;
		readonly attachmentTarget?: AttachmentUrlTarget | null;
		readonly lookupNaming?: LookupWireNaming;
		readonly workerProperty?: WireTermBindings["workerProperty"];
		/** Already-expanded actions, when the caller has them (the compiler). */
		readonly formActions?: (formUuid: Uuid) => FormActions;
	} = {},
): FormLinkProjectionContext {
	const moduleOrder = projectedModulePreorder(doc);
	const formOrder: Record<string, readonly Uuid[]> = {};
	const moduleOf = new Map<Uuid, Uuid>();
	for (const moduleUuid of moduleOrder) {
		const formUuids = orderedFormUuids(doc, moduleUuid);
		formOrder[moduleUuid] = formUuids;
		for (const formUuid of formUuids) moduleOf.set(formUuid, moduleUuid);
	}
	const cache = new Map<Uuid, FormActions>();
	const formActions =
		opts.formActions ??
		((formUuid: Uuid): FormActions => {
			const held = cache.get(formUuid);
			if (held !== undefined) return held;
			const moduleUuid = moduleOf.get(formUuid);
			const built = buildFormActions(
				doc,
				formUuid,
				moduleUuid === undefined
					? undefined
					: moduleCaseTypeForActions(doc, moduleUuid),
				opts.attachmentTarget ?? null,
				moduleUuid === undefined
					? "single"
					: caseSelectionCardinality(doc.modules[moduleUuid]),
			);
			cache.set(formUuid, built);
			return built;
		});
	return {
		expressionDoc: opts.expressionDoc ?? doc,
		entryMetadataOnly: opts.entryMetadataOnly === true,
		...(opts.onParentSelectionConflict && {
			onParentSelectionConflict: opts.onParentSelectionConflict,
		}),
		...(opts.onHqSelectionBoundMismatch !== undefined && {
			onHqSelectionBoundMismatch: opts.onHqSelectionBoundMismatch,
		}),
		runtimeTarget: opts.runtimeTarget,
		moduleOrder,
		formOrder,
		formActions,
		attachmentTarget: opts.attachmentTarget ?? null,
		...(opts.lookupNaming !== undefined && { lookupNaming: opts.lookupNaming }),
		...(opts.workerProperty === undefined
			? {}
			: { workerProperty: opts.workerProperty }),
		entryDatums: new Map(),
		selectionSourceModules: new WeakMap(),
		chainDatumIds: new WeakMap(),
		alignedSelectionSources: new WeakMap(),
		tileGroupingSources: new WeakMap(),
		datumIds: new Map(),
		commandTargets: new WeakMap(),
		fromParentModuleDatums: new WeakSet(),
		inlineSearches: new Map(),
		queryNextDatums: new WeakMap(),
	};
}

/**
 * The inline search of a search-first module, or `undefined` for any
 * other module. The compiler reads it for the strings; the datum
 * projection places its `<query>`.
 */
export function inlineSearchFor(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
): InlineSearchEmission | undefined {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined || !moduleIsSearchFirst(mod)) return undefined;
	const held = ctx.inlineSearches.get(moduleUuid);
	if (held !== undefined) return held;
	const parentUuid = parentSelectModuleUuid(doc, moduleUuid);
	const ancestorCaseType =
		parentUuid === undefined ? undefined : doc.modules[parentUuid]?.caseType;
	const built = buildInlineSearch({
		runtimeTarget: ctx.runtimeTarget,
		module: mod,
		moduleIndex: moduleIndexOf(ctx, moduleUuid),
		expressions: moduleExpressionContexts(doc, mod.uuid, ctx.lookupNaming),
		lookupNaming: ctx.lookupNaming,
		...(ancestorCaseType !== undefined && { ancestorCaseType }),
		datumId: caseListStepDatumId(ctx.expressionDoc, moduleUuid),
	});
	ctx.inlineSearches.set(moduleUuid, built);
	return built;
}

/**
 * HQ's `add_remote_query_datums`: a search-first module's `<query>` goes
 * immediately before every selection datum that module supplies. Runs
 * after root-menu alignment, as HQ's does, so the datum the query names
 * carries its final id.
 */
function withInlineSearchQueries(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	datums: readonly SessionDatum[],
): SessionDatum[] {
	const out: SessionDatum[] = [];
	for (const datum of datums) {
		const sourceUuid = ctx.selectionSourceModules.get(datum);
		const query =
			!sessionDatumRequiresSelection(datum) || sourceUuid === undefined
				? undefined
				: ctx.entryMetadataOnly
					? moduleIsSearchFirst(doc.modules[sourceUuid])
						? inlineSearchQueryMetadata(
								doc.modules[sourceUuid],
								moduleIndexOf(ctx, sourceUuid),
							)
						: undefined
					: inlineSearchFor(doc, ctx, sourceUuid)?.query;
		if (query !== undefined) {
			const queryDatum: SessionDatum = {
				id: query.storageInstance,
				caseType: query.caseType,
				query,
			};
			ctx.queryNextDatums.set(queryDatum, datum);
			out.push(queryDatum);
		}
		out.push(datum);
	}
	return out;
}

export function moduleIndexOf(
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
): number {
	const index = ctx.moduleOrder.indexOf(moduleUuid);
	if (index < 0) {
		throw new Error(
			`Cannot project a form link: target module ${moduleUuid} is missing`,
		);
	}
	return index;
}

function formIndexOf(
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid: Uuid,
): number {
	const index = (ctx.formOrder[moduleUuid] ?? []).indexOf(formUuid);
	if (index < 0) {
		throw new Error(
			`Cannot project a form link: target form ${formUuid} is missing from module ${moduleUuid}`,
		);
	}
	return index;
}

/** The module that owns `formUuid` in the projection's sequences. */
export function owningModuleOf(
	ctx: FormLinkProjectionContext,
	formUuid: Uuid,
): Uuid | undefined {
	for (const moduleUuid of ctx.moduleOrder) {
		if ((ctx.formOrder[moduleUuid] ?? []).includes(formUuid)) return moduleUuid;
	}
	return undefined;
}

// ── Frame datums and children ────────────────────────────────────────────

function toFrameDatum(
	datum: SessionDatum,
	ctx: Pick<
		FormLinkProjectionContext,
		| "selectionSourceModules"
		| "fromParentModuleDatums"
		| "queryNextDatums"
		| "runtimeTarget"
	>,
): FrameDatum {
	const selectionSourceModuleUuid = ctx.selectionSourceModules.get(datum);
	if (datum.query !== undefined) {
		const next = ctx.queryNextDatums.get(datum);
		return {
			id: datum.id,
			// HQ `WorkflowQueryMeta.requires_selection`: a query with nothing
			// to answer that runs on its own counts as a selecting step.
			requiresSelection: !datum.query.hasPrompts && datum.query.defaultSearch,
			caseType: datum.query.caseType,
			query: {
				nextDatumId: next?.id ?? datum.id,
				caseFixtureUrl: runtimeUrls(ctx.runtimeTarget).caseFixture,
				nextDatumIsCollection: next?.maxSelectValue !== undefined,
			},
		};
	}
	return {
		id: datum.id,
		requiresSelection: sessionDatumRequiresSelection(datum),
		...(datum.maxSelectValue !== undefined && {
			maximum: datum.maxSelectValue,
		}),
		...(datum.caseType !== undefined && { caseType: datum.caseType }),
		...(selectionSourceModuleUuid !== undefined && {
			selectionSourceModuleUuid,
		}),
		...(datum.function !== undefined && { function: datum.function }),
		...(ctx.fromParentModuleDatums.has(datum) && { fromParentModule: true }),
		...(datum.renderFunction !== undefined && {
			renderFunction: datum.renderFunction,
		}),
		...(datum.renderFormLinkFunction !== undefined && {
			renderFormLinkFunction: datum.renderFormLinkFunction,
		}),
	};
}

/** The authored parent-record selection, independent of menu nesting. */
export function parentSelectModuleUuid(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): Uuid | undefined {
	return doc.modules[moduleUuid]?.parentCaseModuleUuid;
}

function parentSelectChain(doc: BlueprintDoc, moduleUuid: Uuid): Uuid[] {
	const reverse: Uuid[] = [];
	const seen = new Set<Uuid>([moduleUuid]);
	let current = moduleUuid;
	while (true) {
		const parent = parentSelectModuleUuid(doc, current);
		if (parent === undefined || seen.has(parent)) break;
		seen.add(parent);
		reverse.push(parent);
		current = parent;
	}
	return reverse.reverse();
}

function selectableDatums(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formType: BlueprintDoc["forms"][string]["type"],
): SessionDatum[] {
	// HQ get_case_datums_basic_module selects this chain only for requires_case().
	// A catalog parent relationship does not make primary registration load a
	// parent; explicit child writes get their computed datums separately below.
	if (!CASE_LOADING_FORM_TYPES.has(formType)) return [];
	const chain = parentSelectChain(doc, moduleUuid);
	chain.push(moduleUuid);
	if (chain.length === 0) return [];

	const datums: SessionDatum[] = [];
	for (const [index, selectedModuleUuid] of chain.entries()) {
		const selectedModule = doc.modules[selectedModuleUuid];
		if (selectedModule === undefined || !selectedModule.caseType) continue;
		const remaining = chain.length - index - 1;
		const multiple = selectedModule.caseListConfig?.selection;
		const id =
			multiple?.kind === "multiple"
				? `${"parent_".repeat(remaining)}selected_cases`
				: remaining === 0
					? "case_id"
					: `${"parent_".repeat(remaining)}id`;
		const parentSelection = datums.at(-1);
		const moduleIndex = moduleIndexOf(ctx, selectedModuleUuid);
		// A case chosen earlier in this chain prints under the id its datum
		// holds when the nodeset renders: after root alignment, which renames
		// it, `refreshDatumReferences` renders again.
		const before = [...datums];
		const datumId = (ref: DatumRef): string | undefined =>
			ref.kind !== "selected-case"
				? undefined
				: before.find(
						(earlier) =>
							earlier.maxSelectValue === undefined &&
							(ctx.selectionSourceModules.get(earlier) === ref.module ||
								ctx.alignedSelectionSources.get(earlier) === ref.module),
					)?.id;
		const datum = deriveCaseSelectionDatum({
			datumId,
			entryMetadataOnly: ctx.entryMetadataOnly,
			id,
			caseType: selectedModule.caseType,
			moduleIndex,
			caseListFilter: selectedModule.caseListConfig?.filter,
			excludedOwnerIds: selectedModule.caseSearchConfig?.excludedOwnerIds,
			expressions: moduleExpressionContexts(
				doc,
				selectedModule.uuid,
				ctx.lookupNaming,
			),
			lookupNaming: ctx.lookupNaming,
			...(selectedModule.caseListConfig?.tile?.persistOnForms === true && {
				persistentDetailId: `m${moduleIndex}_case_short`,
			}),
			...(selectedModuleUuid === moduleUuid &&
			(selectedModule.caseListConfig?.columns ?? []).some(
				(column) => column.visibleInDetail !== false,
			)
				? { detailConfirm: true }
				: {}),
			...(parentSelection !== undefined && { parentSelection }),
			...(multiple?.kind === "multiple" && {
				maxSelectValue: multiple.maximum,
			}),
			...(moduleIsSearchFirst(selectedModule) && {
				caseSource: "results:inline" as const,
			}),
		});
		datum.parentSelection = parentSelection;
		ctx.selectionSourceModules.set(datum, selectedModuleUuid);
		ctx.chainDatumIds.set(datum, id);
		datums.push(datum);
	}
	return datums;
}

function refreshDatumReferences(datums: readonly SessionDatum[]): void {
	for (const datum of datums) {
		if (datum.renderNodeset !== undefined) {
			datum.nodeset = datum.renderNodeset(datum.parentSelection);
		}
		if (datum.renderFunction !== undefined) {
			datum.function = datum.renderFunction(sessionDataRef);
		}
	}
}

/** Mirror HQ's `add_parent_datums`: child entries live in the root menu's
 * session namespace, so collisions are renamed and same-case selections are
 * aligned to the parent's datum identity. Parent computed datums are carried
 * forward; unrelated parent selections are not. */
function alignWithRootMenu(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	entry: DatumEntry,
	current: SessionDatum[],
): SessionDatum[] {
	const alignment = rootSelectionAlignment(doc, entry);
	const parent = alignment.parentEntry;
	if (parent === undefined) return current;
	const parentDatums =
		parent.kind === "form"
			? entrySessionDatums(doc, ctx, parent.module, parent.form)
			: caseListSessionDatums(doc, ctx, parent.module);
	for (const issue of alignment.boundMismatches)
		ctx.onHqSelectionBoundMismatch?.(issue);
	if (alignment.parentSelectionConflict)
		ctx.onParentSelectionConflict?.(entry.module);
	if (parentDatums.length === 0) return current;
	const parentIds = new Set(parentDatums.map((datum) => datum.id));
	for (const datum of current) {
		if (parentIds.has(datum.id))
			datum.id = `${datum.id}_${datum.caseType ?? "child"}`;
	}
	const remaining = [...current];
	const prefix: SessionDatum[] = [];
	for (const parentDatum of parentDatums) {
		if (parentDatum.query !== undefined) continue;
		if (!sessionDatumRequiresSelection(parentDatum)) {
			const inherited = { ...parentDatum };
			ctx.fromParentModuleDatums.add(inherited);
			const grouping = ctx.tileGroupingSources.get(parentDatum);
			if (grouping !== undefined)
				ctx.tileGroupingSources.set(inherited, grouping);
			prefix.push(inherited);
			continue;
		}
		const source = ctx.selectionSourceModules.get(parentDatum);
		const pair = alignment.matches.find(
			(match) => match.sourceModuleUuid === source,
		);
		if (pair === undefined) continue;
		const matched = remaining[0];
		if (
			matched === undefined ||
			ctx.selectionSourceModules.get(matched) !== pair.targetModuleUuid
		) {
			throw new Error(
				"The session datum projection disagrees with the entry selection alignment.",
			);
		}
		remaining.shift();
		matched.id = parentDatum.id;
		ctx.alignedSelectionSources.set(matched, pair.sourceModuleUuid);
		prefix.push(matched);
	}
	const aligned = [...prefix, ...remaining];
	refreshDatumReferences(aligned);
	return aligned;
}

/** Complete root-aware session datum projection for one form entry. */
export function entrySessionDatums(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid: Uuid,
): readonly SessionDatum[] {
	const held = ctx.entryDatums.get(formUuid);
	if (held !== undefined) return held;
	const form = doc.forms[formUuid];
	const mod = doc.modules[moduleUuid];
	if (form === undefined || mod === undefined) return [];
	const caseType = moduleCaseTypeForActions(doc, moduleUuid);
	const selectionDatums = selectableDatums(doc, ctx, moduleUuid, form.type);
	const datums = deriveSessionDatums({
		expressions: moduleExpressionContexts(doc, moduleUuid, ctx.lookupNaming),
		formType: form.type,
		moduleIndex: moduleIndexOf(ctx, moduleUuid),
		...(caseType !== "" && { caseType }),
		caseSelectionDatums: selectionDatums,
		actions: ctx.formActions(formUuid),
		...(mod.caseListConfig?.tile?.grouping !== undefined && {
			tileGrouping: mod.caseListConfig.tile.grouping,
		}),
	});
	const ownSelection = [...selectionDatums]
		.reverse()
		.find((datum) => ctx.selectionSourceModules.get(datum) === moduleUuid);
	if (
		ownSelection !== undefined &&
		mod.caseListConfig?.tile?.grouping !== undefined
	) {
		const companion = datums.find(
			(datum) => datum.id === `${ownSelection.id}_parent_ids`,
		);
		if (companion !== undefined)
			ctx.tileGroupingSources.set(companion, moduleUuid);
	}
	const aligned = withInlineSearchQueries(
		doc,
		ctx,
		alignWithRootMenu(
			doc,
			ctx,
			{ kind: "form", module: moduleUuid, form: formUuid },
			datums,
		),
	);
	ctx.entryDatums.set(formUuid, aligned);
	return aligned;
}

/** A physical session datum and the domain identities it supplies. */
export interface EntryDatumId {
	readonly id: string;
	readonly chainId?: string;
	readonly refs: readonly DatumRef[];
	readonly scalar: boolean;
	readonly searchResults?: { readonly module: Uuid };
}

/** Resolve identities only from actual entry datums, after root alignment. */
export function entryDatumIds(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid?: Uuid,
): readonly EntryDatumId[] {
	if (formUuid !== undefined) {
		const held = ctx.datumIds.get(formUuid);
		if (held !== undefined) return held;
		if (owningModuleOf(ctx, formUuid) !== moduleUuid) return [];
	}
	const datums =
		formUuid === undefined
			? caseListSessionDatums(doc, ctx, moduleUuid)
			: entrySessionDatums(doc, ctx, moduleUuid, formUuid);
	const form = formUuid === undefined ? undefined : doc.forms[formUuid];
	const actions =
		formUuid === undefined ? undefined : ctx.formActions(formUuid);
	const caseType = moduleCaseTypeForActions(doc, moduleUuid);
	const opensCase =
		actions?.open_case.condition.type === "always" ||
		actions?.open_case.condition.type === "if";
	const childIds = new Map(
		(actions?.subcases ?? []).flatMap((subcase, index) =>
			subcase.repeat_context ||
			caseSelectionCardinality(doc.modules[moduleUuid]) === "multiple"
				? []
				: [
						[
							subcaseSessionDatumId(subcase, index, opensCase),
							subcase.case_type,
						] as const,
					],
		),
	);
	const rows = datums.map((datum): EntryDatumId => {
		const refs: DatumRef[] = [];
		const source = ctx.selectionSourceModules.get(datum);
		const aligned = ctx.alignedSelectionSources.get(datum);
		const grouping = ctx.tileGroupingSources.get(datum);
		if (sessionDatumRequiresSelection(datum) && source !== undefined) {
			refs.push({ kind: "selected-case", module: source });
			if (aligned !== undefined && aligned !== source)
				refs.push({ kind: "selected-case", module: aligned });
		} else if (datum.id === USERCASE_DATUM_ID) {
			refs.push({ kind: "worker-record" });
		} else if (grouping !== undefined) {
			refs.push({ kind: "tile-group-parents", module: grouping });
		} else if (
			form?.type === "registration" &&
			opensCase &&
			caseType !== "" &&
			datum.id === newCaseIdDatumId(caseType)
		) {
			refs.push({ kind: "new-case" });
		} else {
			const childType = childIds.get(datum.id);
			if (childType !== undefined)
				refs.push({ kind: "new-child-case", caseType: childType });
		}
		const queryNext = ctx.queryNextDatums.get(datum);
		const queryModule =
			queryNext === undefined
				? undefined
				: ctx.selectionSourceModules.get(queryNext);
		const chainId = ctx.chainDatumIds.get(datum);
		return {
			id: datum.id,
			...(chainId === undefined ? {} : { chainId }),
			refs,
			// A multi-select datum's value names a stored instance, and the
			// inline query's step holds the search's instances, not a value
			// `session/data/<id>` reads (`CommCareSession.java::setQueryDatum`).
			scalar: datum.maxSelectValue === undefined && datum.query === undefined,
			...(datum.query?.storageInstance === "results:inline" &&
			queryModule !== undefined
				? { searchResults: { module: queryModule } }
				: {}),
		};
	});
	if (formUuid !== undefined) ctx.datumIds.set(formUuid, rows);
	return rows;
}

export function entryDatumIdResolver(
	rows: readonly EntryDatumId[],
): (ref: DatumRef) => string | undefined {
	const ids = new Map(
		rows.flatMap((row) =>
			row.refs.map((ref) => [datumRefKey(ref), row.id] as const),
		),
	);
	return (ref) => ids.get(datumRefKey(ref));
}

/**
 * The datum ids a module's case list step prints, by ref: the rows its
 * case-list entry holds before the module's own selection datum (part 05
 * §1.3, "Evaluation points"). Every entry that reaches the list prints a
 * ref at one id wherever the checker admits the read (`differs` refuses the
 * rest), so the module's own entry speaks for all of them. `which` picks the
 * id after root alignment, which every carrier prints, or before it
 * (`chainId`), which HQ JSON's `case_details.short.filter` holds because
 * HQ's build renames it as it aligns.
 *
 * Built on first use over its own metadata-only projection, so a carrier
 * printed while the session projection runs never re-enters it.
 */
export function caseListStepDatumId(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	which: "id" | "chainId" = "id",
): (ref: DatumRef) => string | undefined {
	let ids: Map<string, string> | undefined;
	return (ref) => {
		if (ids === undefined) {
			const rows = entryDatumIds(
				doc,
				formLinkProjectionContext(doc, { entryMetadataOnly: true }),
				moduleUuid,
			);
			const own = rows.findLastIndex((row) =>
				row.refs.some(
					(entry) =>
						entry.kind === "selected-case" && entry.module === moduleUuid,
				),
			);
			ids = new Map(
				(own === -1 ? rows : rows.slice(0, own)).flatMap((row) =>
					row.refs.map(
						(entry) =>
							[
								datumRefKey(entry),
								which === "chainId" ? (row.chainId ?? row.id) : row.id,
							] as const,
					),
				),
			);
		}
		return ids.get(datumRefKey(ref));
	};
}

/** Selected own-case datum id used by XForm and form-condition carriers. */
export function selectedCaseDatumId(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid: Uuid,
): string | undefined {
	const ownType = moduleCaseTypeForActions(doc, moduleUuid);
	return [...entrySessionDatums(doc, ctx, moduleUuid, formUuid)]
		.reverse()
		.find(
			(datum) =>
				sessionDatumRequiresSelection(datum) && datum.caseType === ownType,
		)?.id;
}

/** Selected own-case datum including whether the value is scalar or a collection. */
export function selectedCaseSessionDatum(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid: Uuid,
): SessionDatum | undefined {
	const ownType = moduleCaseTypeForActions(doc, moduleUuid);
	return [...entrySessionDatums(doc, ctx, moduleUuid, formUuid)]
		.reverse()
		.find(
			(datum) =>
				sessionDatumRequiresSelection(datum) && datum.caseType === ownType,
		);
}

/** Root-aware datum list for a case-list-only browse entry. */
export function caseListSessionDatums(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
): readonly SessionDatum[] {
	const datums = selectableDatums(doc, ctx, moduleUuid, "followup");
	const ownType = moduleCaseTypeForActions(doc, moduleUuid);
	const own = [...datums]
		.reverse()
		.find(
			(datum) =>
				datum.caseType === ownType && sessionDatumRequiresSelection(datum),
		);
	const hasDetailScreen = (
		doc.modules[moduleUuid]?.caseListConfig?.columns ?? []
	).some((column) => column.visibleInDetail !== false);
	if (own !== undefined && hasDetailScreen) {
		own.detailConfirm = `m${moduleIndexOf(ctx, moduleUuid)}_case_long`;
	}
	return withInlineSearchQueries(
		doc,
		ctx,
		alignWithRootMenu(doc, ctx, { kind: "browse", module: moduleUuid }, datums),
	);
}

/**
 * The datum list of one form's entry, as HQ's `_get_entries_datums` reads it
 * back off the emitted `<session>`. Only ids, selection-ness, case types,
 * and functions matter to a frame, so this needs none of the nodeset detail
 * (filters, owner exclusion, details) the entry itself carries.
 */
export function entryFrameDatums(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid: Uuid,
): readonly FrameDatum[] {
	return entrySessionDatums(doc, ctx, moduleUuid, formUuid).map((datum) =>
		toFrameDatum(datum, ctx),
	);
}

/** The runtime menu selection that supplies each projected case-selection
 * datum. Datum ids may be renamed or aligned with a root menu; module UUID is
 * the stable bridge to Preview's already-resolved menu/session selections. */
export interface EntrySelectionDatumSource {
	readonly id: string;
	readonly caseType: string;
	readonly moduleUuid: Uuid;
}

export function entrySelectionDatumSources(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid: Uuid,
): readonly EntrySelectionDatumSource[] {
	return entrySessionDatums(doc, ctx, moduleUuid, formUuid).flatMap((datum) => {
		if (!sessionDatumRequiresSelection(datum) || datum.caseType === undefined)
			return [];
		const sourceModuleUuid = ctx.selectionSourceModules.get(datum);
		return sourceModuleUuid === undefined
			? []
			: [
					{
						id: datum.id,
						caseType: datum.caseType,
						moduleUuid: sourceModuleUuid,
					},
				];
	});
}

/** Longest common prefix of several datum lists, compared by id. */
export function commonPrefixById(
	lists: readonly (readonly FrameDatum[])[],
): FrameDatum[] {
	if (lists.length === 0) return [];
	const [first, ...rest] = lists;
	const prefix: FrameDatum[] = [];
	for (const [index, datum] of (first ?? []).entries()) {
		if (rest.every((list) => list[index]?.id === datum.id)) prefix.push(datum);
		else break;
	}
	return prefix;
}

/**
 * HQ's `get_frame_children(module, form)` for a form target, or its
 * `_frame_children_for_module(module, include_user_selections=False)` for a
 * module target.
 */
export function targetFrameChildren(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	target: FormLinkTarget,
): FrameChild[] {
	if (target.type === "module") {
		return moduleFrameChildren(doc, ctx, target.moduleUuid);
	}
	return formFrameChildren(doc, ctx, target.moduleUuid, target.formUuid);
}

function frameCommand(
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid?: Uuid,
): FrameChild {
	const child: FrameChild = {
		type: "command",
		id:
			formUuid === undefined
				? `m${moduleIndexOf(ctx, moduleUuid)}`
				: `m${moduleIndexOf(ctx, moduleUuid)}-f${formIndexOf(ctx, moduleUuid, formUuid)}`,
	};
	ctx.commandTargets.set(child, {
		moduleUuid,
		...(formUuid !== undefined && { formUuid }),
	});
	return child;
}

function baseFormFrameChildren(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid: Uuid,
): FrameChild[] {
	const formUuids = ctx.formOrder[moduleUuid] ?? [];
	// HQ reads every `m{N}-f{K}` entry of the module (browse `*-case-list`
	// entries are filtered out in `_get_entries_datums`), so the common
	// prefix runs over the module's FORMS only.
	const common = commonPrefixById(
		formUuids.map((uuid) => entryFrameDatums(doc, ctx, moduleUuid, uuid)),
	);
	const remaining = entryFrameDatums(doc, ctx, moduleUuid, formUuid).slice(
		common.length,
	);
	return [
		frameCommand(ctx, moduleUuid),
		...common.map((datum) => ({ type: "datum" as const, datum })),
		frameCommand(ctx, moduleUuid, formUuid),
		...remaining.map((datum) => ({ type: "datum" as const, datum })),
	];
}

/** `_frame_children_for_module`: ancestors include their common user
 * selections; the destination child contributes its command only. */
export function moduleFrameChildren(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
): FrameChild[] {
	const parentUuid = moduleParent(doc, moduleUuid);
	const ownCommand = frameCommand(ctx, moduleUuid);
	if (parentUuid === undefined || parentUuid === null) return [ownCommand];
	const parentForms = ctx.formOrder[parentUuid] ?? [];
	const parentCommon = commonPrefixById(
		parentForms.map((uuid) => entryFrameDatums(doc, ctx, parentUuid, uuid)),
	);
	return [
		...moduleFrameChildren(doc, ctx, parentUuid),
		...parentCommon.map((datum) => ({ type: "datum" as const, datum })),
		ownCommand,
	];
}

/** `get_frame_children(module, form)` plus HQ's parent-frame prepend. */
export function formFrameChildren(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid: Uuid,
): FrameChild[] {
	const base = baseFormFrameChildren(doc, ctx, moduleUuid, formUuid);
	const parentUuid = moduleParent(doc, moduleUuid);
	if (parentUuid === undefined || parentUuid === null) return base;
	const prefix = moduleFrameChildren(doc, ctx, moduleUuid).slice(0, -1);
	const prefixedIds = new Set(
		prefix.flatMap((child) => (child.type === "datum" ? [child.datum.id] : [])),
	);
	return [
		...prefix,
		...base.filter(
			(child) => child.type === "command" || !prefixedIds.has(child.datum.id),
		),
	];
}

/** The selection datums a target needs: what a link must carry or match. */
export function targetSelectionDatums(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	target: FormLinkTarget,
): FrameDatum[] {
	return targetFrameChildren(doc, ctx, target).flatMap((child) =>
		child.type === "datum" && child.datum.requiresSelection
			? [child.datum]
			: [],
	);
}

/** The target frame's selected-record identities, including inherited root
 * selections. A module command alone supplies no selected-record datum. */
export function formLinkTargetDatumIds(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	target: FormLinkTarget,
): readonly EntryDatumId[] {
	const selections = targetSelectionDatums(doc, ctx, target).filter(
		(datum) => datum.query === undefined,
	);
	const rows: EntryDatumId[] = [];
	for (const selection of selections) {
		const refs = new Map<string, DatumRef>();
		const source = selection.selectionSourceModuleUuid;
		if (source !== undefined)
			refs.set(datumRefKey({ kind: "selected-case", module: source }), {
				kind: "selected-case",
				module: source,
			});
		// A frame can prepend an ancestor's common entry prefix. Resolve its
		// aliases from those real entries, never from a fabricated target form.
		let module: Uuid | null | undefined = target.moduleUuid;
		const seen = new Set<Uuid>();
		while (module !== undefined && module !== null && !seen.has(module)) {
			seen.add(module);
			const forms =
				target.type === "form" && module === target.moduleUuid
					? [target.formUuid]
					: (ctx.formOrder[module] ?? []);
			for (const form of forms) {
				for (const row of entryDatumIds(doc, ctx, module, form)) {
					if (
						row.id !== selection.id ||
						(source !== undefined &&
							!row.refs.some(
								(ref) => ref.kind === "selected-case" && ref.module === source,
							))
					)
						continue;
					for (const ref of row.refs)
						if (ref.kind === "selected-case") refs.set(datumRefKey(ref), ref);
				}
			}
			module = moduleParent(doc, module);
		}
		rows.push({
			id: selection.id,
			refs: [...refs.values()],
			scalar: selection.maximum === undefined,
		});
	}
	return rows;
}

// ── Matching ─────────────────────────────────────────────────────────────

/** A child before session-reference replacement. */
type PendingChild =
	| { readonly type: "command"; readonly id: string }
	| {
			readonly type: "datum";
			readonly id: string;
			readonly value: WireExpr;
			readonly renderFunction?: FrameDatum["renderFunction"];
			readonly renderFormLinkFunction?: FrameDatum["renderFormLinkFunction"];
	  }
	| Extract<MatchedChild, { type: "query" }>;

/**
 * HQ's `WorkflowQueryMeta.to_stack_datum`: the frame fetches the one case
 * the next datum will select, through the case-fixture endpoint rather than
 * a full search, keyed by the session value `sourceId` holds.
 */
function queryChild(datum: FrameDatum, sourceId: string): PendingChild {
	const query = datum.query;
	if (query === undefined) {
		throw new Error(`Frame datum ${datum.id} is not a query`);
	}
	return {
		type: "query",
		id: datum.id,
		value: query.caseFixtureUrl,
		data: [
			{ key: "case_type", ref: w.str(datum.caseType ?? "") },
			query.nextDatumIsCollection
				? {
						key: "case_id",
						ref: w.context([w.self()]),
						nodeset: w.instance(selectedCasesInstance(sourceId), [
							w.step("results"),
							w.step("value"),
						]),
					}
				: { key: "case_id", ref: sessionDataRef(sourceId) },
		],
	};
}

/** CCHQ's `case_fixture` endpoint, the search URL with `/phone/search/`
 *  swapped for `/phone/case_fixture/`; placeholders as in `SEARCH_URL_TEMPLATE`. */
export const CASE_FIXTURE_URL_TEMPLATE = runtimeUrls().caseFixture;

function functionChild(datum: FrameDatum): PendingChild {
	return {
		type: "datum",
		id: datum.id,
		value: datum.function ?? w.str(""),
		...(datum.renderFunction !== undefined && {
			renderFunction: datum.renderFunction,
		}),
		...(datum.renderFormLinkFunction !== undefined && {
			renderFormLinkFunction: datum.renderFormLinkFunction,
		}),
	};
}

/**
 * HQ's `_find_best_match`: the first non-parent-placeholder source datum, in
 * source order, whose case type equals the target's. Same id keeps the target's
 * id; a different id means the frame reads the SOURCE's session value under
 * the target's id. Sources with no case type never match.
 */
function findBestMatch(
	target: FrameDatum,
	sources: readonly FrameDatum[],
): { readonly sourceId: string } | undefined {
	for (const source of sources) {
		if (source.query !== undefined) continue;
		if (source.fromParentModule === true) continue;
		if (source.caseType === undefined) continue;
		if (source.caseType !== target.caseType) continue;
		return { sourceId: source.id === target.id ? target.id : source.id };
	}
	return undefined;
}

export interface SourceMatch {
	readonly children: MatchedChild[];
	/** Selection datums no source datum could satisfy (HQ would emit a
	 *  self-named reference that may be absent or empty). */
	readonly unmatched: FrameDatum[];
	/** Which source datum each matched selection datum reads, in target
	 *  order — the structural answer a surface needs to say "the case this
	 *  form opened" without reading the session reference back out of text. */
	readonly matched: ReadonlyArray<{
		readonly id: string;
		readonly sourceId: string;
	}>;
}

/** HQ's `_get_datums_matched_to_source`. */
export function matchFrameToSource(
	target: readonly FrameChild[],
	source: readonly FrameDatum[],
): SourceMatch {
	let unused = [...source];
	const pending: PendingChild[] = [];
	const unmatched: FrameDatum[] = [];
	const matched: Array<{ id: string; sourceId: string }> = [];
	for (const [index, child] of target.entries()) {
		if (child.type === "command") {
			pending.push(child);
			continue;
		}
		const { datum } = child;
		if (datum.query !== undefined) {
			// The query fetches whatever the NEXT datum will match to, so it
			// looks ahead without consuming (`_get_datums_matched_to_source`).
			const next = target[index + 1];
			const nextMatch =
				next?.type === "datum" && next.datum.requiresSelection
					? findBestMatch(next.datum, unused)
					: undefined;
			pending.push(
				queryChild(datum, nextMatch?.sourceId ?? datum.query.nextDatumId),
			);
			continue;
		}
		if (!datum.requiresSelection) {
			pending.push(functionChild(datum));
			continue;
		}
		const match = findBestMatch(datum, unused);
		if (match === undefined) {
			unmatched.push(datum);
			pending.push({
				type: "datum",
				id: datum.id,
				value: sessionDataRef(datum.id),
			});
			continue;
		}
		// HQ filters the consumed source by the MATCH's id, which is the
		// target's id (`match.id`), not the source's — mirrored as is.
		unused = unused.filter((candidate) => candidate.id !== datum.id);
		matched.push({ id: datum.id, sourceId: match.sourceId });
		pending.push({
			type: "datum",
			id: datum.id,
			value: sessionDataRef(match.sourceId),
		});
	}
	return {
		children: replaceSessionReferences(
			pending,
			new Set(source.map((datum) => datum.id)),
		),
		unmatched,
		matched,
	};
}

export interface ManualMatch {
	readonly children: MatchedChild[];
	/** Selection datums the link did not name (HQ raises here). */
	readonly missing: FrameDatum[];
	/** Manual names no target datum carries (HQ drops them silently). */
	readonly unused: string[];
}

/** HQ's `_get_datums_matched_to_manual_values`. */
export function matchFrameToManual(
	target: readonly FrameChild[],
	manual: readonly {
		readonly name: string;
		readonly xpath: WireExpr;
	}[],
	sourceDatumIds: ReadonlySet<string>,
): ManualMatch {
	const byName = new Map(manual.map((datum) => [datum.name, datum.xpath]));
	const targetIds = new Set<string>();
	const pending: PendingChild[] = [];
	const missing: FrameDatum[] = [];
	for (const child of target) {
		if (child.type === "command") {
			pending.push(child);
			continue;
		}
		const { datum } = child;
		targetIds.add(datum.id);
		const value = byName.get(datum.id);
		if (value !== undefined) {
			pending.push({ type: "datum", id: datum.id, value });
			continue;
		}
		if (datum.query !== undefined) {
			// HQ carries a prompted query through as is and refuses a
			// self-running one no manual value names, exactly like a
			// selection datum (`_get_datums_matched_to_manual_values`).
			if (datum.requiresSelection) missing.push(datum);
			pending.push(queryChild(datum, datum.query.nextDatumId));
			continue;
		}
		if (!datum.requiresSelection) {
			pending.push(functionChild(datum));
			continue;
		}
		missing.push(datum);
		pending.push({
			type: "datum",
			id: datum.id,
			value: sessionDataRef(datum.id),
		});
	}
	return {
		children: replaceSessionReferences(pending, sourceDatumIds),
		missing,
		unused: manual
			.map((datum) => datum.name)
			.filter((name) => !targetIds.has(name)),
	};
}

/**
 * HQ's `_replace_session_references_in_stack`, for the datums Nova itself
 * composes: a function datum that reads `session/data/<id>` where `<id>` is
 * an EARLIER datum of this same frame and not a datum of the source entry
 * reads that earlier datum's value instead, because a `<create>` does not
 * update the session between its steps. Authored manual XPath is carried as
 * written.
 */
function replaceSessionReferences(
	children: readonly PendingChild[],
	sourceDatumIds: ReadonlySet<string>,
): MatchedChild[] {
	const earlier = new Map<string, WireExpr>();
	return children.map((child) => {
		if (child.type === "command" || child.type === "query") return child;
		const read = (id: string): WireExpr => {
			const held = earlier.get(id);
			return held !== undefined && !sourceDatumIds.has(id)
				? held
				: sessionDataRef(id);
		};
		const value =
			child.renderFormLinkFunction !== undefined
				? child.renderFormLinkFunction(read)
				: child.renderFunction === undefined
					? child.value
					: child.renderFunction(read);
		earlier.set(child.id, value);
		return { type: "datum", id: child.id, value };
	});
}

// ── The `previous` frame ─────────────────────────────────────────────────

/**
 * HQ's `WORKFLOW_PREVIOUS`: the source form's own frame children, the last
 * child dropped, then every trailing computed datum dropped until a command
 * or a selection datum is at the end. Selection datums read their own
 * session value; function datums carry their function.
 */
export function previousFrameChildren(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid: Uuid,
): MatchedChild[] {
	if (ctx.entryMetadataOnly)
		throw new Error(
			"Entry-plan metadata cannot be emitted as a previous frame.",
		);
	const children = previousEntryFrameChildren(doc, ctx, moduleUuid, formUuid);
	const pending: PendingChild[] = children.map(staticFrameChild);
	return replaceSessionReferences(pending, new Set());
}

/** The same previous frame before wire matching discards runtime provenance. */
export function previousEntryFrameChildren(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid: Uuid,
): FrameChild[] {
	const parentUuid = moduleParent(doc, moduleUuid);
	let children: FrameChild[];
	if (parentUuid === undefined || parentUuid === null) {
		children = baseFormFrameChildren(doc, ctx, moduleUuid, formUuid);
	} else {
		const childForms = ctx.formOrder[moduleUuid] ?? [];
		const rootForms = ctx.formOrder[parentUuid] ?? [];
		const common = commonPrefixById([
			...childForms.map((uuid) => entryFrameDatums(doc, ctx, moduleUuid, uuid)),
			...rootForms.map((uuid) => entryFrameDatums(doc, ctx, parentUuid, uuid)),
		]);
		const remaining = entryFrameDatums(doc, ctx, moduleUuid, formUuid).slice(
			common.length,
		);
		children = [
			frameCommand(ctx, parentUuid),
			frameCommand(ctx, moduleUuid),
			...common.map((datum) => ({ type: "datum" as const, datum })),
			frameCommand(ctx, moduleUuid, formUuid),
			...remaining.map((datum) => ({ type: "datum" as const, datum })),
		];
	}
	let last = children.pop();
	while (
		last !== undefined &&
		last.type === "datum" &&
		!last.datum.requiresSelection
	) {
		last = children.pop();
	}
	return children;
}

/** A frame child with no source to match: a selection reads its own
 *  session value, a query fetches its next datum's, a function carries
 *  its function. */
function staticFrameChild(child: FrameChild): PendingChild {
	if (child.type === "command") return child;
	const { datum } = child;
	if (datum.query !== undefined)
		return queryChild(datum, datum.query.nextDatumId);
	return datum.requiresSelection
		? { type: "datum", id: datum.id, value: sessionDataRef(datum.id) }
		: functionChild(datum);
}

/**
 * HQ's `CaseListFormWorkflow` frame for a no-matches registration form
 * returning to its host module under `post_form_workflow: case_list`: the
 * host's `_frame_children_for_module` plus the common datum prefix of its
 * menu forms (`get_frame_children(target_module)`), matched to the source
 * form's datums (`_get_datums_matched_to_source`) and cut at the datum the
 * form's new case satisfies (`CaseListFormStackFrames.add_children` breaks
 * at `source_session_var`). For a search-first host that is the module
 * command plus the results query re-keyed to the new case id, so the
 * worker lands on Results showing the case they just registered.
 *
 * `sourceSessionVar` is the form's own new-case datum (`case_id_new_<t>_0`).
 */
export function caseListFormReturnFrame(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	hostModuleUuid: Uuid,
	sourceSessionVar: string,
	caseType: string,
): { readonly ifClause: WireExpr; readonly children: MatchedChild[] } {
	/* HQ's `_get_entries_datums` reads form entries only (`_include_datums`
	 * skips the `*-case-list` entry), so a host without menu forms has no
	 * common prefix: the frame is the host command alone, and the worker
	 * returns to the module rather than to a Results keyed to the new case. */
	const hostForms = ctx.formOrder[hostModuleUuid] ?? [];
	const common = commonPrefixById(
		hostForms.map((uuid) => entryFrameDatums(doc, ctx, hostModuleUuid, uuid)),
	);
	const target: FrameChild[] = [
		...moduleFrameChildren(doc, ctx, hostModuleUuid),
		...common.map((datum) => ({ type: "datum" as const, datum })),
	];
	const pending: PendingChild[] = [];
	for (const [index, child] of target.entries()) {
		if (child.type === "command") {
			pending.push(child);
			continue;
		}
		const { datum } = child;
		if (datum.query !== undefined) {
			const next = target[index + 1];
			const nextMatches =
				next?.type === "datum" &&
				next.datum.requiresSelection &&
				next.datum.caseType === caseType;
			pending.push(
				queryChild(
					datum,
					nextMatches ? sourceSessionVar : datum.query.nextDatumId,
				),
			);
			continue;
		}
		if (!datum.requiresSelection) {
			pending.push(functionChild(datum));
			continue;
		}
		// The datum the new case satisfies ends the frame; any other
		// selection reads its own session value, as HQ's unmatched target.
		if (datum.caseType === caseType) break;
		pending.push({
			type: "datum",
			id: datum.id,
			value: sessionDataRef(datum.id),
		});
	}
	const returnTo = sessionDataRef(RETURN_TO_DATUM_ID);
	const command = `m${moduleIndexOf(ctx, hostModuleUuid)}`;
	return {
		ifClause: w.and(
			w.eq(w.call("count", [returnTo]), w.num(1)),
			w.eq(returnTo, w.str(command)),
		),
		children: replaceSessionReferences(pending, new Set([sourceSessionVar])),
	};
}

/** HQ `const.RETURN_TO`: the datum the Register action pushes so the
 *  form's return frame knows which module offered it. */
export const RETURN_TO_DATUM_ID = "return_to";

/** Parent-aware static `module` destination for post-submit workflows. */
export function moduleDestinationFrameChildren(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
): MatchedChild[] {
	const pending: PendingChild[] = moduleFrameChildren(doc, ctx, moduleUuid).map(
		staticFrameChild,
	);
	return replaceSessionReferences(pending, new Set());
}

/**
 * The static `parentMenu` destination (HQ `parent_module`,
 * `_frame_children_for_module(module.root_module)`): the parent module's
 * frame with its selections kept, which is the form's module frame without
 * its last child. A module with no parent has none.
 */
export function parentMenuDestinationFrameChildren(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
): MatchedChild[] {
	const parentUuid = moduleParent(doc, moduleUuid);
	if (parentUuid === undefined || parentUuid === null) return [];
	const pending: PendingChild[] = moduleFrameChildren(doc, ctx, moduleUuid)
		.slice(0, -1)
		.map(staticFrameChild);
	return replaceSessionReferences(pending, new Set());
}

// ── Guards ───────────────────────────────────────────────────────────────

export interface GuardPlanLink {
	readonly uuid: Uuid;
	/** Projected wire XPath, trimmed and non-empty; absent = unconditional. */
	readonly condition?: WireExpr;
}

export type FallbackPlan =
	/** No conditional link exists: a sole unconditional link always fires. */
	| { readonly kind: "none" }
	/** A terminal unconditional link is the exhaustive else. */
	| { readonly kind: "suppressed-by-else" }
	/** The last link is conditional: the fallback fires when none matched. */
	| { readonly kind: "guarded"; readonly guard: WireExpr };

export interface GuardPlan {
	readonly links: ReadonlyArray<{
		readonly uuid: Uuid;
		/** The `if` to emit; absent = no `if` attribute. */
		readonly guard?: WireExpr;
	}>;
	readonly fallback: FallbackPlan;
}

/**
 * Exclusive guards over an ordered link list. Total over any input: an
 * unconditional link that is not last still gets its guard (the validator
 * refuses the document; the projection never throws).
 */
function formLinkGuard(
	positive: WireExpr | undefined,
	excluded: readonly WireExpr[],
): WireExpr {
	return w.and(
		...(positive === undefined ? [] : [positive]),
		...excluded.map((value) => w.not(value)),
	);
}

export function planFormLinkGuards(links: readonly GuardPlanLink[]): GuardPlan {
	const planned: Array<{ uuid: Uuid; guard?: WireExpr }> = [];
	const priors: WireExpr[] = [];
	for (const link of links) {
		if (link.condition === undefined) {
			planned.push({
				uuid: link.uuid,
				...(priors.length > 0 && {
					guard: formLinkGuard(undefined, priors),
				}),
			});
			continue;
		}
		const guard = formLinkGuard(link.condition, priors);
		planned.push({ uuid: link.uuid, guard });
		priors.push(link.condition);
	}
	const last = links.at(-1);
	const fallback: FallbackPlan =
		priors.length === 0
			? { kind: "none" }
			: last?.condition === undefined
				? { kind: "suppressed-by-else" }
				: {
						kind: "guarded",
						guard: formLinkGuard(
							undefined,
							planned.flatMap((link) =>
								link.guard === undefined ? [] : [link.guard],
							),
						),
					};
	return { links: planned, fallback };
}

// ── The whole-form projection ────────────────────────────────────────────

export interface ProjectedFormLink {
	readonly uuid: Uuid;
	/** The suite `<create if>` / HQ `xpath`; absent = unconditional. */
	readonly guard?: WireExpr;
	readonly target: FormLinkTarget;
	/** The local frame's children after matching. */
	readonly children: MatchedChild[];
	/** The authored manual datums projected to wire XPath (HQ `datums`). */
	readonly datums: ReadonlyArray<{
		readonly name: string;
		readonly xpath: WireExpr;
	}>;
	/** Validator inputs; all empty on a document the gate admits. */
	readonly unmatched: readonly FrameDatum[];
	readonly missing: readonly FrameDatum[];
	readonly unused: readonly string[];
	/** Manual selections that HQ cannot use to hydrate a preceding Search query. */
	readonly unrepresentableQueryDatums?: readonly string[];
}

export interface ProjectedFormLinks {
	readonly links: readonly ProjectedFormLink[];
	readonly fallback: FallbackPlan;
}

/**
 * Whether the projection of `formUuid`'s links is DEFINED: every module it
 * reads sits in the module sequence with a well-formed case type, and
 * `buildFormActions` is defined for every form it reads — the source form,
 * every form of every target module (a form target's frame carries the
 * module's common-prefix datums, which read every form in it), and every
 * structural ancestor form whose datums a child entry inherits. The wire
 * builder fails closed on a module outside the sequence, a case type that
 * is not an identifier, a form whose case writes the admission refuses, a
 * field id that is not an XML name, or a close condition naming a field the
 * form does not hold — each a finding of its own
 * (`INVALID_CASE_TYPE_FORMAT`, `CASE_WRITE_*`, `CASE_CREATE_NAME_*`,
 * `INVALID_FIELD_ID`, `CLOSE_CONDITION_FIELD_NOT_FOUND`, the topology checks) — so the validator asks this
 * first and never dies where another rule reports. The check reads the same
 * inventory, the same admission, and the same grammars the builder does.
 */
export function formLinkActionsBuildable(
	doc: BlueprintDoc,
	formUuid: Uuid,
	links: readonly FormLink[],
): boolean {
	const source = doc.moduleOrder.find((uuid) =>
		(doc.formOrder[uuid] ?? []).includes(formUuid),
	);
	return (
		source !== undefined &&
		moduleFrameActionsBuildable(doc, [
			source,
			...links.map((link) => link.target.moduleUuid),
		])
	);
}

/** Shared buildability closure for form links and bare module selection. */
export function moduleFrameActionsBuildable(
	doc: BlueprintDoc,
	roots: readonly Uuid[],
): boolean {
	const projectedModules = new Set(projectedModulePreorder(doc));
	const moduleOf = (uuid: Uuid): Uuid | undefined =>
		doc.moduleOrder.find((moduleUuid) =>
			(doc.formOrder[moduleUuid] ?? []).includes(uuid),
		);
	const modules = new Set<Uuid>();
	const forms = new Set<Uuid>();
	const pending = [...roots];
	while (pending.length) {
		const uuid = pending.pop();
		if (uuid === undefined || modules.has(uuid)) continue;
		modules.add(uuid);
		for (const formUuid of doc.formOrder[uuid] ?? []) forms.add(formUuid);
		const module = doc.modules[uuid];
		if (!module) return false;
		if (module.parentModuleUuid) pending.push(module.parentModuleUuid);
		if (module.parentCaseModuleUuid) pending.push(module.parentCaseModuleUuid);
	}

	// `deriveSessionDatums` and the case-loading nodeset validate every case
	// type they print (`identifierValidation.ts::validateCaseType`), and the
	// frame indices are positions in the module sequence.
	const wellFormedCaseType = (caseType: string | undefined): boolean =>
		caseType === undefined || caseType === "" || CASE_TYPE_REGEX.test(caseType);
	for (const moduleUuid of modules) {
		const mod = doc.modules[moduleUuid];
		if (mod === undefined || !projectedModules.has(moduleUuid)) {
			return false;
		}
		if (!wellFormedCaseType(mod.caseType)) return false;
	}
	const xmlNames = (
		segments: readonly { readonly fieldId: string }[] | undefined,
	): boolean =>
		(segments ?? []).every((segment) =>
			XML_ELEMENT_NAME_REGEX.test(segment.fieldId),
		);
	for (const uuid of forms) {
		const form = doc.forms[uuid];
		const moduleUuid = moduleOf(uuid);
		if (form === undefined || moduleUuid === undefined) return false;
		const inventory = deriveCaseWriteInventory(
			doc,
			uuid,
			{ caseType: moduleCaseTypeForActions(doc, moduleUuid) },
			form.type,
		);
		if (caseWriteAdmissionIssues(inventory).length > 0) return false;
		// A close form's condition is read at its question's path
		// (`xform/caseOps.ts::formCloseCondition`); one naming a field the form
		// does not hold is `CLOSE_CONDITION_FIELD_NOT_FOUND`.
		const close = form.closeCondition;
		if (
			close?.field &&
			close.answer &&
			!descendantFieldUuids(doc, uuid).has(close.field)
		)
			return false;
		if (
			!inventory.buckets.every(
				(bucket) =>
					wellFormedCaseType(bucket.caseType) &&
					xmlNames(bucket.repeatPath) &&
					bucket.writers.every((writer) => xmlNames(writer.path)),
			)
		) {
			return false;
		}
	}
	return true;
}

/** Single-menu answers of `moduleFrameActionsBuildable`, one map per
 * context. A context is built over one immutable document, so the answer for
 * a menu holds for every form of it that the context's caller reads. */
const frameBuildableByContext = new WeakMap<
	FormLinkProjectionContext,
	Map<Uuid, boolean>
>();

/** `moduleFrameActionsBuildable(doc, [moduleUuid])`, derived once per menu
 * per context: the per-form rules ask it for every form of a menu, and each
 * answer derives the case-write inventory of every form the menu reaches. */
export function moduleFrameActionsBuildableIn(
	doc: BlueprintDoc,
	context: FormLinkProjectionContext,
	moduleUuid: Uuid,
): boolean {
	let held = frameBuildableByContext.get(context);
	if (held === undefined) {
		held = new Map();
		frameBuildableByContext.set(context, held);
	}
	const known = held.get(moduleUuid);
	if (known !== undefined) return known;
	const answer = moduleFrameActionsBuildable(doc, [moduleUuid]);
	held.set(moduleUuid, answer);
	return answer;
}

/** An absent condition is the unconditional branch. */
export function formLinkIsConditional(
	link: Pick<FormLink, "condition">,
): boolean {
	return link.condition !== undefined;
}

/**
 * The session reference of the SOURCE entry's own case, which every typed
 * reference in its links walks from: the `case_id` selection datum on a
 * case-loading form, the primary create datum (`case_id_new_<type>_0`) on a
 * registration form — that case exists once the form has closed, and the
 * datum is how the entry names it. `undefined` when the entry carries
 * neither (a survey, or a module with no case type), where the read-side
 * accept set admits no case reference anyway.
 */
export function ownCaseSessionRef(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formType: FormLinkSourceType,
	sourceDatums: readonly FrameDatum[],
): WireExpr | undefined {
	const ownType = moduleCaseTypeForActions(doc, moduleUuid);
	const selected = [...sourceDatums]
		.reverse()
		.find((datum) => datum.requiresSelection && datum.caseType === ownType);
	if (selected !== undefined) return sessionDataRef(selected.id);
	if (formType !== "registration") return undefined;
	const created = sourceDatums.find(
		(datum) =>
			!datum.requiresSelection &&
			datum.function !== undefined &&
			datum.caseType === ownType,
	);
	return created === undefined ? undefined : sessionDataRef(created.id);
}

type FormLinkSourceType = BlueprintDoc["forms"][string]["type"];

/** Project a stored condition or value in its actual after-submit slot. */
export function projectFormLinkSessionExpression(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	formUuid: Uuid,
	expression: Expression,
	slot: FormExpressionSlotRef,
): WireExpr {
	const moduleUuid = owningModuleOf(ctx, formUuid);
	const expressionDoc = ctx.expressionDoc;
	if (
		expressionDoc !== doc &&
		(expressionDoc.forms[formUuid] !== doc.forms[formUuid] ||
			expressionDoc.fields !== doc.fields ||
			expressionDoc.fieldOrder !== doc.fieldOrder ||
			expressionDoc.fieldParent !== doc.fieldParent)
	)
		throw new Error(
			"The emitted form link no longer preserves its authored question identities and paths.",
		);
	const form = expressionDoc.forms[formUuid];
	const structure = formStructure(expressionDoc, formUuid);
	const types = slotContext(
		expressionDoc,
		slot,
		lookupTypeIndexFromNaming(ctx.lookupNaming) ?? new Map(),
	);
	if (
		moduleUuid === undefined ||
		form === undefined ||
		structure === undefined ||
		types === undefined
	) {
		throw new Error(
			"The form-link expression has no source entry. Check its form, link and carried value.",
		);
	}
	const sourceDatums = entryFrameDatums(doc, ctx, moduleUuid, formUuid);
	const ownCaseId = ownCaseSessionRef(doc, moduleUuid, form.type, sourceDatums);
	const depths = caseTypeDepthMap(
		expressionDoc.modules[structure.moduleUuid]?.caseType,
		types.facts.caseTypes,
	);
	return toWire(expression, {
		target: "suite",
		types,
		form: formNodeProjection(doc, structure),
		bindings: {
			workerProperty: ctx.workerProperty,
			datumId: entryDatumIdResolver(
				entryDatumIds(doc, ctx, moduleUuid, formUuid),
			),
			userPropertySlugs: types.facts.userPropertySlugs,
			...(ctx.lookupNaming === undefined
				? {}
				: {
						lookup: {
							naming: ctx.lookupNaming,
							instanceScope: "suite" as const,
						},
					}),
			formCaseProperty: (caseType, property) => {
				const depth = depths.get(caseType);
				if (depth === undefined || ownCaseId === undefined)
					throw new Error("The submitted form does not supply this record.");
				if (depth === 0 && property === "case_id") return ownCaseId;
				let id = ownCaseId;
				for (let hop = 0; hop < depth; hop++)
					id = w.append(caseById(id, "casedb"), [
						w.step("index"),
						w.step("parent"),
					]);
				return w.append(caseById(id, "casedb"), [casePropertyStep(property)]);
			},
		},
	});
}

/** HQ leaves a manual link's hydration query pointed at the target's old
 * session datum. Core defines every step against the source context, so the
 * subsequent manual assignment cannot supply that query. Automatic matching
 * does bind the query to the source. Use it when every non-query step is
 * identical; otherwise only an unchanged source selection is representable. */
function projectManualSearchLink(
	target: readonly FrameChild[],
	datums: readonly {
		readonly name: string;
		readonly xpath: WireExpr;
	}[],
	sourceDatums: readonly FrameDatum[],
	sourceIds: ReadonlySet<string>,
): {
	readonly match: ManualMatch;
	readonly datums: typeof datums;
	readonly unrepresentableQueryDatums: readonly string[];
} {
	const match = matchFrameToManual(target, datums, sourceIds);
	const queries = target.flatMap((child) =>
		child.type === "datum" && child.datum.query !== undefined
			? [child.datum.query]
			: [],
	);
	if (queries.length === 0 || match.missing.length || match.unused.length)
		return { match, datums, unrepresentableQueryDatums: [] };
	const automatic = matchFrameToSource(target, sourceDatums);
	const withoutQueries = (children: readonly MatchedChild[]) =>
		children.filter((child) => child.type !== "query");
	const manualSteps = withoutQueries(match.children);
	const autoSteps = withoutQueries(automatic.children);
	const sameSteps =
		automatic.unmatched.length === 0 &&
		manualSteps.length === autoSteps.length &&
		manualSteps.every((child, index) => {
			const other = autoSteps[index];
			return (
				other !== undefined &&
				child.type === other.type &&
				child.id === other.id &&
				(child.type === "command" ||
					(other.type === "datum" &&
						formLinkValueText(child.value) === formLinkValueText(other.value)))
			);
		});
	if (sameSteps)
		return {
			match: { ...match, children: automatic.children },
			datums: [],
			unrepresentableQueryDatums: [],
		};
	const byName = new Map(datums.map((datum) => [datum.name, datum.xpath]));
	const unrepresentableQueryDatums = queries
		.filter((query) => {
			const manual = byName.get(query.nextDatumId);
			return (
				!sourceIds.has(query.nextDatumId) ||
				manual === undefined ||
				formLinkValueText(manual) !==
					formLinkValueText(sessionDataRef(query.nextDatumId))
			);
		})
		.map((query) => query.nextDatumId);
	return { match, datums, unrepresentableQueryDatums };
}

/**
 * Project one form's links, or `undefined` when it has none. Pure over the
 * document and the context; the expander (HQ JSON), the compiler (local
 * suite), and the validator (datum rules) all read this one result.
 */
export function projectFormLinks(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	formUuid: Uuid,
): ProjectedFormLinks | undefined {
	const form = doc.forms[formUuid];
	const links = form?.formLinks;
	if (form === undefined || links === undefined || links.length === 0) {
		return undefined;
	}
	const moduleUuid = owningModuleOf(ctx, formUuid);
	if (moduleUuid === undefined) {
		throw new Error(
			`Cannot project form links: form ${formUuid} belongs to no module`,
		);
	}
	const sourceDatums = entryFrameDatums(doc, ctx, moduleUuid, formUuid);
	const project = (
		expression: Expression,
		slot: FormExpressionSlotRef,
	): WireExpr =>
		projectFormLinkSessionExpression(doc, ctx, formUuid, expression, slot);
	const guards = planFormLinkGuards(
		links.map((link) => ({
			uuid: link.uuid,
			...(link.condition === undefined
				? {}
				: {
						condition: project(link.condition, {
							entity: "form",
							uuid: formUuid,
							slot: "form_link_condition",
							member: { linkUuid: link.uuid },
						}),
					}),
		})),
	);
	const sourceIds = new Set(sourceDatums.map((datum) => datum.id));
	const projected = links.map((link, index): ProjectedFormLink => {
		const target = targetFrameChildren(doc, ctx, link.target);
		const guard = guards.links[index]?.guard;
		const targetDatumId = entryDatumIdResolver(
			formLinkTargetDatumIds(doc, ctx, link.target),
		);
		const datums = (link.datums ?? []).map((datum) => {
			const name = targetDatumId(datum.name);
			if (name === undefined)
				throw new Error(
					"The linked entry does not supply this selected record.",
				);
			return {
				name,
				xpath: project(datum.xpath, {
					entity: "form",
					uuid: formUuid,
					slot: "form_link_datum_xpath",
					member: { linkUuid: link.uuid, datum: datum.name },
				}),
			};
		});
		if (link.datums !== undefined) {
			const manual = projectManualSearchLink(
				target,
				datums,
				sourceDatums,
				sourceIds,
			);
			const { match } = manual;
			return {
				uuid: link.uuid,
				...(guard !== undefined && { guard }),
				target: link.target,
				children: match.children,
				datums: manual.datums,
				...(manual.unrepresentableQueryDatums.length > 0 && {
					unrepresentableQueryDatums: manual.unrepresentableQueryDatums,
				}),
				unmatched: [],
				missing: match.missing,
				unused: match.unused,
			};
		}
		const match = matchFrameToSource(target, sourceDatums);
		return {
			uuid: link.uuid,
			...(guard !== undefined && { guard }),
			target: link.target,
			children: match.children,
			datums,
			unmatched: match.unmatched,
			missing: [],
			unused: [],
		};
	});
	return { links: projected, fallback: guards.fallback };
}
