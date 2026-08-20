// lib/doc/hooks/useFormLinks.ts
//
// One read/write surface over a form's after-submit links, shared by the
// centre-canvas list, the link detail, the rail's per-link body, and the
// form-settings "After submit" row.
//
// It lives with the doc hooks rather than beside its screens because it
// reads the WHOLE document: every planner takes it (a target's legality
// depends on every other form's links, and what a link can carry depends
// on the destination module's forms). Selector-accepting store hooks are
// lib-private, so a surface that needs the whole doc gets a named hook
// here instead.
//
// Selection lives in the URL (`form-links` with an optional `linkUuid`),
// not here — the case-operations precedent.
//
// Every legality question routes to the planners in `formLinkMutations.ts`
// and the verdicts in `formLinkReview.ts`. This hook decides nothing; it
// asks, and hands the answer to the surface that has to explain it.

"use client";

import { useCallback, useMemo } from "react";
import type {
	CommitOutcome,
	FormLink,
	FormLinkTarget,
	PostSubmitDestination,
} from "@/lib/domain";
import {
	type AfterSubmitPlan,
	afterSubmitPlan,
	type FallbackChoice,
	type FormLinkCommitPlan,
	planFormLinkAdd,
	planFormLinkMove,
	planFormLinkRemove,
	planFormLinkUpdate,
	planSetFallback,
} from "../formLinkMutations";
import {
	type FormLinkAddChoices,
	type FormLinkCarryVerdict,
	type FormLinkMoveVerdict,
	type FormLinkRequiredDatum,
	type FormLinkTargetVerdict,
	formLinkAddChoices,
	formLinkCarryVerdict,
	formLinkMoveVerdicts,
	formLinkRequiredDatums,
	formLinkTargetVerdict,
} from "../formLinkReview";
import type { Uuid } from "../types";
import { useBlueprintDoc, useBlueprintDocApi } from "./useBlueprintDoc";
import { useBlueprintMutations } from "./useBlueprintMutations";

/**
 * A write that may have pinned the form's built-in fallback in the same
 * batch (`pinsFallback`): adding a conditional link, or giving the
 * otherwise link a condition, leaves every link conditional, and the
 * planner then stores the current destination explicitly so the gate's
 * `FORM_LINK_NO_FALLBACK` is never met. The surface says so.
 */
export type FormLinkWriteOutcome = CommitOutcome & {
	readonly pinsFallback?: PostSubmitDestination;
};

export type FormLinkMoveCommitOutcome =
	| { readonly ok: true; readonly index: number; readonly total: number }
	| { readonly ok: false; readonly messages: string[] };

export interface FormLinksView {
	/** The links in the order they are checked. */
	readonly links: readonly FormLink[];
	/** What runs when nothing matched; `undefined` once the form is gone. */
	readonly plan: AfterSubmitPlan | undefined;
	/** The move verdict for every candidate position of one link. */
	readonly moveVerdicts: (
		uuid: Uuid,
	) => ReadonlyMap<number, FormLinkMoveVerdict>;
	/** Whether a link (being edited, or new) may point at a target. */
	readonly targetVerdict: (
		editing: Uuid | undefined,
		target: FormLinkTarget,
	) => FormLinkTargetVerdict;
	/** The selection datums a destination needs carried. */
	readonly requiredDatums: (
		target: FormLinkTarget,
	) => readonly FormLinkRequiredDatum[];
	/** Whether those datums can be carried automatically from this form. */
	readonly carryVerdict: (target: FormLinkTarget) => FormLinkCarryVerdict;
	/** Which kinds of link the add control may offer right now. */
	readonly addChoices: () => FormLinkAddChoices;
	/** The remove plan, for the confirm copy (it names a fallback pin). */
	readonly removalPlan: (uuid: Uuid) => FormLinkCommitPlan;
	/** The fallback plan, for the confirm copy. */
	readonly fallbackPlan: (next: FallbackChoice) => FormLinkCommitPlan;
	readonly add: (link: FormLink, after?: Uuid | null) => FormLinkWriteOutcome;
	readonly update: (next: FormLink, base: FormLink) => FormLinkWriteOutcome;
	readonly remove: (uuid: Uuid) => CommitOutcome | undefined;
	readonly move: (
		uuid: Uuid,
		index: number,
	) => FormLinkMoveCommitOutcome | undefined;
	readonly setFallback: (next: FallbackChoice) => CommitOutcome;
}

function refused(message: string): CommitOutcome {
	return { ok: false, messages: [message] };
}

export function useFormLinks(formUuid: Uuid): FormLinksView {
	const mutations = useBlueprintMutations();
	const docApi = useBlueprintDocApi();
	/* The whole doc: every planner takes it. */
	const doc = useBlueprintDoc((state) => state);

	const links = useMemo(
		() => doc.forms[formUuid]?.formLinks ?? [],
		[doc, formUuid],
	);
	const plan = useMemo(() => afterSubmitPlan(doc, formUuid), [doc, formUuid]);

	const moveVerdicts = useCallback(
		(uuid: Uuid) => formLinkMoveVerdicts(doc, formUuid, uuid),
		[doc, formUuid],
	);
	const targetVerdict = useCallback(
		(editing: Uuid | undefined, target: FormLinkTarget) =>
			formLinkTargetVerdict(doc, formUuid, editing, target),
		[doc, formUuid],
	);
	const requiredDatums = useCallback(
		(target: FormLinkTarget) => formLinkRequiredDatums(doc, formUuid, target),
		[doc, formUuid],
	);
	const carryVerdict = useCallback(
		(target: FormLinkTarget) => formLinkCarryVerdict(doc, formUuid, target),
		[doc, formUuid],
	);
	const addChoices = useCallback(
		() => formLinkAddChoices(doc, formUuid),
		[doc, formUuid],
	);
	const removalPlan = useCallback(
		(uuid: Uuid) => planFormLinkRemove(doc, formUuid, uuid),
		[doc, formUuid],
	);
	const fallbackPlan = useCallback(
		(next: FallbackChoice) => planSetFallback(doc, formUuid, next),
		[doc, formUuid],
	);

	/* Inline, not toasting: a refusal belongs beside the list it is about,
	 * and these surfaces all have somewhere to put it. Every write reads
	 * the store at invocation, never the render's doc. */
	const add = useCallback(
		(link: FormLink, after?: Uuid | null): FormLinkWriteOutcome => {
			const planned = planFormLinkAdd(docApi.getState(), formUuid, link, after);
			if (!planned.ok) {
				return refused(
					planned.reason.kind === "duplicate-uuid"
						? "This link was added elsewhere first. Review the latest list and try again."
						: planned.reason.kind === "form-not-found"
							? "This form is no longer part of the app."
							: "This link can't be added here. Review the latest list and try again.",
				);
			}
			const outcome = mutations.inline.commitMany([...planned.mutations]);
			return outcome.ok
				? {
						...outcome,
						...(planned.pinsFallback && { pinsFallback: planned.pinsFallback }),
					}
				: outcome;
		},
		[docApi, formUuid, mutations],
	);

	const update = useCallback(
		(next: FormLink, base: FormLink): FormLinkWriteOutcome => {
			const planned = planFormLinkUpdate(
				docApi.getState(),
				formUuid,
				next,
				base,
			);
			if (!planned.ok) {
				return refused(
					planned.reason.kind === "link-not-found"
						? "This link is no longer part of the form."
						: planned.reason.kind === "stale-base"
							? "This link was changed elsewhere first. Review the latest list and try again."
							: "This change can't be made here. Review the latest list and try again.",
				);
			}
			if (planned.mutations.length === 0) return { ok: true as const };
			const outcome = mutations.inline.commitMany([...planned.mutations]);
			return outcome.ok
				? {
						...outcome,
						...(planned.pinsFallback && { pinsFallback: planned.pinsFallback }),
					}
				: outcome;
		},
		[docApi, formUuid, mutations],
	);

	const remove = useCallback(
		(uuid: Uuid) => {
			const planned = planFormLinkRemove(docApi.getState(), formUuid, uuid);
			// A refused plan never reaches the store: the link is already gone.
			return planned.ok
				? mutations.inline.commitMany([...planned.mutations])
				: undefined;
		},
		[docApi, formUuid, mutations],
	);

	const move = useCallback(
		(uuid: Uuid, index: number) => {
			const planned = planFormLinkMove(
				docApi.getState(),
				formUuid,
				uuid,
				index,
			);
			if (!planned.ok) return undefined;
			const position = (): FormLinkMoveCommitOutcome | undefined => {
				const current = docApi.getState().forms[formUuid]?.formLinks ?? [];
				const at = current.findIndex((link) => link.uuid === uuid);
				return at < 0
					? undefined
					: { ok: true, index: at, total: current.length };
			};
			if (planned.mutations.length === 0) return position();
			const outcome = mutations.inline.commitMany([...planned.mutations]);
			return outcome.ok ? position() : outcome;
		},
		[docApi, formUuid, mutations],
	);

	const setFallback = useCallback(
		(next: FallbackChoice) => {
			const planned = planSetFallback(docApi.getState(), formUuid, next);
			if (!planned.ok) {
				return refused(
					planned.reason.kind === "else-exists"
						? "This form already has an otherwise destination. Change it instead of adding another."
						: "This destination can't be used here. Review the latest list and try again.",
				);
			}
			if (planned.mutations.length === 0) return { ok: true as const };
			return mutations.inline.commitMany([...planned.mutations]);
		},
		[docApi, formUuid, mutations],
	);

	return useMemo(
		() => ({
			links,
			plan,
			moveVerdicts,
			targetVerdict,
			requiredDatums,
			carryVerdict,
			addChoices,
			removalPlan,
			fallbackPlan,
			add,
			update,
			remove,
			move,
			setFallback,
		}),
		[
			links,
			plan,
			moveVerdicts,
			targetVerdict,
			requiredDatums,
			carryVerdict,
			addChoices,
			removalPlan,
			fallbackPlan,
			add,
			update,
			remove,
			move,
			setFallback,
		],
	);
}
