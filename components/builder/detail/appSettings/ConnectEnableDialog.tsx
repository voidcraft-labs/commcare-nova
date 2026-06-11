"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useId, useRef, useState } from "react";
import { Toggle } from "@/components/ui/Toggle";
import { parseXPathForForm } from "@/lib/doc/expressionText";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import type { ConnectConfig, ConnectType, XPathExpression } from "@/lib/domain";
import { asUuid } from "@/lib/domain";

/**
 * The staging step of the Connect enable flows. Enabling Connect (or
 * switching its mode) commits as ONE batch — `setConnectType` plus each
 * participating form's connect block — and the commit gate rejects a
 * flip that leaves the app with no participating form. Participation is
 * per form: a connect block opts the form INTO Connect; a form left
 * without one stays auxiliary and needs nothing. Forms whose block the
 * session stash already holds restore silently (they participate
 * without appearing here); this dialog collects the rest FROM THE USER
 * before anything commits. Nothing is pre-filled: a Connect block's
 * name and description are content the user writes, not placeholders
 * Nova invents.
 *
 * Per form, the user opts into the mode's sub-configs (learn: Learn
 * module / Assessment; deliver: Deliver unit / Task) and fills each
 * enabled one's fields. Turning on a sub-config is what picks the form
 * as participating; a form with none enabled is simply left out of the
 * commit. The confirm button stays disabled until every enabled
 * sub-config is complete AND at least one form participates (counting
 * the stash-restored ones via `restoredFormCount`) — the same bar the
 * commit gate holds, surfaced before the commit instead of as a bounce.
 * Connect ids are not collected here: the commit path autofills valid,
 * app-unique ids the same way agent-side creation does.
 */

/** One form the stash doesn't cover — the dialog collects its block. */
export interface ConnectStagingTarget {
	formUuid: string;
	formName: string;
	moduleName: string;
}

/** Local draft of one form's block — strings as typed, opt-ins explicit. */
interface BlockDraft {
	learnOn: boolean;
	learnName: string;
	learnDescription: string;
	learnTimeEstimate: string;
	assessmentOn: boolean;
	userScore: string;
	deliverOn: boolean;
	deliverName: string;
	taskOn: boolean;
	taskName: string;
	taskDescription: string;
}

const EMPTY_DRAFT: BlockDraft = {
	learnOn: false,
	learnName: "",
	learnDescription: "",
	learnTimeEstimate: "",
	assessmentOn: false,
	userScore: "",
	deliverOn: false,
	deliverName: "",
	taskOn: false,
	taskName: "",
	taskDescription: "",
};

/** Parse the time-estimate draft: a positive integer (minutes) or null. */
export function parseTimeEstimate(raw: string): number | null {
	const n = Number(raw.trim());
	return Number.isInteger(n) && n >= 1 ? n : null;
}

/** Whether one draft PARTICIPATES: at least one sub-config is enabled.
 *  A draft with none stays auxiliary and is left out of the commit. */
function draftParticipates(draft: BlockDraft, mode: ConnectType): boolean {
	return mode === "learn"
		? draft.learnOn || draft.assessmentOn
		: draft.deliverOn || draft.taskOn;
}

/** Whether every ENABLED sub-config in one draft is complete. An enabled
 *  assessment is always complete — its `user_score` is optional content
 *  (the wire layer substitutes the canonical default when unset). A
 *  draft with nothing enabled is trivially complete (it participates in
 *  nothing). */
function draftSectionsComplete(draft: BlockDraft, mode: ConnectType): boolean {
	if (mode === "learn") {
		const learnOk =
			draft.learnName.trim().length > 0 &&
			draft.learnDescription.trim().length > 0 &&
			parseTimeEstimate(draft.learnTimeEstimate) !== null;
		return !draft.learnOn || learnOk;
	}
	const unitOk = draft.deliverOn && draft.deliverName.trim().length > 0;
	const taskOk =
		draft.taskOn &&
		draft.taskName.trim().length > 0 &&
		draft.taskDescription.trim().length > 0;
	return (!draft.deliverOn || unitOk) && (!draft.taskOn || taskOk);
}

/** Lower a complete draft to the `ConnectConfig` the commit path lands.
 *  Ids are deliberately absent — the commit path autofills them. A blank
 *  user_score is likewise omitted so the wire-emit default applies
 *  (writing `""` would trip the `CONNECT_EMPTY_XPATH` validator). */
function draftToConfig(
	draft: BlockDraft,
	mode: ConnectType,
	parseExpr: (text: string) => XPathExpression,
): ConnectConfig {
	if (mode === "learn") {
		return {
			...(draft.learnOn && {
				learn_module: {
					name: draft.learnName.trim(),
					description: draft.learnDescription.trim(),
					time_estimate: parseTimeEstimate(draft.learnTimeEstimate) ?? 1,
				},
			}),
			...(draft.assessmentOn && {
				assessment: {
					...(draft.userScore.trim() && {
						user_score: parseExpr(draft.userScore.trim()),
					}),
				},
			}),
		};
	}
	return {
		...(draft.deliverOn && {
			deliver_unit: { name: draft.deliverName.trim() },
		}),
		...(draft.taskOn && {
			task: {
				name: draft.taskName.trim(),
				description: draft.taskDescription.trim(),
			},
		}),
	};
}

/** Compact labeled input for staged Connect drafts — plain controlled
 *  state, no per-field save (the owner commits the whole block at once).
 *  Shared by this dialog and the per-form sub-toggle staging in
 *  `LearnConfig` / `DeliverConfig`, which scale the same
 *  collect-before-commit pattern down to one sub-config. */
export function DraftField({
	label,
	value,
	onChange,
	multiline,
	suffix,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	multiline?: boolean;
	suffix?: string;
}) {
	const fieldId = useId();
	const inputClass =
		"w-full rounded-md bg-white/[0.04] border border-white/[0.08] px-2 py-1 text-xs text-nova-text placeholder:text-nova-text-muted focus:border-nova-violet/50 focus:outline-none";
	return (
		<div>
			<label
				htmlFor={fieldId}
				className="block text-[10px] text-nova-text-muted uppercase tracking-wider mb-1"
			>
				{label}
			</label>
			<div className="relative">
				{multiline ? (
					<textarea
						id={fieldId}
						className={`${inputClass} resize-none`}
						rows={2}
						value={value}
						onChange={(e) => onChange(e.target.value)}
						autoComplete="off"
						data-1p-ignore
					/>
				) : (
					<input
						id={fieldId}
						type="text"
						className={`${inputClass}${suffix ? " pr-9" : ""}`}
						value={value}
						onChange={(e) => onChange(e.target.value)}
						autoComplete="off"
						data-1p-ignore
					/>
				)}
				{suffix && (
					<span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-nova-text-muted">
						{suffix}
					</span>
				)}
			</div>
		</div>
	);
}

/** One sub-config card: an opt-in toggle revealing its fields. */
function SubConfigCard({
	title,
	enabled,
	onToggle,
	children,
}: {
	title: string;
	enabled: boolean;
	onToggle: () => void;
	children?: React.ReactNode;
}) {
	return (
		<div className="rounded-lg bg-white/[0.03] border border-white/[0.05] px-2.5 py-2">
			<div className="flex items-center justify-between">
				<span className="text-[10px] text-nova-text-muted uppercase tracking-wider">
					{title}
				</span>
				<Toggle enabled={enabled} onToggle={onToggle} variant="sub" />
			</div>
			{enabled && children && (
				<div className="space-y-2 pt-2.5 mt-2 border-t border-white/[0.05]">
					{children}
				</div>
			)}
		</div>
	);
}

export function ConnectEnableDialog({
	mode,
	targets,
	restoredFormCount,
	rejectionMessages,
	onCancel,
	onConfirm,
}: {
	mode: ConnectType;
	targets: readonly ConnectStagingTarget[];
	/** Forms whose block restores silently from the session stash — they
	 *  participate without appearing in this dialog, so they count toward
	 *  the at-least-one-participating-form bar the confirm enforces. */
	restoredFormCount: number;
	/** Findings from a confirm attempt the commit gate bounced — shown
	 *  inline so the dialog explains itself without relying on the toast. */
	rejectionMessages: readonly string[];
	onCancel: () => void;
	onConfirm: (blocks: Record<string, ConnectConfig>) => void;
}) {
	const [drafts, setDrafts] = useState<Record<string, BlockDraft>>(() =>
		Object.fromEntries(targets.map((t) => [t.formUuid, EMPTY_DRAFT])),
	);
	const onCancelRef = useRef(onCancel);
	onCancelRef.current = onCancel;

	const patchDraft = useCallback(
		(formUuid: string, patch: Partial<BlockDraft>) => {
			setDrafts((prev) => ({
				...prev,
				[formUuid]: { ...(prev[formUuid] ?? EMPTY_DRAFT), ...patch },
			}));
		},
		[],
	);

	const sectionsComplete = targets.every((t) =>
		draftSectionsComplete(drafts[t.formUuid] ?? EMPTY_DRAFT, mode),
	);
	const participatingCount =
		restoredFormCount +
		targets.filter((t) =>
			draftParticipates(drafts[t.formUuid] ?? EMPTY_DRAFT, mode),
		).length;
	const canConfirm = sectionsComplete && participatingCount >= 1;

	const docApi = useBlueprintDocApi();
	const confirm = () => {
		// Each block's authored XPath resolves against ITS form, at the
		// moment of the commit. Non-participating forms are left out of the
		// payload entirely — an empty block landing on them would read as a
		// malformed participation claim, not as staying auxiliary.
		const doc = docApi.getState();
		onConfirm(
			Object.fromEntries(
				targets
					.filter((t) =>
						draftParticipates(drafts[t.formUuid] ?? EMPTY_DRAFT, mode),
					)
					.map((t) => [
						t.formUuid,
						draftToConfig(drafts[t.formUuid] ?? EMPTY_DRAFT, mode, (text) =>
							parseXPathForForm(doc, asUuid(t.formUuid), text),
						),
					]),
			),
		);
	};

	const dialogRef = useCallback((el: HTMLDivElement | null) => {
		if (!el) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") onCancelRef.current();
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, []);

	return (
		<AnimatePresence>
			<motion.div
				ref={dialogRef}
				className="fixed inset-0 z-modal flex items-center justify-center"
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				exit={{ opacity: 0 }}
				transition={{ duration: 0.15 }}
			>
				<button
					type="button"
					className="absolute inset-0 bg-black/60 cursor-default appearance-none border-none p-0"
					onClick={onCancel}
					tabIndex={-1}
					aria-label="Close dialog"
				/>

				<motion.div
					className="relative z-10 w-[26rem] max-h-[80vh] flex flex-col rounded-xl bg-nova-deep border border-nova-border shadow-xl"
					initial={{ scale: 0.95, opacity: 0 }}
					animate={{ scale: 1, opacity: 1 }}
					exit={{ scale: 0.95, opacity: 0 }}
					transition={{ duration: 0.15 }}
				>
					<div className="p-5 pb-3">
						<h3 className="text-sm font-semibold text-nova-text mb-1">
							Set up Connect {mode === "learn" ? "Learn" : "Deliver"}
						</h3>
						<p className="text-xs text-nova-text-secondary">
							{targets.length === 1 && restoredFormCount === 0
								? "Turn on a section below and fill it in to make this form part of Connect."
								: "Pick which forms take part in Connect by turning on their sections and filling them in. Forms you leave off stay out of Connect and need nothing — you can add them later from each form's settings."}
						</p>
					</div>

					<div className="flex-1 overflow-y-auto px-5 space-y-4">
						{targets.map((t) => {
							const draft = drafts[t.formUuid] ?? EMPTY_DRAFT;
							return (
								<div key={t.formUuid} className="space-y-2">
									<div className="text-xs font-medium text-nova-text">
										{t.formName}
										<span className="text-nova-text-muted font-normal">
											{" "}
											· {t.moduleName}
										</span>
									</div>
									{mode === "learn" ? (
										<>
											<SubConfigCard
												title="Learn Module"
												enabled={draft.learnOn}
												onToggle={() =>
													patchDraft(t.formUuid, { learnOn: !draft.learnOn })
												}
											>
												<DraftField
													label="Name"
													value={draft.learnName}
													onChange={(v) =>
														patchDraft(t.formUuid, { learnName: v })
													}
												/>
												<DraftField
													label="Description"
													value={draft.learnDescription}
													onChange={(v) =>
														patchDraft(t.formUuid, { learnDescription: v })
													}
													multiline
												/>
												<DraftField
													label="Time Estimate"
													value={draft.learnTimeEstimate}
													onChange={(v) =>
														patchDraft(t.formUuid, { learnTimeEstimate: v })
													}
													suffix="min"
												/>
											</SubConfigCard>
											<SubConfigCard
												title="Assessment"
												enabled={draft.assessmentOn}
												onToggle={() =>
													patchDraft(t.formUuid, {
														assessmentOn: !draft.assessmentOn,
													})
												}
											>
												<DraftField
													label="User Score (optional)"
													value={draft.userScore}
													onChange={(v) =>
														patchDraft(t.formUuid, { userScore: v })
													}
												/>
											</SubConfigCard>
										</>
									) : (
										<>
											<SubConfigCard
												title="Deliver Unit"
												enabled={draft.deliverOn}
												onToggle={() =>
													patchDraft(t.formUuid, {
														deliverOn: !draft.deliverOn,
													})
												}
											>
												<DraftField
													label="Name"
													value={draft.deliverName}
													onChange={(v) =>
														patchDraft(t.formUuid, { deliverName: v })
													}
												/>
											</SubConfigCard>
											<SubConfigCard
												title="Task"
												enabled={draft.taskOn}
												onToggle={() =>
													patchDraft(t.formUuid, { taskOn: !draft.taskOn })
												}
											>
												<DraftField
													label="Name"
													value={draft.taskName}
													onChange={(v) =>
														patchDraft(t.formUuid, { taskName: v })
													}
												/>
												<DraftField
													label="Description"
													value={draft.taskDescription}
													onChange={(v) =>
														patchDraft(t.formUuid, { taskDescription: v })
													}
													multiline
												/>
											</SubConfigCard>
										</>
									)}
								</div>
							);
						})}
					</div>

					<div className="p-5 pt-3 space-y-2">
						{rejectionMessages.length > 0 && (
							<div className="text-[11px] text-nova-rose space-y-1">
								{rejectionMessages.map((m) => (
									<p key={m}>{m}</p>
								))}
							</div>
						)}
						<div className="flex items-center justify-between gap-2">
							<span className="text-[10px] text-nova-text-muted">
								{!sectionsComplete
									? "Finish the sections you've turned on."
									: participatingCount < 1
										? "Turn on a section for at least one form — a Connect app needs at least one participating form."
										: "Ready to enable."}
							</span>
							<div className="flex gap-2">
								<button
									type="button"
									onClick={onCancel}
									className="px-3 py-1.5 text-xs font-medium rounded-lg border border-nova-border text-nova-text-secondary hover:text-nova-text transition-colors cursor-pointer"
								>
									Cancel
								</button>
								<button
									type="button"
									onClick={confirm}
									disabled={!canConfirm}
									className="px-3 py-1.5 text-xs font-medium rounded-lg bg-nova-violet text-white transition-colors enabled:hover:brightness-110 enabled:cursor-pointer disabled:opacity-40"
								>
									Enable Connect
								</button>
							</div>
						</div>
					</div>
				</motion.div>
			</motion.div>
		</AnimatePresence>
	);
}
