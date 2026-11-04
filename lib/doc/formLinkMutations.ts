// lib/doc/formLinkMutations.ts
//
// The batch-building planners for a form's after-submit destinations and
// its otherwise. Every planner returns a batch the gate admits: the first
// destination turns the form's after-submit into its otherwise, removing
// the last destination turns the otherwise back into the form's
// after-submit, and an edit that leaves no destination that may not run
// removes the otherwise. Each says what it did, so a tool's message and the
// builder's toast name it.
//
// Every destination whose condition holds runs, in the author's order; the
// otherwise runs when no destination that may not run
// (`afterSubmit.ts::formLinkMayNotRun`: a condition, or a carried case the
// held-case guard tests) runs. So a destination may sit at any position,
// and a form holds an otherwise only while some destination may not run.
// Conditionality is the presence of an Expression; an empty source never
// persists.

import {
	type BlueprintDoc,
	defaultPostSubmit,
	effectivePostSubmit,
	type Form,
	type FormLink,
	type FormLinkTarget,
	type FormOtherwise,
	type FormOtherwiseLink,
	findAuthoredBlueprintIdentity,
	formLinkMayNotRun,
	moduleUuidOfForm,
	type OtherwiseDestination,
	otherwiseDestinationsOffered,
	type PostSubmitDestination,
	type PostSubmitNotOfferedReason,
	postSubmitNotOfferedReason,
	type Uuid,
} from "@/lib/domain";
import { datumRefKey } from "@/lib/domain/expression/types";
import { deepEqual } from "./deepEqual";
import {
	formLinkRequiredDatums,
	formLinkTargetVerdict,
} from "./formLinkReview";
import type { Mutation } from "./types";

export interface AfterSubmitPlan {
	/** Every destination, in author order. */
	readonly destinations: readonly FormLink[];
	/** The destinations that may not run (`formLinkMayNotRun`). */
	readonly mayNotRun: readonly FormLink[];
	readonly otherwise: FormOtherwise | undefined;
	/** Whether an otherwise may be set now: `mayNotRun.length > 0`. */
	readonly otherwiseOffered: boolean;
	/** A form without destinations: its after-submit, stored or default. */
	readonly postSubmit:
		| {
				readonly destination: PostSubmitDestination;
				readonly explicit: boolean;
		  }
		| undefined;
}

/** What happens after `formUuid` is submitted; `undefined` for a missing form. */
export function afterSubmitPlan(
	doc: BlueprintDoc,
	formUuid: Uuid,
): AfterSubmitPlan | undefined {
	const form = doc.forms[formUuid];
	if (form === undefined) return undefined;
	const destinations = form.formLinks ?? [];
	const mayNotRun = destinations.filter((link) =>
		formLinkMayNotRun(doc, formUuid, link),
	);
	return {
		destinations,
		mayNotRun,
		otherwise: form.otherwise,
		otherwiseOffered: mayNotRun.length > 0,
		postSubmit:
			destinations.length > 0
				? undefined
				: {
						destination:
							effectivePostSubmit(doc, formUuid) ??
							defaultPostSubmit(form.type),
						explicit: form.postSubmit !== undefined,
					},
	};
}

export type FormLinkRefusal =
	| { readonly kind: "form-not-found" }
	| { readonly kind: "link-not-found"; readonly uuid: Uuid }
	| { readonly kind: "duplicate-uuid"; readonly uuid: Uuid }
	| { readonly kind: "target-not-found" }
	/** A `form` target naming the source form. */
	| { readonly kind: "self-target" }
	| {
			readonly kind: "target-not-offered";
			readonly menuUuid: Uuid;
			readonly parentUuid: Uuid | undefined;
	  }
	| { readonly kind: "menu-carries-values" }
	| { readonly kind: "selection-cardinality" }
	| { readonly kind: "otherwise-unreachable" }
	| {
			readonly kind: "otherwise-not-offered";
			readonly destination: OtherwiseDestination;
			readonly reason: PostSubmitNotOfferedReason;
	  }
	| { readonly kind: "otherwise-exists" }
	/** `planMakeDestination` on a form whose otherwise is not a link. */
	| { readonly kind: "no-otherwise-link" }
	| { readonly kind: "stale-base" };

export type FormLinkCommitPlan =
	| {
			readonly ok: true;
			readonly mutations: readonly Mutation[];
			/** The form's after-submit became its otherwise. */
			readonly movedToOtherwise?: OtherwiseDestination;
			/** A stored after-submit that would never run again was removed. */
			readonly droppedPostSubmit?: PostSubmitDestination;
			/** No destination that may not run remained, so the otherwise went. */
			readonly droppedOtherwise?: FormOtherwise;
			/** The last destination left: the otherwise became the form's after-submit. */
			readonly otherwiseToPostSubmit?: OtherwiseDestination;
			/** The last destination left: the otherwise link became the sole destination. */
			readonly otherwiseToDestination?: Uuid;
			/** Carried values a retarget dropped (a menu, or names the new target does not read). */
			readonly droppedDatums?: readonly string[];
	  }
	| { readonly ok: false; readonly reason: FormLinkRefusal };

const refuse = (reason: FormLinkRefusal): FormLinkCommitPlan => ({
	ok: false,
	reason,
});

/* Structural, not textual: the stored document sorts object keys, and a
 * caller re-sending an unchanged value with another key order must read as
 * unchanged. */
const sameJson = (left: unknown, right: unknown): boolean =>
	deepEqual(left ?? null, right ?? null);

/**
 * The document as it reads with `formUuid`'s after-submit slots replaced,
 * for the "may not run" question a planner asks of its own result: a
 * destination's carried case is guarded by what its target selects, which
 * reads the whole document. A shallow candidate; it is never stored.
 */
function withAfterSubmit(
	doc: BlueprintDoc,
	formUuid: Uuid,
	slots: {
		readonly formLinks: readonly FormLink[];
		readonly otherwise: FormOtherwise | undefined;
	},
): BlueprintDoc {
	const form = doc.forms[formUuid];
	if (form === undefined) return doc;
	const {
		formLinks: _links,
		otherwise: _otherwise,
		postSubmit: _postSubmit,
		...rest
	} = form;
	const next: Form = {
		...rest,
		...(slots.formLinks.length > 0 && { formLinks: [...slots.formLinks] }),
		...(slots.otherwise !== undefined && { otherwise: slots.otherwise }),
	};
	return { ...doc, forms: { ...doc.forms, [formUuid]: next } };
}

/** Whether some destination of `links` may not run in `candidate`. */
function someMayNotRun(
	candidate: BlueprintDoc,
	formUuid: Uuid,
	links: readonly FormLink[],
): boolean {
	return links.some((link) => formLinkMayNotRun(candidate, formUuid, link));
}

/** Whether `uuid` already names something in the document, other than the
 *  one identity the caller is allowed to keep. */
function uuidInUse(doc: BlueprintDoc, uuid: Uuid, keeping?: Uuid): boolean {
	if (keeping !== undefined && uuid === keeping) return false;
	return findAuthoredBlueprintIdentity(doc, uuid) !== undefined;
}

/** The refusal for a link of `formUuid` pointing at `target` with `datums`. */
function targetRefusal(
	doc: BlueprintDoc,
	formUuid: Uuid,
	target: FormLinkTarget,
	datums: FormLink["datums"],
): FormLinkRefusal | undefined {
	const verdict = formLinkTargetVerdict(doc, formUuid, target, datums);
	if (!verdict.ok) {
		switch (verdict.reason) {
			case "target-not-found":
				return { kind: "target-not-found" };
			case "self-target":
				return { kind: "self-target" };
			case "not-offered":
				return {
					kind: "target-not-offered",
					menuUuid: verdict.menuUuid,
					parentUuid: verdict.parentUuid,
				};
			case "selection-cardinality":
			case "selection-case-type":
				return { kind: "selection-cardinality" };
		}
	}
	if (target.type === "module" && datums !== undefined) {
		return { kind: "menu-carries-values" };
	}
	return undefined;
}

/** The `setFormOtherwise null` an edit needs when it leaves no destination
 *  that may not run beside a stored otherwise. */
function strandedOtherwise(
	doc: BlueprintDoc,
	formUuid: Uuid,
	resulting: readonly FormLink[],
	otherwise: FormOtherwise | undefined,
): Mutation | undefined {
	if (otherwise === undefined || resulting.length === 0) return undefined;
	const candidate = withAfterSubmit(doc, formUuid, {
		formLinks: resulting,
		otherwise,
	});
	return someMayNotRun(candidate, formUuid, resulting)
		? undefined
		: { kind: "setFormOtherwise", formUuid, otherwise: null };
}

/** A link as its destination form: uuid, target and datums, no condition. */
function asDestination(link: {
	readonly uuid: Uuid;
	readonly target: FormLinkTarget;
	readonly datums?: FormLink["datums"];
}): FormLink {
	return {
		uuid: link.uuid,
		target: link.target,
		...(link.datums !== undefined && { datums: link.datums }),
	};
}

/**
 * Add one complete destination. `after` is the destination it follows
 * (`null` first; absent, last). On a form without destinations the form's
 * after-submit is settled in the same batch: when the new destination may
 * not run and the form's effective after-submit is an offered otherwise, it
 * becomes the otherwise (`movedToOtherwise`), so where the worker goes when
 * the destination does not run is unchanged; a stored `postSubmit` is
 * cleared, and reported (`droppedPostSubmit`) when it did not move and a
 * worker no longer reaches it. On a form with destinations nothing else
 * changes: adding a destination never strands an otherwise.
 */
export function planFormLinkAdd(
	doc: BlueprintDoc,
	formUuid: Uuid,
	link: FormLink,
	after?: Uuid | null,
): FormLinkCommitPlan {
	const plan = afterSubmitPlan(doc, formUuid);
	if (plan === undefined) return refuse({ kind: "form-not-found" });
	if (uuidInUse(doc, link.uuid)) {
		return refuse({ kind: "duplicate-uuid", uuid: link.uuid });
	}
	const badTarget = targetRefusal(doc, formUuid, link.target, link.datums);
	if (badTarget !== undefined) return refuse(badTarget);
	if (
		after !== undefined &&
		after !== null &&
		!plan.destinations.some((candidate) => candidate.uuid === after)
	) {
		return refuse({ kind: "link-not-found", uuid: after });
	}

	const mutations: Mutation[] = [
		{
			kind: "addFormLink",
			formUuid,
			link,
			...(after !== undefined && { after }),
		},
	];
	if (plan.postSubmit === undefined) return { ok: true, mutations };

	/* The form's first destination: its after-submit leaves `postSubmit`. */
	const stored = doc.forms[formUuid]?.postSubmit;
	if (stored !== undefined) {
		mutations.push({
			kind: "updateForm",
			uuid: formUuid,
			patch: { postSubmit: null },
		});
	}
	const candidate = withAfterSubmit(doc, formUuid, {
		formLinks: [link],
		otherwise: undefined,
	});
	const mayNotRun = formLinkMayNotRun(candidate, formUuid, link);
	const destination = plan.postSubmit.destination;
	const offered: readonly PostSubmitDestination[] =
		otherwiseDestinationsOffered(doc, formUuid);
	const moves = mayNotRun && offered.includes(destination);
	if (moves) {
		const moved = destination as OtherwiseDestination;
		mutations.push({
			kind: "setFormOtherwise",
			formUuid,
			otherwise: { kind: "destination", destination: moved },
		});
		return { ok: true, mutations, movedToOtherwise: moved };
	}
	/* `app_home` beside a destination that may not run is still where the
	 * worker goes when it does not: an absent otherwise means the app home. */
	const stillReached = mayNotRun && stored === "app_home";
	return {
		ok: true,
		mutations,
		...(stored !== undefined && !stillReached && { droppedPostSubmit: stored }),
	};
}

/**
 * Rebase an edited destination onto the invocation-time document: only the
 * slots that changed between `base` (what the editor opened) and `next` are
 * written, and a slot someone else changed in between refuses rather than
 * clobbering their edit. A retarget that leaves the carried values alone
 * drops the ones the new target does not read, every one for a menu
 * (`droppedDatums`). When the result leaves no destination that may not
 * run, the otherwise goes in the same batch (`droppedOtherwise`).
 */
export function planFormLinkUpdate(
	doc: BlueprintDoc,
	formUuid: Uuid,
	next: FormLink,
	base: FormLink,
): FormLinkCommitPlan {
	const plan = afterSubmitPlan(doc, formUuid);
	if (plan === undefined) return refuse({ kind: "form-not-found" });
	const existing = plan.destinations.find((link) => link.uuid === next.uuid);
	if (existing === undefined || next.uuid !== base.uuid) {
		return refuse({ kind: "link-not-found", uuid: next.uuid });
	}
	const slots = ["condition", "target", "datums"] as const;
	const changed = slots.filter((slot) => !sameJson(base[slot], next[slot]));
	if (changed.some((slot) => !sameJson(base[slot], existing[slot]))) {
		return refuse({ kind: "stale-base" });
	}
	if (changed.length === 0) return { ok: true, mutations: [] };

	/* HQ's manual path iterates the TARGET's datums and the gate refuses the
	 * leftovers (`FORM_LINK_DATUM_UNUSED`; on a menu, which reads none,
	 * `FORM_LINK_MENU_DATUMS`), so a caller that names only the target has
	 * the names its new target does not read dropped, as the builder's
	 * inspector reseeds them. A name the target still reads is kept; an empty
	 * remainder clears the slot; the plan says what went. Values the caller
	 * sets in the same edit are its own. */
	const target = changed.includes("target") ? next.target : existing.target;
	const condition = changed.includes("condition")
		? next.condition
		: existing.condition;
	let datums = changed.includes("datums") ? next.datums : existing.datums;
	let droppedDatums: readonly string[] = [];
	if (
		changed.includes("target") &&
		!changed.includes("datums") &&
		datums !== undefined
	) {
		const needed = new Set(
			formLinkRequiredDatums(doc, formUuid, target).map((datum) =>
				datumRefKey(datum.name),
			),
		);
		const previousNames = new Map(
			formLinkRequiredDatums(doc, formUuid, existing.target).map((datum) => [
				datumRefKey(datum.name),
				datum.id,
			]),
		);
		const keep = (datum: NonNullable<FormLink["datums"]>[number]) =>
			target.type !== "module" && needed.has(datumRefKey(datum.name));
		droppedDatums = datums
			.filter((datum) => !keep(datum))
			.map(
				(datum) =>
					previousNames.get(datumRefKey(datum.name)) ?? "selected record",
			);
		const kept = datums.filter(keep);
		datums = kept.length > 0 ? (kept as FormLink["datums"]) : undefined;
	}
	/* Selection compatibility depends on the FINAL link, not only its target:
	 * explicit datums switch CommCare from collection matching to scalar
	 * manual values. Check both retargets and datum-only edits with the
	 * values this plan will actually store. */
	if (changed.includes("target") || changed.includes("datums")) {
		const badTarget = targetRefusal(doc, formUuid, target, datums);
		if (badTarget !== undefined) return refuse(badTarget);
	}
	const settled: FormLink = {
		uuid: next.uuid,
		...(condition !== undefined && { condition }),
		target,
		...(datums !== undefined && { datums }),
	};
	const resulting = plan.destinations.map((link) =>
		link.uuid === next.uuid ? settled : link,
	);

	const patch: Record<string, unknown> = {};
	if (changed.includes("condition")) patch.condition = next.condition ?? null;
	if (changed.includes("target")) patch.target = next.target;
	if (changed.includes("datums") || droppedDatums.length > 0) {
		patch.datums = datums ?? null;
	}
	const mutations: Mutation[] = [
		{
			kind: "updateFormLink",
			formUuid,
			uuid: next.uuid,
			patch: patch as Extract<Mutation, { kind: "updateFormLink" }>["patch"],
		},
	];
	const clear = strandedOtherwise(doc, formUuid, resulting, plan.otherwise);
	if (clear !== undefined) mutations.push(clear);
	return {
		ok: true,
		mutations,
		...(clear !== undefined &&
			plan.otherwise !== undefined && { droppedOtherwise: plan.otherwise }),
		...(droppedDatums.length > 0 && { droppedDatums }),
	};
}

/**
 * Remove one destination. Removing the last one gives the form its
 * after-submit back: a built-in otherwise becomes its `postSubmit`
 * (`otherwiseToPostSubmit`), an otherwise link becomes its sole destination
 * with the same uuid, target and carried values and no condition
 * (`otherwiseToDestination`), and with no otherwise the form takes its
 * type's default. Removing the last destination that may not run while
 * others remain removes the otherwise (`droppedOtherwise`).
 */
export function planFormLinkRemove(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuid: Uuid,
): FormLinkCommitPlan {
	const plan = afterSubmitPlan(doc, formUuid);
	if (plan === undefined) return refuse({ kind: "form-not-found" });
	if (!plan.destinations.some((link) => link.uuid === uuid)) {
		return refuse({ kind: "link-not-found", uuid });
	}
	const mutations: Mutation[] = [{ kind: "removeFormLink", formUuid, uuid }];
	const resulting = plan.destinations.filter((link) => link.uuid !== uuid);
	const otherwise = plan.otherwise;

	if (resulting.length === 0) {
		if (otherwise === undefined) return { ok: true, mutations };
		mutations.push({ kind: "setFormOtherwise", formUuid, otherwise: null });
		if (otherwise.kind === "destination") {
			mutations.push({
				kind: "updateForm",
				uuid: formUuid,
				patch: { postSubmit: otherwise.destination },
			});
			return {
				ok: true,
				mutations,
				otherwiseToPostSubmit: otherwise.destination,
			};
		}
		mutations.push({
			kind: "addFormLink",
			formUuid,
			link: asDestination(otherwise),
		});
		return { ok: true, mutations, otherwiseToDestination: otherwise.uuid };
	}

	const clear = strandedOtherwise(doc, formUuid, resulting, otherwise);
	if (clear !== undefined) mutations.push(clear);
	return {
		ok: true,
		mutations,
		...(clear !== undefined &&
			otherwise !== undefined && { droppedOtherwise: otherwise }),
	};
}

/**
 * Move one destination to `toIndex` (its position after the move). Every
 * position is admitted. The anchor is the destination it then follows, so a
 * peer's insert elsewhere cannot shift where it lands; a same-position move
 * is a no-op plan.
 */
export function planFormLinkMove(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuid: Uuid,
	toIndex: number,
): FormLinkCommitPlan {
	const plan = afterSubmitPlan(doc, formUuid);
	if (plan === undefined) return refuse({ kind: "form-not-found" });
	const from = plan.destinations.findIndex((link) => link.uuid === uuid);
	if (from < 0) return refuse({ kind: "link-not-found", uuid });
	const index = Math.max(0, Math.min(toIndex, plan.destinations.length - 1));
	if (index === from) return { ok: true, mutations: [] };
	const others = plan.destinations.filter((link) => link.uuid !== uuid);
	const after = index === 0 ? null : (others[index - 1]?.uuid ?? null);
	return {
		ok: true,
		mutations: [{ kind: "moveFormLink", formUuid, uuid, after }],
	};
}

/**
 * Set where the form goes when no destination that may not run runs, or
 * clear it with `null` (the app home then follows). A built-in destination
 * must be one the form's menu offers (`otherwiseDestinationsOffered`); a link
 * takes the target rules a destination does, and its uuid is minted by the
 * caller: a fresh one, or the uuid of the otherwise link being changed.
 */
export function planSetOtherwise(
	doc: BlueprintDoc,
	formUuid: Uuid,
	next: FormOtherwise | null,
): FormLinkCommitPlan {
	const plan = afterSubmitPlan(doc, formUuid);
	if (plan === undefined || moduleUuidOfForm(doc, formUuid) === undefined) {
		return refuse({ kind: "form-not-found" });
	}
	if (next === null) {
		return {
			ok: true,
			mutations:
				plan.otherwise === undefined
					? []
					: [{ kind: "setFormOtherwise", formUuid, otherwise: null }],
		};
	}
	if (sameJson(plan.otherwise, next)) return { ok: true, mutations: [] };
	if (!plan.otherwiseOffered) return refuse({ kind: "otherwise-unreachable" });
	if (next.kind === "destination") {
		const offered = otherwiseDestinationsOffered(doc, formUuid);
		if (!offered.includes(next.destination)) {
			const reason = postSubmitNotOfferedReason(
				doc,
				formUuid,
				next.destination,
			);
			if (reason !== undefined) {
				return refuse({
					kind: "otherwise-not-offered",
					destination: next.destination,
					reason,
				});
			}
		}
	} else {
		const keeping =
			plan.otherwise?.kind === "link" ? plan.otherwise.uuid : undefined;
		if (uuidInUse(doc, next.uuid, keeping)) {
			return refuse({ kind: "duplicate-uuid", uuid: next.uuid });
		}
		const badTarget = targetRefusal(doc, formUuid, next.target, next.datums);
		if (badTarget !== undefined) return refuse(badTarget);
	}
	return {
		ok: true,
		mutations: [{ kind: "setFormOtherwise", formUuid, otherwise: next }],
	};
}

/**
 * Turn a destination into the otherwise link, with the same uuid, target and
 * carried values; its condition goes. Refused while an otherwise is stored,
 * and when no OTHER destination may not run, since the otherwise would then
 * never run.
 */
export function planMakeOtherwise(
	doc: BlueprintDoc,
	formUuid: Uuid,
	linkUuid: Uuid,
): FormLinkCommitPlan {
	const plan = afterSubmitPlan(doc, formUuid);
	if (plan === undefined) return refuse({ kind: "form-not-found" });
	const link = plan.destinations.find(
		(candidate) => candidate.uuid === linkUuid,
	);
	if (link === undefined)
		return refuse({ kind: "link-not-found", uuid: linkUuid });
	if (plan.otherwise !== undefined) return refuse({ kind: "otherwise-exists" });
	const remaining = plan.destinations.filter(
		(candidate) => candidate.uuid !== linkUuid,
	);
	const otherwise: FormOtherwiseLink = {
		kind: "link",
		uuid: link.uuid,
		target: link.target,
		...(link.datums !== undefined && { datums: link.datums }),
	};
	const candidate = withAfterSubmit(doc, formUuid, {
		formLinks: remaining,
		otherwise,
	});
	if (!someMayNotRun(candidate, formUuid, remaining)) {
		return refuse({ kind: "otherwise-unreachable" });
	}
	return {
		ok: true,
		mutations: [
			{ kind: "removeFormLink", formUuid, uuid: linkUuid },
			{ kind: "setFormOtherwise", formUuid, otherwise },
		],
	};
}

/**
 * Turn the otherwise link into the last destination, with its uuid, target
 * and carried values and no condition; the otherwise slot clears. Refused
 * when the otherwise is built-in or absent.
 */
export function planMakeDestination(
	doc: BlueprintDoc,
	formUuid: Uuid,
): FormLinkCommitPlan {
	const plan = afterSubmitPlan(doc, formUuid);
	if (plan === undefined) return refuse({ kind: "form-not-found" });
	const otherwise = plan.otherwise;
	if (otherwise?.kind !== "link") return refuse({ kind: "no-otherwise-link" });
	return {
		ok: true,
		mutations: [
			{ kind: "setFormOtherwise", formUuid, otherwise: null },
			{ kind: "addFormLink", formUuid, link: asDestination(otherwise) },
		],
	};
}
