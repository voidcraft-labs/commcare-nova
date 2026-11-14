import { type RuntimeTarget, runtimeUrls } from "@/lib/commcare/runtimeTarget";
import { moduleCaseTypeForActions as domainModuleCaseTypeForActions } from "@/lib/domain/basicCaseSlots";
import { type FormCaseEntryPlan, formCaseEntryPlan } from "./formCaseEntryPlan";
/**
 * After-submit links: the ONE projection both wire paths and the validator
 * read.
 *
 * A form's `formLinks` are its destinations: after the form is submitted
 * every destination whose emitted condition holds runs, in the author's
 * order, and `otherwise` is where the form goes when no destination that
 * may not run runs (`lib/domain/afterSubmit.ts`). CommCare's session stack
 * pushes EVERY `<create>` whose `if` holds and runs the LAST one pushed
 * first (`commcare-core CommCareSession::createFrame` / `::finishAndPop`),
 * and CommCare HQ builds one frame per `form_links[i]` in stored order with
 * that link's `xpath` as its `if`, then its fallback frame
 * (`workflow.py::EndOfFormNavigationWorkflow.form_workflow_frames`). So the
 * destinations are emitted in REVERSE array order: the author's first
 * destination that holds is the frame on top.
 *
 * This module owns that construction and everything around it that the
 * local suite and the HQ JSON must agree on byte for byte:
 *
 *   - the after-submit projection (`projectAfterSubmit`): a destination's
 *     `xpath` is its own condition conjoined with one held-case guard per
 *     carried value on a single-case selection
 *     (`formLinkCarriedCaseGuards`), so a frame whose case is not on the
 *     device never opens; an otherwise link's is the negation of every
 *     non-blank destination `xpath` in emitted order, then its own guards; a
 *     built-in otherwise is HQ's fallback frame, whose `if` is the literal HQ
 *     derives (`::_get_fallback_frame`: `' and '.join(f'not({condition})' …)`
 *     over every non-blank `xpath`) from the `xpath`s Nova sends it;
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
	type CaseListRegistrationReturn,
	type DatumEntry,
	type DatumRef,
	datumRefKey,
	type Expression,
	type FormLink,
	type FormLinkDatum,
	type FormLinkTarget,
	formLinkEntries,
	guardedLinkDatums,
	menuScreenOf,
	moduleHasCaseListMenuItem,
	moduleParent,
	moduleShowsFormsInMenuAbove,
	type OtherwiseDestination,
	projectedModulePreorder,
	type ResolvedFormLinkTarget,
	resolveFormLinkTarget,
	rootSelectionAlignment,
	type Uuid,
} from "@/lib/domain";
import { carriedCreates } from "@/lib/domain/advancedEntryDatums";
import { slotContext } from "@/lib/domain/expression/context";
import { formStructure } from "@/lib/domain/expression/formStructure";
import type { FormExpressionSlotRef } from "@/lib/domain/expression/types";
import type { PlannedNewCaseDatum } from "./casePlacementPlan";
import { caseTypeDepthMap } from "./caseTypeDepths";
import { CASE_TYPE_REGEX, XML_ELEMENT_NAME_REGEX } from "./constants";
import { moduleExpressionContexts } from "./expressionContext";
import {
	type LookupWireNaming,
	lookupTypeIndexFromNaming,
} from "./lookup/naming";
import { emittedModuleKind } from "./moduleKind";
import { ownCaseOperationFindings } from "./ownCaseOperationFindings";
import {
	type AdvancedLoadDatumInput,
	advancedLoadDatumId,
	deriveAdvancedCaseListDatum,
	deriveCaseSelectionDatum,
	deriveSessionDatums,
	newCaseFunctionDatums,
	type SessionDatum,
	type StackQueryData,
	sessionDatumRequiresSelection,
} from "./session";
import {
	buildInlineSearch,
	type InlineSearchEmission,
	inlineSearchQueryMetadata,
	moduleUsesInlineSearch,
} from "./suite/case-search/inlineSearch";
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
	 * Present on the `<query>` session child of a menu whose forms read the search (HQ
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
		/** The menu whose search the query runs: the menu that supplies the
		 *  datum it feeds. Preview's bridge to that menu's search; never
		 *  suite wire. */
		readonly searchModuleUuid?: Uuid;
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
	 *  the results instance of a menu whose forms read the search before its datum reads it. */
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
	/**
	 * `emitted`: each module's entries are projected as the emitter writes
	 * that module. `basic`: every module's entries are projected as a basic
	 * module's, so a reader of this context never asks a module's kind; the
	 * kind reads which creates the links carry (`linkCarriedCreates`), which
	 * reads entries through such a context.
	 */
	readonly moduleKinds: "emitted" | "basic";
	readonly writesWorker?: (formUuid: Uuid) => boolean;
	/** The new cases each form's entry gives a datum, in HQ's order. */
	readonly newCaseDatums: (formUuid: Uuid) => readonly PlannedNewCaseDatum[];
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
	/** Stable command identity for runtime projections; never emitted on wire.
	 * A module command records the module whose screen its id names, which is
	 * the parent for a submenu that shows its forms there; a form command
	 * records its own module and form. */
	readonly commandTargets: WeakMap<
		FrameChild,
		{ moduleUuid: Uuid; formUuid?: Uuid }
	>;
	/** Root-computed datums copied into a child entry by `add_parent_datums`.
	 * Weak provenance keeps the session wire object unchanged. */
	readonly fromParentModuleDatums: WeakSet<SessionDatum>;
	/** The inline search of each menu whose forms read the search, built once per context. */
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
export const moduleCaseTypeForActions = domainModuleCaseTypeForActions;

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
		readonly moduleKinds?: "basic";
		/** Worker writes read from already-expanded actions (the compiler). */
		readonly writesWorker?: (formUuid: Uuid) => boolean;
		/** The new cases each entry gives a datum, when the caller has them. */
		readonly newCaseDatums?: (formUuid: Uuid) => readonly PlannedNewCaseDatum[];
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
	const newCaseDatums =
		opts.newCaseDatums ??
		((formUuid: Uuid) =>
			formCaseEntryPlan(
				doc,
				formUuid,
				opts.moduleKinds,
				opts.attachmentTarget != null,
			).datums);
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
		moduleKinds: opts.moduleKinds ?? "emitted",
		writesWorker: opts.writesWorker,
		newCaseDatums,
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
 * The inline search of a menu whose forms read the search, or `undefined` for any
 * other module. The compiler reads it for the strings; the datum
 * projection places its `<query>`.
 */
export function inlineSearchFor(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
): InlineSearchEmission | undefined {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined || !moduleUsesInlineSearch(mod)) return undefined;
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
 * HQ's `add_remote_query_datums`: the `<query>` of a menu whose forms read the search goes
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
					? moduleUsesInlineSearch(doc.modules[sourceUuid])
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

/** A form's suite command, `m{M}-f{K}`, in the projection's sequences. */
export function formCommandId(
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid: Uuid,
): string {
	return `m${moduleIndexOf(ctx, moduleUuid)}-f${formIndexOf(ctx, moduleUuid, formUuid)}`;
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
		const searchModuleUuid =
			next === undefined ? undefined : ctx.selectionSourceModules.get(next);
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
				...(searchModuleUuid !== undefined && { searchModuleUuid }),
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
			...(moduleUsesInlineSearch(selectedModule) && {
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
	// HQ aligns a child entry with its root's first form and with nothing
	// where the root has none (`EntriesHelper._get_first_forms_datums`). A
	// form-less root's basic browse selection is that nothing under the
	// child's own ids, so an advanced root's browse entry, whose datum HQ
	// names after the case type, is read as the basic one it stands for.
	const parentDatums =
		parent.kind === "form"
			? entrySessionDatums(doc, ctx, parent.module, parent.form)
			: basicCaseListSessionDatums(doc, ctx, parent.module);
	for (const issue of alignment.boundMismatches)
		ctx.onHqSelectionBoundMismatch?.(issue);
	if (alignment.parentSelectionConflict)
		ctx.onParentSelectionConflict?.(entry.module);
	if (parentDatums.length === 0) return current;
	const parentIds = new Set(parentDatums.map((datum) => datum.id));
	for (const datum of current) {
		if (parentIds.has(datum.id))
			datum.id = `${datum.id}_${datum.alignmentSuffix ?? datum.caseType ?? "child"}`;
	}
	const remaining = [...current];
	const prefix: SessionDatum[] = [];
	for (const parentDatum of parentDatums) {
		if (parentDatum.query !== undefined) continue;
		if (!sessionDatumRequiresSelection(parentDatum)) {
			// The copy is a placeholder: HQ asserts only the form's own loads.
			const { assertion: _rootAssertion, ...inherited } = parentDatum;
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
	if (ctx.moduleKinds === "emitted") {
		const plan = formCaseEntryPlan(
			doc,
			formUuid,
			undefined,
			ctx.attachmentTarget !== null,
		);
		if (plan.kind === "advanced") {
			const aligned = advancedEntrySessionDatums(
				doc,
				ctx,
				moduleUuid,
				formUuid,
				plan,
			);
			ctx.entryDatums.set(formUuid, aligned);
			return aligned;
		}
	}
	const caseType = moduleCaseTypeForActions(doc, moduleUuid);
	const selectionDatums = selectableDatums(doc, ctx, moduleUuid, form.type);
	const entryPlan = formCaseEntryPlan(
		doc,
		formUuid,
		ctx.moduleKinds === "basic" ? "basic" : undefined,
		ctx.attachmentTarget !== null,
	);
	const newCases = ctx.newCaseDatums(formUuid);
	const datums = deriveSessionDatums({
		expressions: moduleExpressionContexts(doc, moduleUuid, ctx.lookupNaming),
		formType: form.type,
		moduleIndex: moduleIndexOf(ctx, moduleUuid),
		...(caseType !== "" && { caseType }),
		caseSelectionDatums: selectionDatums,
		writesWorker: ctx.writesWorker?.(formUuid) ?? entryPlan.writesWorker,
		newCases,
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

/**
 * The entry of a form of an advanced menu, as HQ's build writes it
 * (`suite_xml/sections/entries.py::EntriesHelper.
 * configure_entry_advanced_form`):
 *
 * 1. each load's datum, in load order (`session.ts::
 *    deriveAdvancedLoadDatums`): a load chosen from its list module's list,
 *    after the first chosen under the one before it by its index name, and
 *    the worker's own record, selected on its own;
 * 2. aligned with the root menu's first form as `add_parent_datums` aligns
 *    them (`alignWithRootMenu`), the loads alone;
 * 3. then each new case an open action outside a repeat creates, in
 *    `open_cases` order, as the plan gives them (`casePlacementPlan.ts`'s
 *    `datums`), after the alignment, as HQ appends them
 *    (`get_new_case_id_datums_meta` runs after `add_parent_datums`).
 *
 * No query datum is written (a menu whose forms read its search is never
 * advanced) and no grouped tile companion (HQ's advanced entry writes none).
 *
 * A load keeps its list's `detail-confirm` unless a later load is chosen
 * under it and no open action indexes it: HQ reads the last action that
 * names the load as its parent, open actions after loads
 * (`AdvancedFormActions._action_meta`, `by_parent_tag`), and drops the
 * confirmation only where that is a load (`get_manual_datum`).
 */
function advancedEntrySessionDatums(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid: Uuid,
	plan: FormCaseEntryPlan,
): readonly SessionDatum[] {
	const { loads } = plan;
	const indexedByOpen = plan.indexedByOpen;
	const position = new Map(loads.map((load, index) => [load.tag, index]));
	// The load datums, the chain's at their chain positions, as they stand:
	// read when a filter that reads a case chosen
	// earlier in the chain renders, which is again after root alignment.
	let made: readonly SessionDatum[] = [];
	const inputs = loads.map((load, index): AdvancedLoadDatumInput => {
		const list =
			load.listModule === null ? undefined : doc.modules[load.listModule];
		const indexed =
			load.index === undefined ? undefined : position.get(load.index.tag);
		const chosenUnder =
			load.index === undefined || indexed === undefined
				? undefined
				: { load: indexed, identifier: load.index.identifier };
		if (list === undefined || load.listModule === null)
			return {
				tag: load.tag,
				caseType: load.caseType,
				...(chosenUnder !== undefined && { index: chosenUnder }),
			};
		const listModule = load.listModule;
		const indexedByLater = loads.some((other) => other.index?.tag === load.tag);
		const hasDetailScreen = (list.caseListConfig?.columns ?? []).some(
			(column) => column.visibleInDetail !== false,
		);
		const listIndex = moduleIndexOf(ctx, listModule);
		const datumId = (ref: DatumRef): string | undefined => {
			if (ref.kind !== "selected-case") return undefined;
			for (let earlier = 0; earlier < index; earlier++) {
				const other = loads[earlier];
				const datum = made[earlier];
				if (other === undefined || other.listModule === null) continue;
				if (
					other.listModule === ref.module ||
					(datum !== undefined &&
						ctx.alignedSelectionSources.get(datum) === ref.module)
				)
					return datum?.id ?? advancedLoadDatumId(other.tag);
			}
			return undefined;
		};
		return {
			tag: load.tag,
			caseType: load.caseType,
			list: {
				moduleIndex: listIndex,
				caseListFilter: list.caseListConfig?.filter,
				excludedOwnerIds: list.caseSearchConfig?.excludedOwnerIds,
				expressions: moduleExpressionContexts(
					doc,
					listModule,
					ctx.lookupNaming,
				),
				...(ctx.lookupNaming !== undefined && {
					lookupNaming: ctx.lookupNaming,
				}),
				...(list.caseListConfig?.tile?.persistOnForms === true && {
					persistentDetailId: `m${listIndex}_case_short`,
				}),
				detailConfirm:
					hasDetailScreen && (!indexedByLater || indexedByOpen.has(load.tag)),
				entryMetadataOnly: ctx.entryMetadataOnly,
				datumId,
			},
			...(chosenUnder !== undefined && { index: chosenUnder }),
		};
	});
	const loadDatums = deriveSessionDatums({
		formType: doc.forms[formUuid]?.type ?? "followup",
		moduleIndex: moduleIndexOf(ctx, moduleUuid),
		expressions: moduleExpressionContexts(doc, moduleUuid, ctx.lookupNaming),
		advancedLoads: inputs,
	});
	made = loadDatums;
	loads.forEach((load, index) => {
		const datum = loadDatums[index];
		if (datum === undefined || load.listModule === null) return;
		ctx.selectionSourceModules.set(datum, load.listModule);
		ctx.chainDatumIds.set(datum, datum.id);
	});
	const aligned = alignWithRootMenu(
		doc,
		ctx,
		{ kind: "form", module: moduleUuid, form: formUuid },
		loadDatums,
	);
	const newCases = ctx.newCaseDatums(formUuid);
	const created = newCaseFunctionDatums(newCases);
	return withInlineSearchQueries(doc, ctx, [...aligned, ...created]);
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
	// A load chosen from a list supplies its list module's selected case; a
	// load of the worker's record the worker's record; each new case's datum
	// (`casePlacementPlan.ts`'s `datums`: the case a registration opens,
	// `new-case`, and each basic subcase or open action outside a repeat,
	// `new-child-case`) the case it creates. So the rows of a menu emitted
	// advanced supply what the same menu's basic rows do, under other ids.
	// A new case is the datum that holds its planned id after root
	// alignment: the form's case block reads that id
	// (`models/forms.py::FormBase.session_var_for_action`,
	// `xform.py::_create_casexml_advanced` over `case_session_var`), so where
	// the root's placeholder of the same id renames the form's own datum
	// (`entries.py::EntriesHelper.add_parent_datums`), the placeholder mints
	// the case and the renamed datum is read by nothing.
	const newCaseRefs = new Map(
		formUuid === undefined
			? []
			: ctx
					.newCaseDatums(formUuid)
					.map((created) => [created.id, created.ref] as const),
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
		} else if (datum.id === USERCASE_DATUM_ID || datum.workerRecord === true) {
			refs.push({ kind: "worker-record" });
		} else if (grouping !== undefined) {
			refs.push({ kind: "tile-group-parents", module: grouping });
		} else {
			const created = newCaseRefs.get(datum.id);
			if (created !== undefined) refs.push(created);
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

/**
 * The id of the datum that supplies each ref. A ref two rows supply (two
 * creates of one type outside a repeat both give `new-child-case`) names the
 * first in entry order, the datum HQ's `_find_best_match` carries for a
 * link that matches by case type (`workflow.py`).
 */
export function entryDatumIdResolver(
	rows: readonly EntryDatumId[],
): (ref: DatumRef) => string | undefined {
	const ids = new Map<string, string>();
	for (const row of rows)
		for (const ref of row.refs) {
			const key = datumRefKey(ref);
			if (!ids.has(key)) ids.set(key, row.id);
		}
	return (ref) => ids.get(datumRefKey(ref));
}

/**
 * The datum ids a module's case list step prints, by ref: the rows its
 * case-list entry holds before the module's own selection datum. Every entry that reaches the list prints a
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

/**
 * The datum list of a menu's case list entry (`Module.caseListMenuItem`). A
 * menu emitted advanced writes HQ's advanced case list entry, one datum over
 * every open case of its type (`session.ts::deriveAdvancedCaseListDatum`),
 * beside its forms or alone; every other menu its basic entry, the datums a
 * case-loading form of the menu gets (`basicCaseListSessionDatums`, HQ's
 * `EntriesHelper.configure_entry_module_form` with no form).
 */
export function caseListSessionDatums(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
): readonly SessionDatum[] {
	const mod = doc.modules[moduleUuid];
	if (
		ctx.moduleKinds === "emitted" &&
		mod !== undefined &&
		moduleHasCaseListMenuItem(mod) &&
		mod.caseType &&
		emittedModuleKind(doc, moduleUuid) === "advanced"
	) {
		const moduleIndex = moduleIndexOf(ctx, moduleUuid);
		const datum = deriveAdvancedCaseListDatum({
			caseType: mod.caseType,
			moduleIndex,
			expressions: moduleExpressionContexts(doc, moduleUuid, ctx.lookupNaming),
			hasDetailScreen: (mod.caseListConfig?.columns ?? []).some(
				(column) => column.visibleInDetail !== false,
			),
			...(mod.caseListConfig?.tile?.persistOnForms === true && {
				persistentDetailId: `m${moduleIndex}_case_short`,
			}),
			entryMetadataOnly: ctx.entryMetadataOnly,
		});
		ctx.selectionSourceModules.set(datum, moduleUuid);
		ctx.chainDatumIds.set(datum, datum.id);
		return [datum];
	}
	return basicCaseListSessionDatums(doc, ctx, moduleUuid);
}

/** Root-aware datum list for the case list entry of a basic menu, with the
 *  inline query before its selection where the forms read the search
 *  (HQ's `add_remote_query_datums`). */
function basicCaseListSessionDatums(
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

/** The first selection in the common prefix of the root lists: the chosen
 *  case HQ puts ahead of every frame built through the first menu. Undefined
 *  where that prefix holds no selection. The root lists are the form entries
 *  of every module that shows its forms above, whichever screen lists them,
 *  in module then form order (HQ's `WorkflowHelper._root_module_datums`); a
 *  case list entry is never one (`_get_entries_datums`). */
export function firstMenuSharedCase(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
): FrameDatum | undefined {
	return commonPrefixById(rootFrameDatumLists(doc, ctx)).find(
		(datum) => datum.requiresSelection,
	);
}

/** HQ's `id_strings.menu_id`: the root menu's id. */
export const ROOT_MENU_ID = "root";

/**
 * HQ's `id_strings.menu_id`: the id of the `<menu>` that lists the module's
 * forms. `m<M>` for a module with its own screen; for one that shows its
 * forms in the menu above, its parent's id, which is `root` where the parent
 * shows its forms above too; `root` for a top-level one.
 */
export function menuIdOf(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
): string {
	const screen = menuScreenOf(doc, moduleUuid);
	return screen.kind === "first-menu"
		? ROOT_MENU_ID
		: `m${moduleIndexOf(ctx, screen.moduleUuid)}`;
}

/** The form entries of every module that shows its forms above, whichever
 *  screen lists it, in module then form order (HQ's
 *  `WorkflowHelper._root_module_datums`); a case list entry is never one
 *  (`_get_entries_datums` skips `*-case-list`). */
function rootFrameDatumLists(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
): (readonly FrameDatum[])[] {
	return ctx.moduleOrder
		.filter((moduleUuid) =>
			moduleShowsFormsInMenuAbove(doc.modules[moduleUuid]),
		)
		.flatMap((moduleUuid) => moduleFormDatumLists(doc, ctx, moduleUuid));
}

/** The datum list of each of the module's form entries, in form order. */
function moduleFormDatumLists(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
): (readonly FrameDatum[])[] {
	return (ctx.formOrder[moduleUuid] ?? []).map((formUuid) =>
		entryFrameDatums(doc, ctx, moduleUuid, formUuid),
	);
}

/** The datum lists `get_frame_children` takes the common prefix of: the
 *  module's own form entries, or, where its menu id is `root`, the form
 *  entries of every module that shows its forms above, in module then form
 *  order (`WorkflowHelper._root_module_datums`). */
function frameDatumLists(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
): (readonly FrameDatum[])[] {
	return menuScreenOf(doc, moduleUuid).kind === "first-menu"
		? rootFrameDatumLists(doc, ctx)
		: moduleFormDatumLists(doc, ctx, moduleUuid);
}

/** The module command, or nothing where the menu id is `root`. The command
 *  is recorded against the module whose screen its id names. */
function menuCommand(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
): FrameChild[] {
	const screen = menuScreenOf(doc, moduleUuid);
	if (screen.kind === "first-menu") return [];
	return [frameCommand(ctx, screen.moduleUuid)];
}

/** Whether a selection datum stands before the frame's first command. */
export function frameLeadsWithSelection(
	children: readonly FrameChild[],
): boolean {
	for (const child of children) {
		if (child.type === "command") return false;
		if (child.datum.requiresSelection) return true;
	}
	return false;
}

/**
 * HQ's `get_frame_children(module, form)` for a form target, or its
 * `_frame_children_for_module(module, include_user_selections=False)` for a
 * module target. The target is resolved (`resolveFormLinkTarget`), so
 * `this-form` reads as the source form in its own menu.
 */
export function targetFrameChildren(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	target: ResolvedFormLinkTarget,
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

/**
 * HQ's `WorkflowHelper.get_frame_children(module, form, include_root_module)`:
 * the module command (none where the menu id is `root`), the common prefix
 * by id of `frameDatumLists`, then for a form its command and its own datums
 * past that prefix. `includeRootModule` (the `previous` frame) adds, for a
 * submenu whose menu id is not `root`, the form entries of the module whose
 * index the parent's menu id names (none where it is `root`) and that
 * parent's command ahead of the module's.
 */
function frameChildrenOf(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid?: Uuid,
	includeRootModule = false,
): FrameChild[] {
	const children: FrameChild[] = [];
	const lists = [...frameDatumLists(doc, ctx, moduleUuid)];
	if (menuScreenOf(doc, moduleUuid).kind !== "first-menu") {
		const parentUuid = moduleParent(doc, moduleUuid);
		if (includeRootModule && parentUuid !== undefined && parentUuid !== null) {
			const parentScreen = menuScreenOf(doc, parentUuid);
			if (parentScreen.kind === "menu")
				lists.push(...moduleFormDatumLists(doc, ctx, parentScreen.moduleUuid));
			children.push(...menuCommand(doc, ctx, parentUuid));
		}
		children.push(...menuCommand(doc, ctx, moduleUuid));
	}
	const common = commonPrefixById(lists);
	children.push(...common.map((datum) => ({ type: "datum" as const, datum })));
	if (formUuid === undefined) return children;
	children.push(frameCommand(ctx, moduleUuid, formUuid));
	const remaining = entryFrameDatums(doc, ctx, moduleUuid, formUuid).slice(
		common.length,
	);
	children.push(
		...remaining.map((datum) => ({ type: "datum" as const, datum })),
	);
	return children;
}

/** `_frame_children_for_module(module, include_user_selections=False)`:
 * the parent's `get_frame_children` with its common user selections, then
 * the module's own command, none where its menu id is `root`. */
export function moduleFrameChildren(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
): FrameChild[] {
	const parentUuid = moduleParent(doc, moduleUuid);
	return [
		...(parentUuid === undefined || parentUuid === null
			? []
			: frameChildrenOf(doc, ctx, parentUuid)),
		...menuCommand(doc, ctx, moduleUuid),
	];
}

/** The id a frame child is compared by in HQ's parent prepend: a command's
 *  or a datum's. */
function frameChildId(child: FrameChild): string {
	return child.type === "command" ? child.id : child.datum.id;
}

/** `get_frame_children(module, form)` plus HQ's
 * `prepend_parent_frame_children`: the parent's `get_frame_children`, then
 * every child of the form's own frame whose id the parent part does not
 * hold. */
export function formFrameChildren(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid: Uuid,
): FrameChild[] {
	const base = frameChildrenOf(doc, ctx, moduleUuid, formUuid);
	const parentUuid = moduleParent(doc, moduleUuid);
	if (parentUuid === undefined || parentUuid === null) return base;
	const prefix = frameChildrenOf(doc, ctx, parentUuid);
	const prefixedIds = new Set(prefix.map(frameChildId));
	return [
		...prefix,
		...base.filter((child) => !prefixedIds.has(frameChildId(child))),
	];
}

/** The selection datums a target needs: what a link must carry or match. */
export function targetSelectionDatums(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	target: ResolvedFormLinkTarget,
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
	target: ResolvedFormLinkTarget,
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
	const children = frameChildrenOf(doc, ctx, moduleUuid, formUuid, true);
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

/** One return frame of a registration form a case list offers. */
export interface CaseListFormReturnFrame {
	readonly ifClause: WireExpr;
	readonly children: MatchedChild[];
	/** The frame's children before matching, cut where `children` is cut:
	 *  what Preview's `screenOfFrame` reads. Never emitted. */
	readonly target: readonly FrameChild[];
	/** The menus whose search the frame runs again over the new case alone:
	 *  each query child it keys to the form's new case, named by the menu
	 *  that searches (`FrameDatum.query.searchModuleUuid`). That menu's
	 *  Results, and its forms' read of what the search found, hold that one
	 *  case. What Preview reads; never emitted. */
	readonly newCaseSearchModuleUuids: readonly Uuid[];
}

/** HQ's `_add_stack_children_for_target` adds a module's children only
 *  where it has forms or a case list shown as a menu entry. */
function returnFramePassReads(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
): boolean {
	const mod = doc.modules[moduleUuid];
	return (
		(ctx.formOrder[moduleUuid] ?? []).length > 0 ||
		(mod !== undefined && moduleHasCaseListMenuItem(mod))
	);
}

/**
 * HQ's `CaseListFormWorkflow` frames for a registration form a host's case
 * list offers (`get_stack_frames_for_case_list_form_target`), built in its
 * two passes (`_add_stack_children_for_target`): for a host with a parent,
 * the parent's `get_frame_children`, then the host's own (its menu command
 * and the common datum prefix of its form entries), each pass read only for
 * a module with forms or a case list menu entry. Each pass's children are
 * matched to the form's datums (`_get_datums_matched_to_source`), which
 * matches every target datum on its own: a selection of `caseType` reads
 * the form's new case and a query whose next datum selects `caseType` is
 * re-keyed to that case; any other selection reads its own session value,
 * as HQ's unmatched target does.
 *
 * `case-list` (`post_form_workflow: case_list`) is one frame. Each pass adds
 * its children up to its first matched selection
 * (`CaseListFormStackFrames.add_children` breaks at `source_session_var`
 * within one call, and the next pass adds again), so the worker returns to
 * the host's screen with no case chosen; for a host whose forms read the
 * search that is the module command plus the results query keyed to the new
 * case. `new-case` (`default`) is two frames, in this order: one guarded by
 * the new case being on the device and holding every child, each matched
 * selection reading the new case, then one guarded by its absence and cut as
 * `case-list` is. In `new-case` the host pass drops every child whose id, a
 * command's or a datum's, the first frame already holds (`ids_on_stack`,
 * which is empty without that frame, so `case-list` keeps such a child).
 * Each guard opens with `count(S/return_to) = 1 and S/return_to = 'm{H}'`
 * (`get_if_clause`), so nothing fires unless the host's Register action
 * opened the form.
 *
 * HQ's `_get_entries_datums` reads form entries only (`_include_datums`
 * skips the `*-case-list` entry), so a host without menu forms has no common
 * prefix: its pass is its command alone, and the worker returns to the
 * module rather than to a Results keyed to the new case.
 *
 * `newCaseId` is the form's own new-case datum (`case_id_new_<t>_0`).
 */
export function caseListFormReturnFrames(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	hostUuid: Uuid,
	newCaseId: string,
	caseType: string,
	afterSubmit: CaseListRegistrationReturn,
): readonly CaseListFormReturnFrame[] {
	const parentUuid = moduleParent(doc, hostUuid);
	const passes = [
		...(parentUuid !== undefined && parentUuid !== null ? [parentUuid] : []),
		hostUuid,
	]
		.filter((moduleUuid) => returnFramePassReads(doc, ctx, moduleUuid))
		.map((moduleUuid) => frameChildrenOf(doc, ctx, moduleUuid));
	/* A selection of `caseType`, which reads the new case, and a query whose
	 * next datum is one, which fetches it. */
	const selectsNewCase = (child: FrameChild): boolean =>
		child.type === "datum" &&
		child.datum.query === undefined &&
		child.datum.requiresSelection &&
		child.datum.caseType === caseType;
	const readsNewCase = (child: FrameChild): boolean =>
		selectsNewCase(child) ||
		(child.type === "datum" &&
			child.datum.query !== undefined &&
			child.datum.caseType === caseType);
	const matched = (child: FrameChild): PendingChild => {
		if (child.type === "command") return child;
		const { datum } = child;
		if (datum.query !== undefined)
			return queryChild(
				datum,
				readsNewCase(child) ? newCaseId : datum.query.nextDatumId,
			);
		if (!datum.requiresSelection) return functionChild(datum);
		return {
			type: "datum",
			id: datum.id,
			value: sessionDataRef(readsNewCase(child) ? newCaseId : datum.id),
		};
	};
	const sources = new Set([newCaseId]);
	type Built = { readonly target: FrameChild; readonly pending: PendingChild };
	const full: Built[] = [];
	const cut: Built[] = [];
	for (const pass of passes) {
		const onStack = new Set(full.map((built) => frameChildId(built.target)));
		let reachedNewCase = false;
		for (const child of pass) {
			if (afterSubmit === "new-case" && onStack.has(frameChildId(child)))
				continue;
			const built = { target: child, pending: matched(child) };
			full.push(built);
			if (selectsNewCase(child)) reachedNewCase = true;
			if (!reachedNewCase) cut.push(built);
		}
	}
	const frameOf = (
		built: readonly Built[],
		ifClause: WireExpr,
	): CaseListFormReturnFrame => ({
		ifClause,
		children: replaceSessionReferences(
			built.map((child) => child.pending),
			sources,
		),
		target: built.map((child) => child.target),
		newCaseSearchModuleUuids: built.flatMap(({ target }) =>
			target.type === "datum" &&
			target.datum.query?.searchModuleUuid !== undefined &&
			readsNewCase(target)
				? [target.datum.query.searchModuleUuid]
				: [],
		),
	});
	const returnTo = sessionDataRef(RETURN_TO_DATUM_ID);
	const command = `m${moduleIndexOf(ctx, hostUuid)}`;
	const guard = (...extra: WireExpr[]): WireExpr =>
		w.and(
			w.eq(w.call("count", [returnTo]), w.num(1)),
			w.eq(returnTo, w.str(command)),
			...extra,
		);
	if (afterSubmit === "case-list") return [frameOf(cut, guard())];
	const newCaseCount = w.call("count", [
		caseById(sessionDataRef(newCaseId), "casedb"),
	]);
	return [
		frameOf(full, guard(w.gt(newCaseCount, w.num(0)))),
		frameOf(cut, guard(w.eq(newCaseCount, w.num(0)))),
	];
}

/** The entry's new-case datum for `caseType` (`case_id_new_<type>_0`): the
 *  session value a registration's own new case, or a basic child of that
 *  type, takes. Undefined where the entry gives the form no new case of the
 *  type. */
export function entryNewCaseDatumId(
	datums: readonly SessionDatum[],
	caseType: string,
): string | undefined {
	return datums.find(
		(candidate) =>
			candidate.nodeset === undefined &&
			candidate.caseType === caseType &&
			candidate.id.startsWith("case_id_new_"),
	)?.id;
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
 * `get_frame_children`, its selections kept. A module with no parent has
 * none.
 */
export function parentMenuDestinationFrameChildren(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
): MatchedChild[] {
	const parentUuid = moduleParent(doc, moduleUuid);
	if (parentUuid === undefined || parentUuid === null) return [];
	const pending: PendingChild[] = frameChildrenOf(doc, ctx, parentUuid).map(
		staticFrameChild,
	);
	return replaceSessionReferences(pending, new Set());
}

// ── The whole-form projection ────────────────────────────────────────────

export interface ProjectedFormLink {
	readonly uuid: Uuid;
	/** A destination of `formLinks`, or the form's otherwise link. */
	readonly role: "destination" | "otherwise";
	/** The suite `<create if>` / HQ `xpath`; absent = unconditional. */
	readonly xpath?: WireExpr;
	/** The resolved target: `this-form` is the source form in its menu. */
	readonly target: ResolvedFormLinkTarget;
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

/** HQ's fallback frame (`workflow.py::_get_fallback_frame`): a built-in
 *  otherwise beside at least one destination whose `xpath` is not blank. */
export type ProjectedAfterSubmitFallback =
	| { readonly kind: "none" }
	| {
			readonly kind: "built-in";
			readonly destination: OtherwiseDestination;
			/** `not(x_1) and … and not(x_n)` over every emitted destination
			 *  `xpath`, in emitted order. */
			readonly xpath: WireExpr;
	  };

export interface ProjectedAfterSubmit {
	/** In emitted order: the destinations in REVERSE array order, then the
	 *  otherwise link when the otherwise is one. */
	readonly links: readonly ProjectedFormLink[];
	readonly fallback: ProjectedAfterSubmitFallback;
}

/**
 * Whether the projection of `formUuid`'s links is DEFINED: every target
 * resolves, every module it reads sits in the module sequence with a
 * well-formed case type, and `buildFormActions` is defined for every form it
 * reads — the source form,
 * every form of every target module (a form target's frame carries the
 * module's common-prefix datums, which read every form in it), and every
 * structural ancestor form whose datums a child entry inherits. The wire
 * builder fails closed on a module outside the sequence, a case type that
 * is not an identifier, or a form whose own case is missing, doubled, out
 * of place or, on a registration, unnamed — each a finding of its own
 * (`INVALID_CASE_TYPE_FORMAT`, `CASE_OPERATION_INVALID_CASE_TYPE`,
 * `CASE_OWN_OPERATION`, `CASE_CREATE_NAME_MISSING`, the topology checks) — so the validator asks this first and never dies where another
 * rule reports. The check reads the same own-case statement
 * (`ownCaseOperationFindings.ts`) and the same grammars the builder does.
 */
export function formLinkActionsBuildable(
	doc: BlueprintDoc,
	formUuid: Uuid,
	links: readonly { readonly target: FormLinkTarget }[],
): boolean {
	const source = doc.moduleOrder.find((uuid) =>
		(doc.formOrder[uuid] ?? []).includes(formUuid),
	);
	if (source === undefined) return false;
	const targets: Uuid[] = [];
	for (const link of links) {
		const target = resolveFormLinkTarget(doc, formUuid, link.target);
		if (target === undefined) return false;
		targets.push(target.moduleUuid);
	}
	return moduleFrameActionsBuildable(doc, [source, ...targets]);
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
	for (const uuid of forms) {
		const form = doc.forms[uuid];
		const moduleUuid = moduleOf(uuid);
		if (form === undefined || moduleUuid === undefined) return false;
		const caseType = moduleCaseTypeForActions(doc, moduleUuid);
		if (
			ownCaseOperationFindings({
				form,
				formUuid: uuid,
				moduleUuid,
				moduleName: doc.modules[moduleUuid]?.name ?? "",
				caseType,
			}).length > 0
		)
			return false;
		if (
			!(form.caseOperations ?? []).every(
				(operation) =>
					operation.action === "own" || wellFormedCaseType(operation.caseType),
			)
		)
			return false;
		// The wire plan names the new case from the registration's own name
		// (`CASE_CREATE_NAME_MISSING` without one), and reaches each question
		// by its id (`INVALID_FIELD_ID` for one that is no XML name).
		if (
			form.type === "registration" &&
			caseType !== "" &&
			form.caseOperations?.find((operation) => operation.action === "own")
				?.name === undefined
		)
			return false;
		for (const fieldUuid of descendantFieldUuids(doc, uuid))
			if (!XML_ELEMENT_NAME_REGEX.test(doc.fields[fieldUuid]?.id ?? ""))
				return false;
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
 * answer reads the own case of every form the menu reaches. */
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
		form: formNodeProjection(doc, structure, { surface: "wire" }),
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
 * The held-case guards of one link (`lib/domain/afterSubmit.ts::
 * guardedLinkDatums`): for each carried value that lands on a single-case
 * selection of the target, in `datums` order,
 * `count(instance('casedb')/casedb/case[@case_id = V and @case_type = 'T']) > 0`,
 * where `V` is the same wire tree the frame prints into the datum and `T`
 * the case type of the selection datum it lands on (no type test when that
 * datum has none). A frame whose carried case is not on the device then
 * never opens, so CommCare HQ never receives an update to a case nothing
 * created. `projected` holds the link's carried values as the projection
 * printed them, index for index with `link.datums`.
 */
export function formLinkCarriedCaseGuards(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	sourceFormUuid: Uuid,
	link: {
		readonly target: FormLinkTarget;
		readonly datums?: readonly FormLinkDatum[];
	},
	projected: ReadonlyArray<{ readonly name: string; readonly xpath: WireExpr }>,
): WireExpr[] {
	const guarded = new Set(
		guardedLinkDatums(doc, sourceFormUuid, link).map((datum) =>
			datumRefKey(datum.name),
		),
	);
	if (guarded.size === 0) return [];
	const target = resolveFormLinkTarget(doc, sourceFormUuid, link.target);
	if (target === undefined) return [];
	const caseTypes = new Map(
		targetSelectionDatums(doc, ctx, target).map((datum) => [
			datum.id,
			datum.caseType,
		]),
	);
	return (link.datums ?? []).flatMap((datum, index) => {
		const value = projected[index];
		if (!guarded.has(datumRefKey(datum.name)) || value === undefined) return [];
		const caseType = caseTypes.get(value.name);
		return [
			w.gt(
				w.call("count", [
					caseById(
						value.xpath,
						"casedb",
						caseType === undefined || caseType === "" ? undefined : caseType,
					),
				]),
				w.num(0),
			),
		];
	});
}

/** One link of the form as the frame algorithm projects it, before its
 *  emitted `xpath` is known. */
function projectFormLinkFrame(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	formUuid: Uuid,
	link: {
		readonly uuid: Uuid;
		readonly target: FormLinkTarget;
		readonly datums?: readonly FormLinkDatum[];
	},
	sourceDatums: readonly FrameDatum[],
	sourceIds: ReadonlySet<string>,
): {
	readonly frame: Omit<ProjectedFormLink, "role" | "xpath" | "uuid">;
	readonly guards: readonly WireExpr[];
} {
	const resolved = resolveFormLinkTarget(doc, formUuid, link.target);
	if (resolved === undefined)
		throw new Error(
			"The after-submit link starts this form again, but the form is in no menu.",
		);
	const target = targetFrameChildren(doc, ctx, resolved);
	const targetDatumId = entryDatumIdResolver(
		formLinkTargetDatumIds(doc, ctx, resolved),
	);
	const datums = (link.datums ?? []).map((datum) => {
		const name = targetDatumId(datum.name);
		if (name === undefined)
			throw new Error("The linked entry does not supply this selected record.");
		return {
			name,
			xpath: projectFormLinkSessionExpression(doc, ctx, formUuid, datum.xpath, {
				entity: "form",
				uuid: formUuid,
				slot: "form_link_datum_xpath",
				member: { linkUuid: link.uuid, datum: datum.name },
			}),
		};
	});
	const guards = formLinkCarriedCaseGuards(doc, ctx, formUuid, link, datums);
	if (link.datums !== undefined) {
		const manual = projectManualSearchLink(
			target,
			datums,
			sourceDatums,
			sourceIds,
		);
		const { match } = manual;
		return {
			guards,
			frame: {
				target: resolved,
				children: match.children,
				datums: manual.datums,
				...(manual.unrepresentableQueryDatums.length > 0 && {
					unrepresentableQueryDatums: manual.unrepresentableQueryDatums,
				}),
				unmatched: [],
				missing: match.missing,
				unused: match.unused,
			},
		};
	}
	const match = matchFrameToSource(target, sourceDatums);
	return {
		guards,
		frame: {
			target: resolved,
			children: match.children,
			datums,
			unmatched: match.unmatched,
			missing: [],
			unused: [],
		},
	};
}

/** The conjunction of `parts`, or nothing when there are none: an
 *  unconditional frame carries no `if`. */
function conjunction(parts: readonly WireExpr[]): WireExpr | undefined {
	return parts.length === 0 ? undefined : w.and(...parts);
}

/**
 * Project one form's after-submit, or `undefined` when it has no
 * destinations. Pure over the document and the context; the expander (HQ
 * JSON), the compiler (local suite), and the validator (datum rules) all
 * read this one result.
 *
 * Every destination whose `xpath` holds is pushed, and the runtime runs the
 * last pushed first (`commcare-core CommCareSession::finishAndPop`), so the
 * destinations are emitted in reverse array order and the author's first
 * destination that holds runs first. A destination's `xpath` is its own
 * condition, then one held-case guard per guarded carried value. The
 * otherwise runs when no destination that may not run runs: as a link, its
 * `xpath` negates every non-blank destination `xpath` in emitted order and
 * then conjoins its own guards; as a built-in destination, it is HQ's
 * fallback frame over the same negations (`workflow.py::_get_fallback_frame`),
 * which HQ builds only when some `xpath` is not blank.
 */
export function projectAfterSubmit(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	formUuid: Uuid,
): ProjectedAfterSubmit | undefined {
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
	const sourceIds = new Set(sourceDatums.map((datum) => datum.id));
	const destinations: ProjectedFormLink[] = [];
	let otherwiseLink:
		| {
				readonly uuid: Uuid;
				readonly projected: ReturnType<typeof projectFormLinkFrame>;
		  }
		| undefined;
	for (const entry of formLinkEntries(form)) {
		const projected = projectFormLinkFrame(
			doc,
			ctx,
			formUuid,
			entry.link,
			sourceDatums,
			sourceIds,
		);
		if (entry.role === "otherwise") {
			otherwiseLink = { uuid: entry.link.uuid, projected };
			continue;
		}
		const condition =
			entry.link.condition === undefined
				? []
				: [
						projectFormLinkSessionExpression(
							doc,
							ctx,
							formUuid,
							entry.link.condition,
							{
								entity: "form",
								uuid: formUuid,
								slot: "form_link_condition",
								member: { linkUuid: entry.link.uuid },
							},
						),
					];
		const xpath = conjunction([...condition, ...projected.guards]);
		destinations.push({
			uuid: entry.link.uuid,
			role: "destination",
			...(xpath !== undefined && { xpath }),
			...projected.frame,
		});
	}
	const emitted = destinations.reverse();
	const negations = emitted.flatMap((link) =>
		link.xpath === undefined ? [] : [w.not(link.xpath)],
	);
	if (otherwiseLink !== undefined) {
		const xpath = conjunction([
			...negations,
			...otherwiseLink.projected.guards,
		]);
		return {
			links: [
				...emitted,
				{
					uuid: otherwiseLink.uuid,
					role: "otherwise",
					...(xpath !== undefined && { xpath }),
					...otherwiseLink.projected.frame,
				},
			],
			fallback: { kind: "none" },
		};
	}
	const otherwise = form.otherwise;
	return {
		links: emitted,
		fallback:
			otherwise?.kind === "destination" && negations.length > 0
				? {
						kind: "built-in",
						destination: otherwise.destination,
						xpath: w.and(...negations),
					}
				: { kind: "none" },
	};
}

// ── Creates a link carries ───────────────────────────────────────────────

/**
 * The creates of `formUuid` that its after-submit links carry into a
 * target, each with the first link that carries it, in operation order: the
 * operations whose new case a link's target receives as its session datum.
 * The domain's one answer (`lib/domain/advancedEntryDatums.ts::
 * carriedCreates`), which the entry's session values read too, so the
 * placements, the menu's kind and the supplies cannot disagree.
 */
export function carriedCreateLinks(
	doc: BlueprintDoc,
	formUuid: Uuid,
): ReadonlyMap<Uuid, Uuid> {
	return carriedCreates(doc, formUuid);
}

/**
 * The creates of `formUuid` that its after-submit links carry into a target:
 * the operations whose new case a link's target receives as its session
 * datum, in operation order (`carriedCreateLinks`).
 */
export function linkCarriedCreates(
	doc: BlueprintDoc,
	formUuid: Uuid,
): ReadonlySet<Uuid> {
	return new Set(carriedCreates(doc, formUuid).keys());
}
