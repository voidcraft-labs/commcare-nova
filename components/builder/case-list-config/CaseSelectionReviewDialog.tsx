"use client";

import { useRef } from "react";
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
import type { CaseSelectionTransition } from "@/lib/doc/caseSelectionMutations";
import type { CaptureCaseWriteMode, CaseSelection, Uuid } from "@/lib/domain";

export interface CaseSelectionReviewBlocker {
	readonly key: string;
	readonly message: string;
	readonly actionLabel?: string;
	readonly onOpen?: () => void;
}

export interface CaseSelectionStartingAnswer {
	readonly key: string;
	readonly fieldName: string;
	readonly formName: string;
}

export interface CaseSelectionAttachmentAnswer {
	readonly key: string;
	readonly fieldName: string;
	readonly formName: string;
	readonly mode: CaptureCaseWriteMode;
}

export interface CaseSelectionReviewDialogProps {
	readonly sourceModuleUuid: Uuid;
	readonly current: CaseSelection | undefined;
	readonly requested: CaseSelection | undefined;
	readonly transitions: readonly CaseSelectionTransition[];
	readonly startingAnswers: readonly CaseSelectionStartingAnswer[];
	readonly attachmentAnswers: readonly CaseSelectionAttachmentAnswer[];
	readonly blockers: readonly CaseSelectionReviewBlocker[];
	readonly refreshNotice?: string;
	readonly finalFocus: () => HTMLElement | null;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
}

function selectionDescription(selection: CaseSelection | undefined): string {
	return selection === undefined
		? "one case at a time"
		: `up to ${selection.maximum} ${selection.maximum === 1 ? "case" : "cases"}`;
}

/**
 * Review one semantic Case selection transition before the document changes.
 * The controller owns replanning and the final commit; this component names
 * the worker-visible consequences and routes exact blockers to their editors.
 */
export function CaseSelectionReviewDialog({
	sourceModuleUuid,
	current,
	requested,
	transitions,
	startingAnswers,
	attachmentAnswers,
	blockers,
	refreshNotice,
	finalFocus,
	onCancel,
	onConfirm,
}: CaseSelectionReviewDialogProps) {
	const cancelRef = useRef<HTMLButtonElement>(null);
	const blocked = blockers.length > 0;
	const changingMode = (current === undefined) !== (requested === undefined);
	const several = requested?.kind === "multiple";
	const sourceTransition = transitions.find(
		(transition) => transition.moduleUuid === sourceModuleUuid,
	);
	const linkedTransitions = transitions.filter(
		(transition) => transition.moduleUuid !== sourceModuleUuid,
	);
	const title = blocked
		? `Review this workflow before using ${several ? "several cases" : "one case"}`
		: changingMode
			? several
				? "Apply one form to several cases?"
				: "Return to one case at a time?"
			: "Change how many cases people can choose?";
	const description = blocked
		? "Nothing has changed. Each item below explains what needs attention. When an item has a matching editor, you can open it here. Once these items are resolved, this setting will be available."
		: several
			? `People will choose ${selectionDescription(requested)} and complete the form once with one shared set of answers for every case they chose.`
			: "People will choose one case. Its saved information will fill the form, and submitting the form will update only that case.";
	const cancelLabel = changingMode
		? several
			? "Keep one case"
			: "Keep several cases"
		: "Keep current limit";
	const confirmLabel = changingMode
		? several
			? "Use several cases"
			: "Use one case"
		: requested === undefined
			? "Keep one case"
			: `Set limit to ${requested.maximum}`;

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
					<p
						role="alert"
						aria-atomic="true"
						className={
							refreshNotice === undefined
								? "sr-only"
								: "mb-3 rounded-xl border border-nova-amber/25 bg-nova-amber/[0.05] p-3 text-[13px] leading-5 text-nova-text-secondary"
						}
					>
						{refreshNotice ?? ""}
					</p>
					{blocked ? (
						<ul className="space-y-2">
							{blockers.map((blocker) => (
								<li
									key={blocker.key}
									className="rounded-xl border border-nova-rose/25 bg-nova-rose/[0.05] p-3"
								>
									<p className="text-[13px] leading-5 text-nova-text-secondary">
										{blocker.message}
									</p>
									{blocker.onOpen !== undefined &&
										blocker.actionLabel !== undefined && (
											<button
												type="button"
												onClick={blocker.onOpen}
												className="nova-focusable mt-2 min-h-11 rounded-lg px-2 text-sm font-medium text-nova-link outline-none hover:text-nova-link-hover"
											>
												{blocker.actionLabel}
											</button>
										)}
								</li>
							))}
						</ul>
					) : (
						<div className="space-y-3 text-[13px] leading-5 text-nova-text-secondary">
							{several && (
								<p className="rounded-xl border border-white/[0.07] bg-nova-surface/20 p-3">
									Existing case information does not fill this shared form. A
									question without a starting answer begins blank, and leaving
									it blank keeps each case's current value.
								</p>
							)}

							{startingAnswers.map((answer) => (
								<p
									key={answer.key}
									className="rounded-xl border border-nova-amber/25 bg-nova-amber/[0.05] p-3"
								>
									“{answer.fieldName}” in “{answer.formName}” has a starting
									answer or calculation. When it produces an answer, that answer
									will be saved to every selected case even if the person does
									not change it.
								</p>
							))}

							{attachmentAnswers.map((answer) => (
								<p
									key={answer.key}
									className="rounded-xl border border-nova-amber/25 bg-nova-amber/[0.05] p-3"
								>
									“{answer.fieldName}” in “{answer.formName}” saves the{" "}
									{answer.mode === "url" ? "stored file link" : "file itself"}{" "}
									to every selected case when someone submits a file. Preview
									leaves each case's current value unchanged because it does not
									create{" "}
									{answer.mode === "url" ? "that link" : "case attachments"}.
								</p>
							))}

							{linkedTransitions.length > 0 && (
								<section aria-labelledby="linked-selection-changes">
									<h3
										id="linked-selection-changes"
										className="mb-1.5 font-medium text-nova-text"
									>
										Linked workflow changes
									</h3>
									<ul className="space-y-1.5">
										{linkedTransitions.map((transition) => (
											<li
												key={transition.moduleUuid}
												className="rounded-xl border border-white/[0.07] bg-nova-surface/20 p-3"
											>
												“{transition.moduleName}” will also use{" "}
												{selectionDescription(transition.selection)} so the
												linked workflow remains continuous.
												{transition.clearsPersistentTile && (
													<span className="mt-1 block text-nova-text-muted">
														Its Results tile will no longer stay above forms.
														The layout and grouping will stay the same.
													</span>
												)}
											</li>
										))}
									</ul>
								</section>
							)}

							{sourceTransition?.clearsPersistentTile === true && (
								<p className="rounded-xl border border-white/[0.07] bg-nova-surface/20 p-3">
									The Results tile will no longer stay above forms. Its layout
									and grouping will stay the same.
								</p>
							)}
						</div>
					)}
				</AlertDialogBody>

				<AlertDialogFooter>
					<AlertDialogCancel ref={cancelRef}>{cancelLabel}</AlertDialogCancel>
					{!blocked && (
						<AlertDialogAction onClick={onConfirm}>
							{confirmLabel}
						</AlertDialogAction>
					)}
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
