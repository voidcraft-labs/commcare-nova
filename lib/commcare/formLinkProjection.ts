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
 *     remaining datums; a module target is the module command alone
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
 * evaluates that to `""` at push time (`StackFrameStep.defineStep`),
 * `CommCareSession.syncState` stores the empty string, and
 * `getFirstMissingDatum` only checks `containsKey`, so the target form opens
 * with an empty case id. The projection therefore REPORTS every unmatched
 * selection datum (`unmatched` / `missing`) and the validator refuses the
 * document; the bytes are still total for parity's sake, but only links whose
 * frames resolve reach the wire.
 */

import { orderedFormUuids, orderedModuleUuids } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	deriveCaseWriteInventory,
	type FormLink,
	type FormLinkTarget,
	printXPath,
	type Uuid,
	type XPathExpression,
	xpathPrintContext,
} from "@/lib/domain";
import { caseWriteAdmissionIssues } from "./caseWriteAdmission";
import { XML_ELEMENT_NAME_REGEX } from "./constants";
import { buildFormActions } from "./formActions";
import { rewriteHashtags } from "./hashtags";
import {
	caseTypeDepthMap,
	expandHashtagsForSessionStack,
} from "./hashtags/formContext";
import type { LookupWireNaming } from "./lookup/naming";
import { deriveSessionDatums, type SessionDatum } from "./session";
import type { FormActions } from "./types";
import type { AttachmentUrlTarget } from "./xform/captureUrlNode";
import { lowerXPathForJavaRosa } from "./xpath";

// ── Frame vocabulary ─────────────────────────────────────────────────────

/**
 * One session datum as the frame algorithm sees it: HQ's
 * `WorkflowDatumMeta` (`id`, `requires_selection`, `case_type`, `function`).
 */
export interface FrameDatum {
	readonly id: string;
	/** A nodeset datum the person selects; a function datum is computed. */
	readonly requiresSelection: boolean;
	/** The case type the datum selects or creates; absent when it has none. */
	readonly caseType?: string;
	/** The XPath a function datum evaluates (`uuid()`). */
	readonly function?: string;
	/**
	 * Re-renders `function` with every `instance('commcaresession')/session/data/<id>`
	 * it reads supplied by the caller — how the grouped-tile companion datum
	 * follows HQ's `_replace_session_references_in_stack` without reading
	 * XPath back out of a string.
	 */
	readonly renderFunction?: (sessionRef: (datumId: string) => string) => string;
}

export type FrameChild =
	| { readonly type: "command"; readonly id: string }
	| { readonly type: "datum"; readonly datum: FrameDatum };

/** A frame child after matching: what the `<create>` carries. */
export type MatchedChild =
	| { readonly type: "command"; readonly id: string }
	| { readonly type: "datum"; readonly id: string; readonly value: string };

/** `instance('commcaresession')/session/data/<id>`, HQ's `session_var`. */
export function sessionDataRef(datumId: string): string {
	return `instance('commcaresession')/session/data/${datumId}`;
}

// ── Context ──────────────────────────────────────────────────────────────

/**
 * What the projection needs beyond the document: the sorted module / form
 * sequences (the suite's `m{i}` / `m{i}-f{j}` positions) and each form's
 * expanded actions (the datum list depends on which cases the form opens).
 */
export interface FormLinkProjectionContext {
	readonly moduleOrder: readonly Uuid[];
	readonly formOrder: Readonly<Record<string, readonly Uuid[]>>;
	readonly formActions: (formUuid: Uuid) => FormActions;
	readonly lookupNaming?: LookupWireNaming;
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
		readonly attachmentTarget?: AttachmentUrlTarget | null;
		readonly lookupNaming?: LookupWireNaming;
		/** Already-expanded actions, when the caller has them (the compiler). */
		readonly formActions?: (formUuid: Uuid) => FormActions;
	} = {},
): FormLinkProjectionContext {
	const moduleOrder = orderedModuleUuids(doc);
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
			);
			cache.set(formUuid, built);
			return built;
		});
	return {
		moduleOrder,
		formOrder,
		formActions,
		...(opts.lookupNaming !== undefined && { lookupNaming: opts.lookupNaming }),
	};
}

function moduleIndexOf(
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

function toFrameDatum(datum: SessionDatum): FrameDatum {
	return {
		id: datum.id,
		requiresSelection: datum.nodeset !== undefined,
		...(datum.caseType !== undefined && { caseType: datum.caseType }),
		...(datum.function !== undefined && { function: datum.function }),
		...(datum.renderFunction !== undefined && {
			renderFunction: datum.renderFunction,
		}),
	};
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
): FrameDatum[] {
	const form = doc.forms[formUuid];
	const mod = doc.modules[moduleUuid];
	if (form === undefined || mod === undefined) return [];
	const caseType = moduleCaseTypeForActions(doc, moduleUuid);
	return deriveSessionDatums({
		formType: form.type,
		moduleIndex: moduleIndexOf(ctx, moduleUuid),
		...(caseType !== "" && { caseType }),
		actions: ctx.formActions(formUuid),
		...(mod.caseListConfig?.tile?.grouping !== undefined && {
			tileGrouping: mod.caseListConfig.tile.grouping,
		}),
	}).map(toFrameDatum);
}

/** Longest common prefix of several datum lists, compared by id. */
function commonPrefixById(
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
	const moduleCommand = `m${moduleIndexOf(ctx, target.moduleUuid)}`;
	if (target.type === "module") return [{ type: "command", id: moduleCommand }];
	return formFrameChildren(doc, ctx, target.moduleUuid, target.formUuid);
}

/** `get_frame_children(module, form)`: m, common datums, m-f, the rest. */
export function formFrameChildren(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid: Uuid,
): FrameChild[] {
	const mIdx = moduleIndexOf(ctx, moduleUuid);
	const fIdx = formIndexOf(ctx, moduleUuid, formUuid);
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
		{ type: "command", id: `m${mIdx}` },
		...common.map((datum) => ({ type: "datum" as const, datum })),
		{ type: "command", id: `m${mIdx}-f${fIdx}` },
		...remaining.map((datum) => ({ type: "datum" as const, datum })),
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

// ── Matching ─────────────────────────────────────────────────────────────

/** A child before session-reference replacement. */
type PendingChild =
	| { readonly type: "command"; readonly id: string }
	| {
			readonly type: "datum";
			readonly id: string;
			readonly value: string;
			readonly renderFunction?: FrameDatum["renderFunction"];
	  };

function functionChild(datum: FrameDatum): PendingChild {
	return {
		type: "datum",
		id: datum.id,
		value: datum.function ?? "",
		...(datum.renderFunction !== undefined && {
			renderFunction: datum.renderFunction,
		}),
	};
}

/**
 * HQ's `_find_best_match`: the first source datum, in source order, whose
 * case type equals the target's. Same id keeps the target's id; a different
 * id means the frame reads the SOURCE's session value under the target's
 * id. Sources with no case type never match.
 */
function findBestMatch(
	target: FrameDatum,
	sources: readonly FrameDatum[],
): { readonly sourceId: string } | undefined {
	for (const source of sources) {
		if (source.caseType === undefined) continue;
		if (source.caseType !== target.caseType) continue;
		return { sourceId: source.id === target.id ? target.id : source.id };
	}
	return undefined;
}

export interface SourceMatch {
	readonly children: MatchedChild[];
	/** Selection datums no source datum could satisfy (HQ would emit a
	 *  self-named reference that resolves to an empty value). */
	readonly unmatched: FrameDatum[];
}

/** HQ's `_get_datums_matched_to_source`. */
export function matchFrameToSource(
	target: readonly FrameChild[],
	source: readonly FrameDatum[],
): SourceMatch {
	let unused = [...source];
	const pending: PendingChild[] = [];
	const unmatched: FrameDatum[] = [];
	for (const child of target) {
		if (child.type === "command") {
			pending.push(child);
			continue;
		}
		const { datum } = child;
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
	manual: readonly { readonly name: string; readonly xpath: string }[],
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
	const earlier = new Map<string, string>();
	return children.map((child) => {
		if (child.type === "command") return child;
		const value =
			child.renderFunction === undefined
				? child.value
				: child.renderFunction((id) => {
						const held = earlier.get(id);
						return held !== undefined && !sourceDatumIds.has(id)
							? held
							: sessionDataRef(id);
					});
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
	const children = [...formFrameChildren(doc, ctx, moduleUuid, formUuid)];
	let last = children.pop();
	while (
		last !== undefined &&
		last.type === "datum" &&
		!last.datum.requiresSelection
	) {
		last = children.pop();
	}
	const pending: PendingChild[] = children.map((child) =>
		child.type === "command"
			? child
			: child.datum.requiresSelection
				? {
						type: "datum",
						id: child.datum.id,
						value: sessionDataRef(child.datum.id),
					}
				: functionChild(child.datum),
	);
	return replaceSessionReferences(pending, new Set());
}

// ── Guards ───────────────────────────────────────────────────────────────

export interface GuardPlanLink {
	readonly uuid: Uuid;
	/** Projected wire XPath, trimmed and non-empty; absent = unconditional. */
	readonly condition?: string;
}

export type FallbackPlan =
	/** No conditional link exists: a sole unconditional link always fires. */
	| { readonly kind: "none" }
	/** A terminal unconditional link is the exhaustive else. */
	| { readonly kind: "suppressed-by-else" }
	/** The last link is conditional: the fallback fires when none matched. */
	| { readonly kind: "guarded"; readonly guard: string };

export interface GuardPlan {
	readonly links: ReadonlyArray<{
		readonly uuid: Uuid;
		/** The `if` to emit; absent = no `if` attribute. */
		readonly guard?: string;
	}>;
	readonly fallback: FallbackPlan;
}

/**
 * Exclusive guards over an ordered link list. Total over any input: an
 * unconditional link that is not last still gets its guard (the validator
 * refuses the document; the projection never throws).
 */
export function planFormLinkGuards(links: readonly GuardPlanLink[]): GuardPlan {
	const planned: Array<{ uuid: Uuid; guard?: string }> = [];
	const priors: string[] = [];
	for (const link of links) {
		const negatedPriors = priors.map((prior) => `not(${prior})`);
		if (link.condition === undefined) {
			planned.push({
				uuid: link.uuid,
				...(negatedPriors.length > 0 && { guard: negatedPriors.join(" and ") }),
			});
			continue;
		}
		const guard =
			negatedPriors.length === 0
				? link.condition
				: [`(${link.condition})`, ...negatedPriors].join(" and ");
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
						guard: planned
							.flatMap((link) => (link.guard === undefined ? [] : [link.guard]))
							.map((guard) => `not(${guard})`)
							.join(" and "),
					};
	return { links: planned, fallback };
}

// ── The whole-form projection ────────────────────────────────────────────

export interface ProjectedFormLink {
	readonly uuid: Uuid;
	/** The suite `<create if>` / HQ `xpath`; absent = unconditional. */
	readonly guard?: string;
	readonly target: FormLinkTarget;
	/** The local frame's children after matching. */
	readonly children: MatchedChild[];
	/** The authored manual datums projected to wire XPath (HQ `datums`). */
	readonly datums: ReadonlyArray<{
		readonly name: string;
		readonly xpath: string;
	}>;
	/** Validator inputs; all empty on a document the gate admits. */
	readonly unmatched: readonly FrameDatum[];
	readonly missing: readonly FrameDatum[];
	readonly unused: readonly string[];
}

export interface ProjectedFormLinks {
	readonly links: readonly ProjectedFormLink[];
	readonly fallback: FallbackPlan;
}

/**
 * Whether the session-scope wire projection is defined for `expression`.
 * `formLinkWireProjector` throws on a form-local read (`#form/`, a field or
 * path reference) and on a raw `#case/` spelling — neither is a session-scope
 * expression, and the deep validator refuses both with a finding of its own.
 * A rule that projects links asks this first, through the same Lezer walk
 * the projector rewrites with, so every validator rule stays total over any
 * schema-valid document instead of dying where another rule would report.
 */
export function formLinkExpressionProjectable(
	doc: BlueprintDoc,
	expression: XPathExpression,
): boolean {
	if (
		expression.parts.some(
			(part) => part.kind === "field-ref" || part.kind === "path-ref",
		)
	) {
		return false;
	}
	let projectable = true;
	rewriteHashtags(
		printXPath(expression, xpathPrintContext(doc)),
		(typeName) => {
			if (typeName === "form" || typeName === "case") projectable = false;
			return undefined;
		},
	);
	return projectable;
}

/** Whether every condition and datum on `links` is projectable. */
export function formLinksProjectable(
	doc: BlueprintDoc,
	links: readonly FormLink[],
): boolean {
	return links.every(
		(link) =>
			(link.condition === undefined ||
				formLinkExpressionProjectable(doc, link.condition)) &&
			(link.datums ?? []).every((datum) =>
				formLinkExpressionProjectable(doc, datum.xpath),
			),
	);
}

/**
 * Whether `buildFormActions` is defined for every form the projection of
 * `formUuid`'s links reads: the source form, and every form of every target
 * module (a form target's frame carries the module's common-prefix datums,
 * which read every form in it). The wire builder fails closed on a form
 * whose case writes the admission refuses or whose field ids are not XML
 * names — each a finding of its own (`CASE_WRITE_*` / `CASE_CREATE_NAME_*` /
 * `INVALID_FIELD_ID`) — so the validator asks this first and never dies
 * where another rule reports. The check reads the same inventory, the same
 * admission, and the same name grammar the builder does.
 */
export function formLinkActionsBuildable(
	doc: BlueprintDoc,
	formUuid: Uuid,
	links: readonly FormLink[],
): boolean {
	const moduleOf = (uuid: Uuid): Uuid | undefined =>
		doc.moduleOrder.find((moduleUuid) =>
			(doc.formOrder[moduleUuid] ?? []).includes(uuid),
		);
	const forms = new Set<Uuid>([formUuid]);
	for (const link of links) {
		for (const uuid of doc.formOrder[link.target.moduleUuid] ?? []) {
			forms.add(uuid);
		}
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
		if (
			!inventory.buckets.every(
				(bucket) =>
					xmlNames(bucket.repeatPath) &&
					bucket.writers.every((writer) => xmlNames(writer.path)),
			)
		) {
			return false;
		}
	}
	return true;
}

/** A link is conditional when its condition prints to non-empty XPath. */
export function formLinkIsConditional(
	link: Pick<FormLink, "condition">,
	project: (expression: XPathExpression) => string,
): boolean {
	return link.condition !== undefined && project(link.condition).length > 0;
}

/** The session-scope wire projection of a link condition or datum XPath. */
export function formLinkWireProjector(
	doc: BlueprintDoc,
	moduleCaseType: string | undefined,
): (expression: XPathExpression) => string {
	const ctx = xpathPrintContext(doc);
	const depths = caseTypeDepthMap(moduleCaseType, doc.caseTypes ?? []);
	return (expression) =>
		lowerXPathForJavaRosa(
			expandHashtagsForSessionStack(printXPath(expression, ctx), depths),
		).trim();
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
	const project = formLinkWireProjector(doc, doc.modules[moduleUuid]?.caseType);
	const guards = planFormLinkGuards(
		links.map((link) => ({
			uuid: link.uuid,
			...(formLinkIsConditional(link, project) &&
				link.condition !== undefined && {
					condition: project(link.condition),
				}),
		})),
	);
	const sourceDatums = entryFrameDatums(doc, ctx, moduleUuid, formUuid);
	const sourceIds = new Set(sourceDatums.map((datum) => datum.id));
	const projected = links.map((link, index): ProjectedFormLink => {
		const target = targetFrameChildren(doc, ctx, link.target);
		const guard = guards.links[index]?.guard;
		const datums = (link.datums ?? []).map((datum) => ({
			name: datum.name,
			xpath: project(datum.xpath),
		}));
		if (link.datums !== undefined) {
			const match = matchFrameToManual(target, datums, sourceIds);
			return {
				uuid: link.uuid,
				...(guard !== undefined && { guard }),
				target: link.target,
				children: match.children,
				datums,
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
