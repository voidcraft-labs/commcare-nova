// lib/doc/formLinkReview.ts
//
// What an author must be told BEFORE a link is added, moved, retargeted,
// or asked to carry values — pure verdicts over the document, derived from
// the same facts the validator and the wire read. Nothing here decides
// legality on its own: `formLinkMoveVerdicts` and `formLinkTargetVerdict`
// restate the three positional rules (`FORM_LINK_UNREACHABLE`,
// `FORM_LINK_SELF_REFERENCE`, `FORM_LINK_CIRCULAR`) so a surface can refuse
// before it offers, and `formLinkCarryVerdict` asks the ONE projector the
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
	type FormLink,
	type FormLinkTarget,
	formLinkAdjacency,
	formLinkPath,
	type Uuid,
} from "@/lib/domain";
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
	/** The chain of form uuids from the target back to this form, inclusive. */
	| {
			readonly ok: false;
			readonly reason: "cycle";
			readonly chain: readonly Uuid[];
	  };

/**
 * Whether a link on `formUuid` may point at `target`. `editingLinkUuid`
 * names the link being retargeted so its current edge is ignored.
 */
export function formLinkTargetVerdict(
	doc: BlueprintDoc,
	formUuid: Uuid,
	editingLinkUuid: Uuid | undefined,
	target: FormLinkTarget,
): FormLinkTargetVerdict {
	const mod = doc.modules[target.moduleUuid];
	if (mod === undefined) return { ok: false, reason: "target-not-found" };
	if (target.type === "module") return { ok: true };
	if (
		doc.forms[target.formUuid] === undefined ||
		!(doc.formOrder[target.moduleUuid] ?? []).includes(target.formUuid)
	) {
		return { ok: false, reason: "target-not-found" };
	}
	if (target.formUuid === formUuid) return { ok: false, reason: "self-target" };
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
	if (formLinkTargetVerdict(doc, formUuid, undefined, target).ok === false) {
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
