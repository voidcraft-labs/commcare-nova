// lib/doc/formLinkMutations.ts
//
// The batch-building planners for a form's after-submit links: what runs
// when the form is submitted, and how one add / update / remove / move /
// "otherwise" change becomes a gated batch that the builder, the SA, and
// the MCP surface all dispatch identically.
//
// Two rules every planner keeps, so the document a person sees is always
// one the validator admits:
//
//   - **Valid by construction pins the fallback.** `FORM_LINK_NO_FALLBACK`
//     refuses a form whose links are all conditional while `postSubmit` is
//     unset. A planner that produces that shape (the first conditional
//     link with no otherwise; removing the otherwise while conditional
//     links remain; turning the otherwise into a conditional link) writes
//     the form's CURRENT effective destination explicitly in the same
//     batch, and says so (`pinsFallback`). A person never meets the gate's
//     refusal; a tool's message names the pin.
//
//   - **One "otherwise" model.** `afterSubmitPlan` is the single reader of
//     what runs when nothing matched: the terminal unconditional link when
//     one exists, else `postSubmit` (explicit or the form-type default).
//     The settings row and the workspace's terminal row both consume it;
//     `planSetFallback` is the single writer for both choosers.
//
// Conditionality is what the validator calls it: a condition that prints to
// non-empty XPath. The planners read the same projection.

import {
	asUuid,
	type BlueprintDoc,
	defaultPostSubmit,
	type FormLink,
	type FormLinkTarget,
	type PostSubmitDestination,
	projectXPath,
	type Uuid,
	xpathPrintContext,
} from "@/lib/domain";
import { deepEqual } from "./deepEqual";
import { formLinkMoveVerdicts, formLinkTargetVerdict } from "./formLinkReview";
import type { Mutation } from "./types";

/** Conditional = prints to non-empty XPath, exactly as the validator reads it. */
export function formLinkIsConditionalIn(
	doc: BlueprintDoc,
	link: Pick<FormLink, "condition">,
): boolean {
	if (link.condition === undefined) return false;
	return (
		projectXPath(link.condition, xpathPrintContext(doc)).text.trim().length > 0
	);
}

export type AfterSubmitFallback =
	| {
			readonly kind: "post-submit";
			readonly destination: PostSubmitDestination;
			/** Whether the form stores it, or the form-type default supplies it. */
			readonly explicit: boolean;
	  }
	| { readonly kind: "else-link"; readonly link: FormLink };

export interface AfterSubmitPlan {
	/** Every link, in the order they are checked. */
	readonly links: readonly FormLink[];
	/** The links that carry a condition. */
	readonly conditional: readonly FormLink[];
	/** The terminal unconditional link, when one exists. */
	readonly elseLink: FormLink | undefined;
	/** What runs when nothing matched. */
	readonly fallback: AfterSubmitFallback;
	/** Conditional links exist and no otherwise link does, so the gate
	 *  requires `postSubmit` to be stored explicitly. */
	readonly fallbackMustBeExplicit: boolean;
}

/** What happens after `formUuid` is submitted; `undefined` for a missing form. */
export function afterSubmitPlan(
	doc: BlueprintDoc,
	formUuid: Uuid,
): AfterSubmitPlan | undefined {
	const form = doc.forms[formUuid];
	if (form === undefined) return undefined;
	const links = form.formLinks ?? [];
	const conditional = links.filter((link) =>
		formLinkIsConditionalIn(doc, link),
	);
	const last = links.at(-1);
	const elseLink =
		last !== undefined && !formLinkIsConditionalIn(doc, last)
			? last
			: undefined;
	const fallback: AfterSubmitFallback =
		elseLink !== undefined
			? { kind: "else-link", link: elseLink }
			: {
					kind: "post-submit",
					destination: form.postSubmit ?? defaultPostSubmit(form.type),
					explicit: form.postSubmit !== undefined,
				};
	return {
		links,
		conditional,
		elseLink,
		fallback,
		fallbackMustBeExplicit: conditional.length > 0 && elseLink === undefined,
	};
}

export type FormLinkRefusal =
	| { readonly kind: "form-not-found" }
	| { readonly kind: "link-not-found"; readonly uuid: Uuid }
	/** The uuid is already a link on this form. */
	| { readonly kind: "duplicate-uuid"; readonly uuid: Uuid }
	| { readonly kind: "target-not-found" }
	| { readonly kind: "self-target" }
	| { readonly kind: "cycle"; readonly chain: readonly Uuid[] }
	/** An otherwise link already exists; change it instead of adding one. */
	| { readonly kind: "else-exists"; readonly elseUuid: Uuid }
	/** A conditional link would land after the otherwise link. */
	| { readonly kind: "after-else"; readonly elseUuid: Uuid }
	/** An unconditional link would sit above links it must follow. */
	| { readonly kind: "else-not-last"; readonly blockingUuids: readonly Uuid[] }
	/** The slot being changed was changed by someone else first. */
	| { readonly kind: "stale-base" };

export type FormLinkCommitPlan =
	| {
			readonly ok: true;
			readonly mutations: readonly Mutation[];
			/** Set when the batch also stores `postSubmit` explicitly so the
			 *  result passes `FORM_LINK_NO_FALLBACK`; names what it stored. */
			readonly pinsFallback?: PostSubmitDestination;
	  }
	| { readonly ok: false; readonly reason: FormLinkRefusal };

const refuse = (reason: FormLinkRefusal): FormLinkCommitPlan => ({
	ok: false,
	reason,
});

/**
 * The `updateForm` that stores the form's current effective destination,
 * when the resulting link list would otherwise trip `FORM_LINK_NO_FALLBACK`:
 * every resulting link conditional, and nothing stored.
 */
function fallbackPin(
	doc: BlueprintDoc,
	formUuid: Uuid,
	resultingLinks: readonly FormLink[],
): { mutation: Mutation; destination: PostSubmitDestination } | undefined {
	const form = doc.forms[formUuid];
	if (form === undefined || form.postSubmit !== undefined) return undefined;
	if (resultingLinks.length === 0) return undefined;
	if (!resultingLinks.every((link) => formLinkIsConditionalIn(doc, link))) {
		return undefined;
	}
	const destination = defaultPostSubmit(form.type);
	return {
		mutation: {
			kind: "updateForm",
			uuid: formUuid,
			patch: { postSubmit: destination },
		},
		destination,
	};
}

function targetRefusal(
	doc: BlueprintDoc,
	formUuid: Uuid,
	editing: Uuid | undefined,
	target: FormLinkTarget,
): FormLinkRefusal | undefined {
	const verdict = formLinkTargetVerdict(doc, formUuid, editing, target);
	if (verdict.ok) return undefined;
	return verdict.reason === "cycle"
		? { kind: "cycle", chain: verdict.chain }
		: { kind: verdict.reason };
}

/**
 * Add one complete link. `after` is the link it follows (`null` first;
 * absent = the natural place: a conditional link lands just above the
 * otherwise link when one exists, else last; an unconditional link lands
 * last). Pins the fallback when the add introduces the first conditional
 * link with no otherwise.
 */
export function planFormLinkAdd(
	doc: BlueprintDoc,
	formUuid: Uuid,
	link: FormLink,
	after?: Uuid | null,
): FormLinkCommitPlan {
	const plan = afterSubmitPlan(doc, formUuid);
	if (plan === undefined) return refuse({ kind: "form-not-found" });
	if (plan.links.some((candidate) => candidate.uuid === link.uuid)) {
		return refuse({ kind: "duplicate-uuid", uuid: link.uuid });
	}
	const badTarget = targetRefusal(doc, formUuid, undefined, link.target);
	if (badTarget !== undefined) return refuse(badTarget);
	if (
		after !== undefined &&
		after !== null &&
		!plan.links.some((candidate) => candidate.uuid === after)
	) {
		return refuse({ kind: "link-not-found", uuid: after });
	}

	const conditional = formLinkIsConditionalIn(doc, link);
	let anchor: Uuid | null | undefined = after;
	if (conditional) {
		if (anchor === undefined && plan.elseLink !== undefined) {
			// Just above the otherwise link.
			const elseIndex = plan.links.indexOf(plan.elseLink);
			anchor =
				elseIndex === 0 ? null : (plan.links[elseIndex - 1]?.uuid ?? null);
		}
		if (anchor !== undefined && anchor !== null) {
			const anchorIndex = plan.links.findIndex((l) => l.uuid === anchor);
			const earlierElse = plan.links
				.slice(0, anchorIndex + 1)
				.find((l) => !formLinkIsConditionalIn(doc, l));
			if (earlierElse !== undefined) {
				return refuse({ kind: "after-else", elseUuid: earlierElse.uuid });
			}
		}
	} else {
		if (plan.elseLink !== undefined) {
			return refuse({ kind: "else-exists", elseUuid: plan.elseLink.uuid });
		}
		const last = plan.links.at(-1);
		const landsLast =
			anchor === undefined ||
			(anchor === null && plan.links.length === 0) ||
			(anchor !== null && anchor === last?.uuid);
		if (!landsLast) {
			const anchorIndex =
				anchor === null ? -1 : plan.links.findIndex((l) => l.uuid === anchor);
			return refuse({
				kind: "else-not-last",
				blockingUuids: plan.links.slice(anchorIndex + 1).map((l) => l.uuid),
			});
		}
		anchor = undefined;
	}

	const mutations: Mutation[] = [
		{
			kind: "addFormLink",
			formUuid,
			link,
			...(anchor !== undefined && { after: anchor }),
		},
	];
	const resulting = [...plan.links, link];
	const pin = fallbackPin(doc, formUuid, resulting);
	if (pin !== undefined) mutations.push(pin.mutation);
	return {
		ok: true,
		mutations,
		...(pin !== undefined && { pinsFallback: pin.destination }),
	};
}

/* Structural, not textual: the stored document sorts object keys, and a
 * caller re-sending an unchanged target with another key order must read
 * as unchanged. */
const sameJson = (left: unknown, right: unknown): boolean =>
	deepEqual(left ?? null, right ?? null);

/**
 * Rebase an edited link onto the invocation-time document: only the slots
 * that changed between `base` (what the editor opened) and `next` are
 * written, and a slot someone else changed in between refuses rather than
 * clobbering their edit. A link made unconditional must already be last.
 */
export function planFormLinkUpdate(
	doc: BlueprintDoc,
	formUuid: Uuid,
	next: FormLink,
	base: FormLink,
): FormLinkCommitPlan {
	const plan = afterSubmitPlan(doc, formUuid);
	if (plan === undefined) return refuse({ kind: "form-not-found" });
	const index = plan.links.findIndex((link) => link.uuid === next.uuid);
	const existing = plan.links[index];
	if (existing === undefined || next.uuid !== base.uuid) {
		return refuse({ kind: "link-not-found", uuid: next.uuid });
	}
	const slots = ["condition", "target", "datums"] as const;
	const changed = slots.filter((slot) => !sameJson(base[slot], next[slot]));
	if (changed.some((slot) => !sameJson(base[slot], existing[slot]))) {
		return refuse({ kind: "stale-base" });
	}
	if (changed.length === 0) return { ok: true, mutations: [] };

	if (changed.includes("target")) {
		const badTarget = targetRefusal(doc, formUuid, next.uuid, next.target);
		if (badTarget !== undefined) return refuse(badTarget);
	}
	const resulting = plan.links.map((link) =>
		link.uuid === next.uuid ? next : link,
	);
	const nextConditional = formLinkIsConditionalIn(doc, next);
	if (!nextConditional) {
		const blocking = resulting.slice(index + 1).map((link) => link.uuid);
		if (blocking.length > 0) {
			return refuse({ kind: "else-not-last", blockingUuids: blocking });
		}
	} else {
		const earlierElse = resulting
			.slice(0, index)
			.find((link) => !formLinkIsConditionalIn(doc, link));
		if (earlierElse !== undefined) {
			return refuse({ kind: "after-else", elseUuid: earlierElse.uuid });
		}
	}

	const patch: Record<string, unknown> = {};
	if (changed.includes("condition")) patch.condition = next.condition ?? null;
	if (changed.includes("target")) patch.target = next.target;
	if (changed.includes("datums")) patch.datums = next.datums ?? null;
	const mutations: Mutation[] = [
		{
			kind: "updateFormLink",
			formUuid,
			uuid: next.uuid,
			patch: patch as Extract<Mutation, { kind: "updateFormLink" }>["patch"],
		},
	];
	const pin = fallbackPin(doc, formUuid, resulting);
	if (pin !== undefined) mutations.push(pin.mutation);
	return {
		ok: true,
		mutations,
		...(pin !== undefined && { pinsFallback: pin.destination }),
	};
}

/** Remove one link; pins the fallback when the otherwise goes and conditional links remain. */
export function planFormLinkRemove(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuid: Uuid,
): FormLinkCommitPlan {
	const plan = afterSubmitPlan(doc, formUuid);
	if (plan === undefined) return refuse({ kind: "form-not-found" });
	if (!plan.links.some((link) => link.uuid === uuid)) {
		return refuse({ kind: "link-not-found", uuid });
	}
	const mutations: Mutation[] = [{ kind: "removeFormLink", formUuid, uuid }];
	const resulting = plan.links.filter((link) => link.uuid !== uuid);
	const pin = fallbackPin(doc, formUuid, resulting);
	if (pin !== undefined) mutations.push(pin.mutation);
	return {
		ok: true,
		mutations,
		...(pin !== undefined && { pinsFallback: pin.destination }),
	};
}

/**
 * Move one link to `toIndex` (its position after the move). The anchor is
 * the link it then follows, so a peer's insert elsewhere cannot shift
 * where it lands; a same-position move is a no-op plan.
 */
export function planFormLinkMove(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuid: Uuid,
	toIndex: number,
): FormLinkCommitPlan {
	const plan = afterSubmitPlan(doc, formUuid);
	if (plan === undefined) return refuse({ kind: "form-not-found" });
	const from = plan.links.findIndex((link) => link.uuid === uuid);
	if (from < 0) return refuse({ kind: "link-not-found", uuid });
	const index = Math.max(0, Math.min(toIndex, plan.links.length - 1));
	const verdict = formLinkMoveVerdicts(doc, formUuid, uuid).get(index);
	if (verdict !== undefined && !verdict.ok) {
		return refuse(
			verdict.reason === "after-else"
				? { kind: "after-else", elseUuid: verdict.elseUuid }
				: { kind: "else-not-last", blockingUuids: verdict.blockingUuids },
		);
	}
	if (index === from) return { ok: true, mutations: [] };
	const others = plan.links.filter((link) => link.uuid !== uuid);
	const after = index === 0 ? null : (others[index - 1]?.uuid ?? null);
	return {
		ok: true,
		mutations: [{ kind: "moveFormLink", formUuid, uuid, after }],
	};
}

export type FallbackChoice =
	| PostSubmitDestination
	| {
			readonly kind: "else-link";
			readonly target: FormLinkTarget;
			/** The uuid the new link takes; minted when absent. */
			readonly uuid?: Uuid;
	  };

/**
 * Set what runs when nothing matched. A built-in destination is stored
 * EXPLICITLY whenever the form has links (the null-when-default shorthand
 * is refused under conditional links, and an explicit value is what the
 * person chose); with no links at all the shorthand applies. Choosing a
 * built-in destination while an otherwise link exists removes that link in
 * the same batch. The `else-link` arm appends an unconditional link and
 * refuses when one exists.
 */
export function planSetFallback(
	doc: BlueprintDoc,
	formUuid: Uuid,
	next: FallbackChoice,
): FormLinkCommitPlan {
	const plan = afterSubmitPlan(doc, formUuid);
	const form = doc.forms[formUuid];
	if (plan === undefined || form === undefined) {
		return refuse({ kind: "form-not-found" });
	}
	if (typeof next === "string") {
		const mutations: Mutation[] = [];
		const remaining =
			plan.elseLink === undefined
				? plan.links
				: plan.links.filter((link) => link.uuid !== plan.elseLink?.uuid);
		if (plan.elseLink !== undefined) {
			mutations.push({
				kind: "removeFormLink",
				formUuid,
				uuid: plan.elseLink.uuid,
			});
		}
		const stored =
			remaining.length > 0 || next !== defaultPostSubmit(form.type)
				? next
				: null;
		if ((form.postSubmit ?? null) !== stored) {
			mutations.push({
				kind: "updateForm",
				uuid: formUuid,
				patch: { postSubmit: stored },
			});
		}
		return { ok: true, mutations };
	}
	if (plan.elseLink !== undefined) {
		return refuse({ kind: "else-exists", elseUuid: plan.elseLink.uuid });
	}
	const badTarget = targetRefusal(doc, formUuid, undefined, next.target);
	if (badTarget !== undefined) return refuse(badTarget);
	const link: FormLink = {
		uuid: next.uuid ?? asUuid(crypto.randomUUID()),
		target: next.target,
	};
	return {
		ok: true,
		mutations: [{ kind: "addFormLink", formUuid, link }],
	};
}
