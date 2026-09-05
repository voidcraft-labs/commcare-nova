// components/builder/case-list-config/noMatchesFormReview.tsx
//
// One decision, reachable from two places: which registration form, if
// any, Results offers after a search finds nothing. The Search canvas's
// "When no cases match" setting and a registration form's own settings
// both plan through `lib/doc/searchNoMatchesForm.ts`, review the exact
// batch against the gate, and name the worker-visible consequences (the
// module opening on Search, the form leaving the menu) before committing.
// Clearing is reviewed the same way, because it is not the menu alone that
// changes: Search first turns off with it, and the starting values the
// form read from the search go.

"use client";

import { useCallback, useRef, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	noMatchesFormEntryMutations,
	noMatchesRegistrationFormMutations,
	searchAnswerDefaultsOf,
} from "@/lib/doc/searchNoMatchesForm";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	caseSelectionCardinality,
	menuFormUuidsOf,
	moduleOpensOnSearch,
	noMatchesFormOf,
	type Uuid,
} from "@/lib/domain";

/** What the person asked Results to offer after an empty search. */
export type NoMatchesFormChoice =
	/** Nova adds a registration form carrying the search answers. */
	| { readonly kind: "create" }
	/** An existing registration form of the module leaves the menu. */
	| { readonly kind: "existing"; readonly formUuid: Uuid }
	/** The current no-matches form becomes a menu form again. */
	| { readonly kind: "clear" };

export interface NoMatchesFormReview {
	readonly choice: NoMatchesFormChoice;
	/** The form Results will offer, or the one returning to the menu. */
	readonly formName: string;
	/** Whether the batch turns Search first on for the module. */
	readonly turnsSearchFirstOn: boolean;
	/** Whether the batch turns Search first off (a clear on a module that
	 *  opens on Search). */
	readonly turnsSearchFirstOff: boolean;
	/** How many fields lose the starting value they read from the search
	 *  (a clear). */
	readonly defaultsCleared: number;
	/** Whether the module keeps a menu form once this one leaves the menu:
	 *  decides where the registration returns (Results with the new case,
	 *  or the module's Search). */
	readonly hostKeepsMenuForms: boolean;
	readonly appHomeAfterSubmit: boolean;
	/** The gate's refusals for the exact batch; empty when it would commit. */
	readonly blockers: readonly string[];
}

interface PlannedChoice {
	readonly formUuid: Uuid;
	readonly mutations: Mutation[];
	readonly formName: string;
}

function planChoice(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	choice: NoMatchesFormChoice,
): PlannedChoice | null {
	switch (choice.kind) {
		case "create": {
			const module = doc.modules[moduleUuid];
			const planned = noMatchesRegistrationFormMutations(
				doc,
				moduleUuid,
				module && caseSelectionCardinality(module) === "multiple"
					? { postSubmit: "app_home" }
					: {},
			);
			return planned === null
				? null
				: {
						mutations: planned.mutations,
						formName: planned.formName,
						formUuid: planned.formUuid,
					};
		}
		case "existing": {
			const form = doc.forms[choice.formUuid];
			if (form === undefined) return null;
			return {
				formUuid: form.uuid,
				mutations: noMatchesFormEntryMutations(
					doc,
					moduleUuid,
					choice.formUuid,
					{
						kind: "search-no-matches",
					},
				),
				formName: form.name,
			};
		}
		case "clear": {
			const form = noMatchesFormOf(doc, moduleUuid);
			if (form === undefined) return null;
			return {
				formUuid: form.uuid,
				mutations: noMatchesFormEntryMutations(
					doc,
					moduleUuid,
					form.uuid,
					null,
				),
				formName: form.name,
			};
		}
	}
}

/**
 * The controller both surfaces share: `request` plans the choice against
 * the live document and opens the review; `confirm` replans against the
 * freshest document and commits. Every commit and refusal lands in
 * `announcement` / `refusal` for the host's live regions.
 */
export function useNoMatchesFormEntry(moduleUuid: Uuid | undefined) {
	const docApi = useBlueprintDocApi();
	const { inline } = useBlueprintMutations();
	const [review, setReview] = useState<NoMatchesFormReview | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const [refusal, setRefusal] = useState<string | undefined>(undefined);
	const originRef = useRef<HTMLElement | null>(null);

	const describe = useCallback(
		(
			doc: BlueprintDoc,
			choice: NoMatchesFormChoice,
			planned: PlannedChoice,
			blockers: readonly string[],
		): NoMatchesFormReview => {
			if (moduleUuid === undefined) throw new Error("module required");
			const mod = doc.modules[moduleUuid];
			const opensOnSearch = mod !== undefined && moduleOpensOnSearch(mod);
			const menuForms = menuFormUuidsOf(doc, moduleUuid).filter(
				(uuid) => choice.kind !== "existing" || uuid !== choice.formUuid,
			);
			const clearing = choice.kind === "clear";
			const current = clearing ? noMatchesFormOf(doc, moduleUuid) : undefined;
			let appHomeAfterSubmit =
				doc.forms[planned.formUuid]?.postSubmit === "app_home";
			for (const mutation of planned.mutations) {
				if (
					mutation.kind === "addForm" &&
					mutation.form.uuid === planned.formUuid
				)
					appHomeAfterSubmit = mutation.form.postSubmit === "app_home";
				if (
					mutation.kind === "updateForm" &&
					mutation.uuid === planned.formUuid &&
					Object.hasOwn(mutation.patch, "postSubmit")
				)
					appHomeAfterSubmit = mutation.patch.postSubmit === "app_home";
			}
			return {
				choice,
				formName: planned.formName,
				turnsSearchFirstOn: !clearing && !opensOnSearch,
				turnsSearchFirstOff: clearing && opensOnSearch,
				defaultsCleared:
					current === undefined
						? 0
						: searchAnswerDefaultsOf(doc, moduleUuid, current.uuid).length,
				hostKeepsMenuForms: menuForms.length > 0,
				appHomeAfterSubmit,
				blockers,
			};
		},
		[moduleUuid],
	);

	const request = useCallback(
		(choice: NoMatchesFormChoice, origin?: HTMLElement | null) => {
			if (moduleUuid === undefined) return;
			originRef.current = origin ?? null;
			setRefusal(undefined);
			const doc = docApi.getState();
			const planned = planChoice(doc, moduleUuid, choice);
			if (planned === null) return;
			const reviewed = inline.reviewMany([...planned.mutations]);
			setReview(
				describe(doc, choice, planned, reviewed.ok ? [] : reviewed.messages),
			);
		},
		[describe, docApi, inline, moduleUuid],
	);

	const confirm = useCallback(() => {
		if (
			review === null ||
			review.blockers.length > 0 ||
			moduleUuid === undefined
		)
			return;
		const doc = docApi.getState();
		const planned = planChoice(doc, moduleUuid, review.choice);
		if (planned === null) {
			setReview(null);
			setRefusal(
				"This form is no longer in the module. Choose again from the current forms.",
			);
			return;
		}
		const outcome = inline.commitMany(planned.mutations);
		if (!outcome.ok) {
			// The document moved under the review: show the fresh refusals.
			setReview(describe(doc, review.choice, planned, outcome.messages));
			return;
		}
		setReview(null);
		setAnnouncement(
			review.choice.kind === "create"
				? `“${planned.formName}” was added. Results offers it after a search finds nothing, and the module opens on Search.`
				: review.choice.kind === "existing"
					? `Results offers “${planned.formName}” after a search finds nothing, and the module opens on Search.`
					: `“${planned.formName}” is a menu form again. Results shows only the notice when nothing matches${review.turnsSearchFirstOff ? ", and the module opens on its case list" : ""}.`,
		);
	}, [describe, docApi, inline, moduleUuid, review]);

	const cancel = useCallback(() => setReview(null), []);
	const finalFocus = useCallback(() => originRef.current, []);

	return {
		review,
		request,
		confirm,
		cancel,
		finalFocus,
		announcement,
		refusal,
	};
}

/**
 * Review the choice before the document changes. The controller owns the
 * planning and the commit; this names what people will see.
 */
export function NoMatchesFormReviewDialog({
	review,
	finalFocus,
	onCancel,
	onConfirm,
}: {
	readonly review: NoMatchesFormReview;
	readonly finalFocus: () => HTMLElement | null;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
}) {
	const cancelRef = useRef<HTMLButtonElement>(null);
	const blocked = review.blockers.length > 0;
	const creating = review.choice.kind === "create";
	const clearing = review.choice.kind === "clear";
	const title = blocked
		? clearing
			? "Review this form before it returns to the menu"
			: "Review this module before offering a form"
		: clearing
			? `Make “${review.formName}” a menu form again?`
			: creating
				? `Add “${review.formName}” for empty searches?`
				: `Offer “${review.formName}” after an empty search?`;
	const description = blocked
		? "Nothing has changed. Each item below explains what needs attention. Once these items are resolved, this setting will be available."
		: clearing
			? `“${review.formName}” returns to the module menu, and Results shows only the notice when a search finds nothing.`
			: `When a search finds nothing, Results offers “${review.formName}”. It opens with the search's answers, so people register what they looked for.`;
	return (
		<AlertDialog
			open
			onOpenChange={(open) => {
				if (!open) onCancel();
			}}
		>
			<AlertDialogContent
				className="text-left sm:max-w-lg"
				initialFocus={cancelRef}
				finalFocus={finalFocus}
				data-no-matches-review
			>
				<AlertDialogHeader>
					<AlertDialogTitle className="font-display tracking-tighter">
						{title}
					</AlertDialogTitle>
					<AlertDialogDescription className="text-left">
						{description}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogBody>
					{blocked ? (
						<ul className="space-y-2">
							{review.blockers.map((message) => (
								<li
									key={message}
									className="rounded-xl border border-nova-rose/25 bg-nova-rose/[0.05] p-3 text-[13px] leading-5 text-nova-text-secondary"
								>
									{message}
								</li>
							))}
						</ul>
					) : clearing ? (
						<div className="space-y-3 text-[13px] leading-5 text-nova-text-secondary">
							{review.turnsSearchFirstOff && (
								<p className="rounded-xl border border-nova-amber/25 bg-nova-amber/[0.05] p-3">
									Search first turns off. A menu registration form cannot open
									on Search, so the module opens on its case list with a Search
									button. Existing after-submit choices stay the same.
								</p>
							)}
							{review.defaultsCleared > 0 && (
								<p className="rounded-xl border border-white/[0.07] bg-nova-surface/20 p-3">
									{review.defaultsCleared === 1
										? "One field loses the starting value it read from the search. The field stays."
										: `${review.defaultsCleared} fields lose the starting values they read from the search. The fields stay.`}
								</p>
							)}
							<p className="text-nova-text-muted">You can undo this.</p>
						</div>
					) : (
						<div className="space-y-3 text-[13px] leading-5 text-nova-text-secondary">
							{review.turnsSearchFirstOn && (
								<p className="rounded-xl border border-nova-amber/25 bg-nova-amber/[0.05] p-3">
									Search first turns on. People search before they see any
									cases, and Results shows only what a search finds.
								</p>
							)}
							<p className="rounded-xl border border-white/[0.07] bg-nova-surface/20 p-3">
								“{review.formName}” leaves the menu. It opens only from Results
								after a search finds nothing, and after submit it opens{" "}
								{review.appHomeAfterSubmit
									? "App home."
									: review.hostKeepsMenuForms
										? "Results showing the case it registered."
										: "Search, since the module has no other forms."}
							</p>
							{creating && (
								<p className="rounded-xl border border-white/[0.07] bg-nova-surface/20 p-3">
									The form starts with a field for each search field, filled in
									from the answer, and a name for the new case.
								</p>
							)}
							<p className="text-nova-text-muted">
								This works in the browser app. A phone never shows Results for
								an empty search.
							</p>
						</div>
					)}
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel ref={cancelRef}>
						{blocked
							? "Close"
							: clearing
								? "Keep offering it"
								: "Keep the notice only"}
					</AlertDialogCancel>
					{!blocked && (
						<AlertDialogAction onClick={onConfirm}>
							{clearing
								? "Make it a menu form"
								: creating
									? "Add the form"
									: "Offer the form"}
						</AlertDialogAction>
					)}
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
