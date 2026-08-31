// lib/doc/formLinkReview.ts
//
// What an author must be told BEFORE a link is added, moved, retargeted,
// or asked to carry values — pure verdicts over the document, derived from
// the same facts the validator and the wire read. Nothing here decides
// legality on its own: `formLinkMoveVerdicts` and `formLinkTargetVerdict`
// restate the positional and destination rules (`FORM_LINK_UNREACHABLE`,
// `FORM_LINK_SELF_REFERENCE`, `FORM_LINK_CIRCULAR`, and
// `FORM_LINK_SELECTION_CARDINALITY`) so a surface can refuse before it offers,
// and `formLinkCarryVerdict` asks the ONE projector the
// wire uses whether the destination's selection datums can be carried
// automatically (`FORM_LINK_DATUMS_INCOMPLETE`'s question, asked ahead of
// time). `components/builder/form-links/__tests__/formLinkValidByConstruction.test.ts`
// pins every `ok` against `mutationCommitVerdict`.
//
// Pure and cheap: every map is O(n²) over a form's links, and n is the
// number of destinations a person can name, not the number of cases.

import {
	entryFrameDatums,
	formLinkActionsBuildable,
	formLinkProjectionContext,
	matchFrameToSource,
	owningModuleOf,
	targetFrameChildren,
	targetSelectionDatums,
} from "@/lib/commcare/formLinkProjection";
import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	caseSelectionCardinality,
	caseSelectionMaximum,
	type FormLink,
	type FormLinkTarget,
	formLinkAdjacency,
	formLinkPath,
	formLinkSelectionIsCompatible,
	type Uuid,
} from "@/lib/domain";
import { possibleFinalSessionCaseTypes } from "./caseOperationOrder";
import { afterSubmitPlan, formLinkIsConditionalIn } from "./formLinkMutations";

export type FormLinkMoveVerdict =
	| { readonly ok: true }
	/** A conditional link would land after the otherwise link. */
	| {
			readonly ok: false;
			readonly reason: "after-else";
			readonly elseUuid: Uuid;
	  }
	/** The otherwise link would land above links it must follow. */
	| {
			readonly ok: false;
			readonly reason: "else-not-last";
			readonly blockingUuids: readonly Uuid[];
	  };

/**
 * The move verdict for EVERY destination index of one link, so a pointer
 * drag and a keyboard move read one answer and cannot disagree. Index `i`
 * is the position the link would occupy after the move.
 */
export function formLinkMoveVerdicts(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuid: Uuid,
): ReadonlyMap<number, FormLinkMoveVerdict> {
	const verdicts = new Map<number, FormLinkMoveVerdict>();
	const links = doc.forms[formUuid]?.formLinks ?? [];
	const mover = links.find((link) => link.uuid === uuid);
	if (mover === undefined) return verdicts;
	const conditional = (link: FormLink): boolean =>
		formLinkIsConditionalIn(doc, link);
	const others = links.filter((link) => link.uuid !== uuid);
	for (let index = 0; index < links.length; index += 1) {
		const order = [...others.slice(0, index), mover, ...others.slice(index)];
		verdicts.set(index, positionVerdict(order, mover, conditional));
	}
	return verdicts;
}

/**
 * Whether `mover` may sit where it does in `order`: nothing follows an
 * unconditional link, and an unconditional link follows everything.
 */
function positionVerdict(
	order: readonly FormLink[],
	mover: FormLink,
	conditional: (link: FormLink) => boolean,
): FormLinkMoveVerdict {
	const at = order.indexOf(mover);
	if (conditional(mover)) {
		const earlierElse = order.slice(0, at).find((link) => !conditional(link));
		return earlierElse === undefined
			? { ok: true }
			: { ok: false, reason: "after-else", elseUuid: earlierElse.uuid };
	}
	const blocking = order.slice(at + 1).map((link) => link.uuid);
	return blocking.length === 0
		? { ok: true }
		: { ok: false, reason: "else-not-last", blockingUuids: blocking };
}

export type FormLinkTargetVerdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: "target-not-found" }
	| { readonly ok: false; readonly reason: "self-target" }
	| {
			readonly ok: false;
			readonly reason: "selection-cardinality";
			readonly sourceCardinality: "single" | "multiple";
			readonly targetCardinality: "single" | "multiple";
			readonly sourceMaximum: number;
			readonly targetMaximum: number;
	  }
	| {
			readonly ok: false;
			readonly reason: "selection-case-type";
			readonly expectedCaseType: string;
			readonly possibleFinalCaseTypes: readonly string[];
	  }
	/** The chain of form uuids from the target back to this form, inclusive. */
	| {
			readonly ok: false;
			readonly reason: "cycle";
			readonly chain: readonly Uuid[];
	  };

/**
 * Whether a link on `formUuid` may point at `target`. `editingLinkUuid`
 * names the link being retargeted so its current edge is ignored. `datums`
 * is the explicit datum map the proposed link would store. When it is absent,
 * the Builder first tries automatic matching and falls back to the complete
 * manual map its seed would create. A destination is admitted only when that
 * actual seed mode is legal.
 */
export function formLinkTargetVerdict(
	doc: BlueprintDoc,
	formUuid: Uuid,
	editingLinkUuid: Uuid | undefined,
	target: FormLinkTarget,
	datums?: FormLink["datums"],
): FormLinkTargetVerdict {
	const proposed = formLinkTargetVerdictForDatumMode(
		doc,
		formUuid,
		editingLinkUuid,
		target,
		datums !== undefined,
	);
	if (!proposed.ok || datums !== undefined) return proposed;

	return formLinkCarryVerdict(doc, formUuid, target).kind === "manual-required"
		? formLinkTargetVerdictForDatumMode(
				doc,
				formUuid,
				editingLinkUuid,
				target,
				true,
			)
		: proposed;
}

/**
 * Whether the carried values editor may replace automatic matching with an
 * explicit datum map. Collection-shaped selection must travel as one
 * collection, so an otherwise-compatible direct link can still refuse this
 * manual mode. `editingLinkUuid` ignores the link's own current graph edge.
 */
export function formLinkManualCarryVerdict(
	doc: BlueprintDoc,
	formUuid: Uuid,
	editingLinkUuid: Uuid,
	target: FormLinkTarget,
): FormLinkTargetVerdict {
	return formLinkTargetVerdictForDatumMode(
		doc,
		formUuid,
		editingLinkUuid,
		target,
		true,
	);
}

function formLinkTargetVerdictForDatumMode(
	doc: BlueprintDoc,
	formUuid: Uuid,
	editingLinkUuid: Uuid | undefined,
	target: FormLinkTarget,
	hasAuthoredDatums: boolean,
): FormLinkTargetVerdict {
	const mod = doc.modules[target.moduleUuid];
	if (mod === undefined) return { ok: false, reason: "target-not-found" };
	if (target.type === "module") return { ok: true };
	const targetForm = doc.forms[target.formUuid];
	if (
		targetForm === undefined ||
		!(doc.formOrder[target.moduleUuid] ?? []).includes(target.formUuid)
	) {
		return { ok: false, reason: "target-not-found" };
	}
	if (target.formUuid === formUuid) return { ok: false, reason: "self-target" };

	const sourceForm = doc.forms[formUuid];
	const sourceModuleUuid = doc.moduleOrder.find((moduleUuid) =>
		(doc.formOrder[moduleUuid] ?? []).includes(formUuid),
	);
	const sourceModule =
		sourceModuleUuid === undefined ? undefined : doc.modules[sourceModuleUuid];
	if (
		sourceForm !== undefined &&
		sourceModule !== undefined &&
		!formLinkSelectionIsCompatible({
			sourceModule,
			targetModule: mod,
			sourceLoadsCase: CASE_LOADING_FORM_TYPES.has(sourceForm.type),
			targetLoadsCase: CASE_LOADING_FORM_TYPES.has(targetForm.type),
			hasAuthoredDatums,
		})
	) {
		return {
			ok: false,
			reason: "selection-cardinality",
			sourceCardinality: caseSelectionCardinality(sourceModule),
			targetCardinality: caseSelectionCardinality(mod),
			sourceMaximum: caseSelectionMaximum(sourceModule),
			targetMaximum: caseSelectionMaximum(mod),
		};
	}
	if (
		sourceForm !== undefined &&
		sourceModule !== undefined &&
		CASE_LOADING_FORM_TYPES.has(sourceForm.type) &&
		CASE_LOADING_FORM_TYPES.has(targetForm.type) &&
		caseSelectionCardinality(sourceModule) === "multiple" &&
		mod.caseType !== undefined
	) {
		const possibleFinalCaseTypes = [
			...possibleFinalSessionCaseTypes(doc, formUuid),
		];
		if (possibleFinalCaseTypes.some((caseType) => caseType !== mod.caseType)) {
			return {
				ok: false,
				reason: "selection-case-type",
				expectedCaseType: mod.caseType,
				possibleFinalCaseTypes,
			};
		}
	}
	const adjacency = formLinkAdjacency(doc, {
		formUuid,
		...(editingLinkUuid !== undefined && { linkUuid: editingLinkUuid }),
		target,
	});
	const chain = formLinkPath(adjacency, target.formUuid, formUuid);
	return chain === undefined
		? { ok: true }
		: { ok: false, reason: "cycle", chain };
}

export interface FormLinkRequiredDatum {
	readonly id: string;
	readonly caseType?: string;
}

/**
 * The selection datums a destination needs carried — the same derivation
 * the wire and `FORM_LINK_DATUMS_INCOMPLETE` use. Empty for a module target
 * (the person picks a case on arrival) and for a destination whose frame
 * cannot be derived (a form the actions builder would refuse — the commit
 * gate owns that).
 */
export function formLinkRequiredDatums(
	doc: BlueprintDoc,
	formUuid: Uuid,
	target: FormLinkTarget,
): readonly FormLinkRequiredDatum[] {
	/* Read the automatic-mode topology directly. The public target verdict
	 * asks this function which carry mode the Builder will seed, so routing
	 * that question back through it would recurse. */
	if (
		formLinkTargetVerdictForDatumMode(doc, formUuid, undefined, target, false)
			.ok === false
	) {
		return [];
	}
	// The buildable check reads only the target's module; the probe's uuid
	// is never stored.
	const probe: FormLink = { uuid: formUuid, target };
	if (!formLinkActionsBuildable(doc, formUuid, [probe])) return [];
	const ctx = formLinkProjectionContext(doc);
	return targetSelectionDatums(doc, ctx, target).map((datum) => ({
		id: datum.id,
		...(datum.caseType !== undefined && { caseType: datum.caseType }),
	}));
}

export type FormLinkCarryVerdict =
	/** The destination selects nothing: it opens straight away (or the
	 *  person picks a case on a module's list). */
	| { readonly kind: "nothing-needed" }
	/** Every selection datum is satisfied by something this form's entry
	 *  already holds; `carried` names which source datum feeds which. */
	| {
			readonly kind: "automatic";
			readonly carried: readonly {
				readonly datumId: string;
				readonly sourceDatumId: string;
			}[];
	  }
	/** Something the destination selects has no source; the author must
	 *  work those values out by hand, or pick another destination. */
	| { readonly kind: "manual-required"; readonly datumIds: readonly string[] };

/**
 * Whether a link from `formUuid` to `target` can carry the destination's
 * selection datums automatically — HQ's `_get_datums_matched_to_source`
 * asked before the link exists, through the projector the wire uses.
 */
export function formLinkCarryVerdict(
	doc: BlueprintDoc,
	formUuid: Uuid,
	target: FormLinkTarget,
): FormLinkCarryVerdict {
	const required = formLinkRequiredDatums(doc, formUuid, target);
	if (required.length === 0) return { kind: "nothing-needed" };
	const ctx = formLinkProjectionContext(doc);
	const sourceModule = owningModuleOf(ctx, formUuid);
	if (sourceModule === undefined) {
		return { kind: "manual-required", datumIds: required.map((d) => d.id) };
	}
	const match = matchFrameToSource(
		targetFrameChildren(doc, ctx, target),
		entryFrameDatums(doc, ctx, sourceModule, formUuid),
	);
	if (match.unmatched.length > 0) {
		return {
			kind: "manual-required",
			datumIds: match.unmatched.map((datum) => datum.id),
		};
	}
	return {
		kind: "automatic",
		carried: match.matched.map((entry) => ({
			datumId: entry.id,
			sourceDatumId: entry.sourceId,
		})),
	};
}

export interface FormLinkAddChoices {
	readonly conditional: { readonly ok: true };
	readonly otherwise:
		| { readonly ok: true }
		| {
				readonly ok: false;
				readonly reason: "else-exists";
				readonly elseUuid: Uuid;
		  };
}

/** Which kinds of link the add control may offer on this form right now. */
export function formLinkAddChoices(
	doc: BlueprintDoc,
	formUuid: Uuid,
): FormLinkAddChoices {
	const plan = afterSubmitPlan(doc, formUuid);
	return {
		conditional: { ok: true },
		otherwise:
			plan?.elseLink === undefined
				? { ok: true }
				: { ok: false, reason: "else-exists", elseUuid: plan.elseLink.uuid },
	};
}
