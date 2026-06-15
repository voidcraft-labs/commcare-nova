"use client";
import { Dialog } from "@base-ui/react/dialog";
import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import { useCallback, useId, useState } from "react";
import { RejectionBody } from "@/components/builder/RejectionNotice";
import { Toggle } from "@/components/ui/Toggle";
import { parseXPathForForm } from "@/lib/doc/expressionText";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import type { ConnectConfig, ConnectType, XPathExpression } from "@/lib/domain";
import { asUuid } from "@/lib/domain";

/**
 * The staging step of the Connect enable flows, rendered as a real
 * centered modal. Enabling Connect (or switching its mode) commits as ONE
 * batch — `setConnectType` plus each participating form's connect block —
 * and the commit gate rejects a flip that leaves the app with no
 * participating form. Participation is per form: a connect block opts the
 * form INTO Connect; a form left without one stays auxiliary and needs
 * nothing. Forms whose block the session stash already holds restore
 * silently (they participate without appearing here); this dialog
 * collects the rest FROM THE USER before anything commits. Nothing is
 * pre-filled: a Connect block's name and description are content the user
 * writes, not placeholders Nova invents.
 *
 * Per form, the user opts into the mode's sub-configs (learn: Learn
 * module / Assessment; deliver: Deliver unit / Task) and fills each
 * enabled one's fields. Turning on a sub-config is what picks the form as
 * participating; a form with none enabled is simply left out of the
 * commit. The confirm button stays disabled until every enabled
 * sub-config is complete AND at least one form participates (counting the
 * stash-restored ones via `restoredFormCount`) — the same bar the commit
 * gate holds, surfaced before the commit instead of as a bounce. Connect
 * ids are not collected here: the commit path autofills valid, app-unique
 * ids the same way agent-side creation does.
 *
 * The dialog mounts through `Dialog.Portal` (the media picker's pattern)
 * so it escapes the app-settings popover's transformed positioner — the
 * reason a hand-rolled `position: fixed` here rendered against the popover
 * instead of the viewport.
 */

const BACKDROP_CLS =
	"fixed inset-0 z-modal bg-black/60 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0";
const POPUP_CLS =
	"fixed z-modal top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl bg-nova-deep border border-nova-border shadow-xl outline-none transition-[transform,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";

/** One form the stash doesn't cover — the dialog collects its block. */
export interface ConnectStagingTarget {
	formUuid: string;
	formName: string;
	moduleName: string;
}

/** Local draft of one form's block — strings as typed, opt-ins explicit.
 *
 *  The editable fields drive the cards. The optional `preserved*` fields
 *  ride alongside untouched: existing sub-config ids and the advanced XPath
 *  slots (`user_score`, `entity_id`/`entity_name`) the cards don't expose.
 *  They are absent for a fresh draft (the per-form enable dialog seeds
 *  `EMPTY_DRAFT`) and set by `configToDraft` when the manager seeds an
 *  existing block, so `draftToConfig` re-emits them rather than dropping
 *  them or re-deriving an id (which would churn Connect's slug). */
export interface BlockDraft {
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
	// Preserved (round-tripped, not edited here).
	learnId?: string;
	assessmentId?: string;
	userScoreExpr?: XPathExpression;
	deliverId?: string;
	entityIdExpr?: XPathExpression;
	entityNameExpr?: XPathExpression;
	taskId?: string;
}

export const EMPTY_DRAFT: BlockDraft = {
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

/** Seed a draft from an existing `ConnectConfig` (the manager's per-form
 *  starting point). Mode-agnostic — a config only carries one mode's
 *  sub-configs, and the unused fields default empty. Captures the editable
 *  strings plus the preserved ids / advanced XPath slots so a later
 *  `draftToConfig` reproduces the block losslessly. */
export function configToDraft(config: ConnectConfig): BlockDraft {
	const lm = config.learn_module;
	const assessment = config.assessment;
	const du = config.deliver_unit;
	const task = config.task;
	return {
		learnOn: !!lm,
		learnName: lm?.name ?? "",
		learnDescription: lm?.description ?? "",
		learnTimeEstimate: lm ? String(lm.time_estimate) : "",
		learnId: lm?.id,
		assessmentOn: !!assessment,
		userScore: "",
		assessmentId: assessment?.id,
		userScoreExpr: assessment?.user_score,
		deliverOn: !!du,
		deliverName: du?.name ?? "",
		deliverId: du?.id,
		entityIdExpr: du?.entity_id,
		entityNameExpr: du?.entity_name,
		taskOn: !!task,
		taskName: task?.name ?? "",
		taskDescription: task?.description ?? "",
		taskId: task?.id,
	};
}

/** Parse the time-estimate draft: a positive integer (minutes) or null. */
export function parseTimeEstimate(raw: string): number | null {
	const n = Number(raw.trim());
	return Number.isInteger(n) && n >= 1 ? n : null;
}

/** Whether one draft PARTICIPATES: at least one sub-config is enabled.
 *  A draft with none stays auxiliary and is left out of the commit. */
export function draftParticipates(
	draft: BlockDraft,
	mode: ConnectType,
): boolean {
	return mode === "learn"
		? draft.learnOn || draft.assessmentOn
		: draft.deliverOn || draft.taskOn;
}

/** Whether every ENABLED sub-config in one draft is complete. An enabled
 *  assessment is always complete — its `user_score` is optional content
 *  (the wire layer substitutes the canonical default when unset). A draft
 *  with nothing enabled is trivially complete (it participates in
 *  nothing). */
export function draftSectionsComplete(
	draft: BlockDraft,
	mode: ConnectType,
): boolean {
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
 *  A fresh draft carries no ids — the commit path autofills them; an
 *  edited existing block re-emits its preserved ids + advanced XPath slots
 *  so nothing is dropped or re-slugged. A blank user_score (and the
 *  entity XPaths) stay omitted so the wire-emit default applies (writing
 *  `""` would trip the `CONNECT_EMPTY_XPATH` validator). */
export function draftToConfig(
	draft: BlockDraft,
	mode: ConnectType,
	parseExpr: (text: string) => XPathExpression,
): ConnectConfig {
	if (mode === "learn") {
		return {
			...(draft.learnOn && {
				learn_module: {
					...(draft.learnId && { id: draft.learnId }),
					name: draft.learnName.trim(),
					description: draft.learnDescription.trim(),
					time_estimate: parseTimeEstimate(draft.learnTimeEstimate) ?? 1,
				},
			}),
			...(draft.assessmentOn && {
				assessment: {
					...(draft.assessmentId && { id: draft.assessmentId }),
					// A freshly typed score wins; otherwise round-trip the
					// preserved expression; otherwise leave it to the wire default.
					...(draft.userScore.trim()
						? { user_score: parseExpr(draft.userScore.trim()) }
						: draft.userScoreExpr
							? { user_score: draft.userScoreExpr }
							: {}),
				},
			}),
		};
	}
	return {
		...(draft.deliverOn && {
			deliver_unit: {
				...(draft.deliverId && { id: draft.deliverId }),
				name: draft.deliverName.trim(),
				...(draft.entityIdExpr && { entity_id: draft.entityIdExpr }),
				...(draft.entityNameExpr && { entity_name: draft.entityNameExpr }),
			},
		}),
		...(draft.taskOn && {
			task: {
				...(draft.taskId && { id: draft.taskId }),
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
		<div className="rounded-lg bg-white/[0.03] border border-white/[0.06] px-3 py-2.5">
			<div className="flex items-center justify-between">
				<span className="text-[11px] font-medium text-nova-text-secondary uppercase tracking-wider">
					{title}
				</span>
				<Toggle enabled={enabled} onToggle={onToggle} variant="sub" />
			</div>
			{enabled && children && (
				<div className="space-y-2 pt-2.5 mt-2.5 border-t border-white/[0.06]">
					{children}
				</div>
			)}
		</div>
	);
}

/** The learn / deliver sub-config pair for one form's draft. */
export function FormSubConfigs({
	mode,
	draft,
	onPatch,
}: {
	mode: ConnectType;
	draft: BlockDraft;
	onPatch: (patch: Partial<BlockDraft>) => void;
}) {
	if (mode === "learn") {
		return (
			<>
				<SubConfigCard
					title="Learn Module"
					enabled={draft.learnOn}
					onToggle={() => onPatch({ learnOn: !draft.learnOn })}
				>
					<DraftField
						label="Name"
						value={draft.learnName}
						onChange={(v) => onPatch({ learnName: v })}
					/>
					<DraftField
						label="Description"
						value={draft.learnDescription}
						onChange={(v) => onPatch({ learnDescription: v })}
						multiline
					/>
					<DraftField
						label="Time Estimate"
						value={draft.learnTimeEstimate}
						onChange={(v) => onPatch({ learnTimeEstimate: v })}
						suffix="min"
					/>
				</SubConfigCard>
				<SubConfigCard
					title="Assessment"
					enabled={draft.assessmentOn}
					onToggle={() => onPatch({ assessmentOn: !draft.assessmentOn })}
				>
					<DraftField
						label="User Score (optional)"
						value={draft.userScore}
						onChange={(v) => onPatch({ userScore: v })}
					/>
				</SubConfigCard>
			</>
		);
	}
	return (
		<>
			<SubConfigCard
				title="Deliver Unit"
				enabled={draft.deliverOn}
				onToggle={() => onPatch({ deliverOn: !draft.deliverOn })}
			>
				<DraftField
					label="Name"
					value={draft.deliverName}
					onChange={(v) => onPatch({ deliverName: v })}
				/>
			</SubConfigCard>
			<SubConfigCard
				title="Task"
				enabled={draft.taskOn}
				onToggle={() => onPatch({ taskOn: !draft.taskOn })}
			>
				<DraftField
					label="Name"
					value={draft.taskName}
					onChange={(v) => onPatch({ taskName: v })}
				/>
				<DraftField
					label="Description"
					value={draft.taskDescription}
					onChange={(v) => onPatch({ taskDescription: v })}
					multiline
				/>
			</SubConfigCard>
		</>
	);
}

/** The staging request the dialog renders; `undefined` closes it. Mirrors
 *  `AppConnectSection`'s `StagingState`, so that state passes straight
 *  through as the request. */
export interface ConnectEnableRequest {
	mode: ConnectType;
	/** Forms whose block restores silently from the session stash — they
	 *  participate without appearing in this dialog, so they count toward
	 *  the at-least-one-participating-form bar the confirm enforces. */
	targets: readonly ConnectStagingTarget[];
	restoredFormCount: number;
	/** Findings from a confirm attempt the commit gate bounced — shown
	 *  inline so the dialog explains itself without relying on the toast. */
	rejectionMessages: readonly string[];
}

export function ConnectEnableDialog({
	request,
	onCancel,
	onConfirm,
}: {
	request: ConnectEnableRequest | undefined;
	onCancel: () => void;
	onConfirm: (blocks: Record<string, ConnectConfig>) => void;
}) {
	// Stays mounted across open/close so Base UI plays BOTH transitions
	// (`data-[starting-style]` on open, `data-[ending-style]` on close) —
	// the media picker's pattern. The stateful body mounts only while the
	// Popup is open, so its per-form drafts reset on every open.
	return (
		<Dialog.Root
			open={request !== undefined}
			onOpenChange={(next) => {
				if (!next) onCancel();
			}}
		>
			<Dialog.Portal>
				<Dialog.Backdrop className={BACKDROP_CLS} />
				<Dialog.Popup className={POPUP_CLS}>
					{request && (
						<DialogBody
							request={request}
							onCancel={onCancel}
							onConfirm={onConfirm}
						/>
					)}
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

/** The dialog's content — a child of `Dialog.Popup`, so Base UI mounts it
 *  only while open and the per-form drafts start fresh each time. */
function DialogBody({
	request,
	onCancel,
	onConfirm,
}: {
	request: ConnectEnableRequest;
	onCancel: () => void;
	onConfirm: (blocks: Record<string, ConnectConfig>) => void;
}) {
	const { mode, targets, restoredFormCount, rejectionMessages } = request;
	const [drafts, setDrafts] = useState<Record<string, BlockDraft>>(() =>
		Object.fromEntries(targets.map((t) => [t.formUuid, EMPTY_DRAFT])),
	);

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

	const single = targets.length === 1 && restoredFormCount === 0;
	const hint = !sectionsComplete
		? "Finish the sections you've turned on."
		: participatingCount < 1
			? single
				? "Turn on a section to add this form to Connect."
				: "Turn on a section for at least one form."
			: "Ready to enable.";

	return (
		<>
			<header className="flex items-center justify-between border-b border-nova-border px-5 py-3.5">
				<div className="flex items-center gap-2">
					<Dialog.Title className="text-base font-display font-semibold text-nova-text">
						Set up Connect
					</Dialog.Title>
					<span className="flex h-[18px] items-center rounded border border-nova-violet/20 bg-nova-violet/10 px-1.5 text-[10px] font-medium text-nova-violet-bright">
						{mode === "learn" ? "Learn" : "Deliver"}
					</span>
				</div>
				<Dialog.Close
					className="rounded-md p-1 text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text focus-visible:outline-1 focus-visible:outline-nova-violet-bright"
					aria-label="Close"
				>
					<Icon icon={tablerX} className="size-4" />
				</Dialog.Close>
			</header>

			<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
				<div className="space-y-1.5">
					<p className="text-xs leading-relaxed text-nova-text-secondary">
						{single
							? "Turn on a section below and fill it in to add this form to Connect."
							: "Pick which forms take part in Connect by turning on their sections and filling them in. Forms you leave off stay out — you can add them later from each form's settings."}
					</p>
					{restoredFormCount > 0 && (
						<p className="text-[11px] text-nova-text-muted">
							{restoredFormCount === 1
								? "1 form you set up earlier will rejoin Connect automatically."
								: `${restoredFormCount} forms you set up earlier will rejoin Connect automatically.`}
						</p>
					)}
				</div>

				{targets.map((t) => {
					const draft = drafts[t.formUuid] ?? EMPTY_DRAFT;
					return (
						<div key={t.formUuid} className="space-y-2">
							<div className="text-xs font-medium text-nova-text">
								{t.formName}
								<span className="font-normal text-nova-text-muted">
									{" "}
									· {t.moduleName}
								</span>
							</div>
							<FormSubConfigs
								mode={mode}
								draft={draft}
								onPatch={(patch) => patchDraft(t.formUuid, patch)}
							/>
						</div>
					);
				})}
			</div>

			<div className="space-y-2 border-t border-nova-border px-5 py-3">
				{rejectionMessages.length > 0 && (
					/* The gate refused the confirm — the drafts above are intact;
					 * each finding reads in the shared rejection anatomy. */
					<div className="space-y-2 rounded-md border border-nova-rose/15 bg-nova-rose/[0.06] px-2.5 py-2">
						{rejectionMessages.map((m) => (
							<RejectionBody key={m} message={m} label={null} />
						))}
					</div>
				)}
				<div className="flex items-center justify-between gap-3">
					<span className="text-[11px] text-nova-text-muted">{hint}</span>
					<div className="flex gap-2">
						<button
							type="button"
							onClick={onCancel}
							className="cursor-pointer rounded-lg border border-nova-border px-3 py-1.5 text-xs font-medium text-nova-text-secondary transition-colors hover:text-nova-text"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={confirm}
							disabled={!canConfirm}
							className="rounded-lg bg-nova-violet px-3 py-1.5 text-xs font-medium text-white transition-colors enabled:cursor-pointer enabled:hover:brightness-110 disabled:opacity-40"
						>
							Enable Connect
						</button>
					</div>
				</div>
			</div>
		</>
	);
}
