"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerX from "@iconify-icons/tabler/x";
import { type ReactNode, useCallback, useId, useState } from "react";
import { LabeledXPathField } from "@/components/builder/detail/formSettings/LabeledXPathField";
import { useConnectLintContext } from "@/components/builder/detail/formSettings/useConnectLintContext";
import { RejectionBody } from "@/components/builder/RejectionNotice";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { Switch } from "@/components/shadcn/switch";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import {
	DEFAULT_ASSESSMENT_USER_SCORE,
	DEFAULT_DELIVER_ENTITY_ID,
	DEFAULT_DELIVER_ENTITY_NAME,
} from "@/lib/doc/connectConfig";
import { parseXPathForForm } from "@/lib/doc/expressionText";
import { useAppConnectIds } from "@/lib/doc/hooks/useAppConnectIds";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import type { ConnectConfig, ConnectType } from "@/lib/domain";
import { asUuid, CONNECT_TYPE_LABELS } from "@/lib/domain";
import { CurrentFormScope } from "@/lib/references/ReferenceContext";
import { useStopEscape } from "@/lib/ui/hooks/useStopEscape";
import { assertNever } from "@/lib/utils/assertNever";
import {
	assignDraftConnectIds,
	type BlockDraft,
	connectIdHelpers,
	draftIdsValid,
	draftParticipates,
	draftSectionsComplete,
	draftToConfig,
	EMPTY_DRAFT,
	type IdValidator,
	type SubConfigKind,
} from "./connectDraft";

export {
	assignDraftConnectIds,
	type BlockDraft,
	configToDraft,
	connectIdHelpers,
	DEFAULT_LEARN_TIME_ESTIMATE_HOURS,
	draftIdsValid,
	draftParticipates,
	draftSectionsComplete,
	draftToConfig,
	EMPTY_DRAFT,
	type IdValidator,
	parseTimeEstimate,
} from "./connectDraft";

/**
 * The per-form Connect enable dialog (form settings) plus the shared
 * building blocks the app-wide `ConnectManagerDialog` reuses. Enabling
 * Connect commits as ONE gated batch: `setConnectType` plus each
 * participating form's connect block, and the commit gate rejects a flip
 * that leaves the app with no participating form. Participation is per form:
 * a connect block opts the form INTO Connect; a form left without one stays
 * auxiliary and needs nothing. Nothing is pre-filled: a block's name and
 * description are content the user writes, not placeholders Nova invents.
 *
 * Per form, the user opts into the mode's sub-configs (learn: Learn module /
 * Assessment; deliver: Deliver unit / Task) and fills each enabled one's
 * fields. Every optional slot shows its REAL default as an editable value and
 * refills it on blur, so a slot is never left blank and the editor never has
 * to explain what blank means:
 *   - The XPath slots (`user_score`, `entity_id`, `entity_name`) use the real
 *     expression editor (`XPathField`: live lint, condition parsing, hashtag
 *     chips), seeded with their actual wire default; a blank commit snaps back
 *     to that default, and an unchanged default drops to absent at commit so
 *     the single wire-emit default applies.
 *   - The identifiers sit behind an "Advanced" disclosure, seeded when the
 *     sub-config turns on with the value the commit would derive (never a
 *     placeholder); clearing one and leaving the field snaps it back to that
 *     derived id on blur: the same blur-commit the XPath slots do.
 *
 * The dialog mounts through a portal (the media picker's pattern) so it
 * escapes the app-settings popover's transformed positioner.
 */

/** One form the dialog collects a block for. */
export interface ConnectStagingTarget {
	formUuid: string;
	formName: string;
	moduleName: string;
}

// ── Draft model ───────────────────────────────────────────────────────────

// ── Field + card primitives ───────────────────────────────────────────────

/** One polished, controlled field: the single input style for every
 *  Connect draft surface (this dialog, the manager, and the form-settings
 *  sub-toggles). Blur-commit lives in `InlineField`; this one is pure
 *  controlled state, validated live and committed by its owner on apply. */
export function DraftField({
	label,
	value,
	onChange,
	onBlur,
	validate,
	mono,
	multiline,
	suffix,
	placeholder,
	hint,
	required,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	/** Fired when the field loses focus: the commit moment for fields that
	 *  refill a default on blank (the id slots), mirroring the XPath editor's
	 *  blur-commit. */
	onBlur?: () => void;
	/** Reason the current value is invalid, or `null`. Rendered beneath the
	 *  field; also tints the border. */
	validate?: (value: string) => string | null;
	mono?: boolean;
	multiline?: boolean;
	suffix?: string;
	placeholder?: string;
	/** A short note under the field explaining what it's for. An error, when
	 *  present, takes its place. */
	hint?: string;
	required?: boolean;
}) {
	const fieldId = useId();
	const error = validate?.(value) ?? null;
	// Escape exits the FIELD (blur), never the surrounding dialog, see hook.
	const stopEscape = useStopEscape();

	// Tones match the form-settings `InlineField` exactly so the two share one
	// visual language (this is a controlled field; that one blur-commits).
	const base =
		"w-full text-xs rounded-md border px-2 py-1.5 outline-none transition-colors placeholder:text-nova-text-muted";
	const tone = error
		? "border-nova-rose/60 bg-nova-surface shadow-[0_0_0_1px_rgba(212,112,143,0.15)]"
		: "border-white/[0.06] bg-nova-deep/50 hover:border-nova-violet/30 focus:border-nova-violet/50 focus:bg-nova-surface focus:shadow-[0_0_0_1px_rgba(150,120,242,0.1)]";
	const text = mono ? "font-mono text-nova-violet-bright" : "text-nova-text";
	return (
		<div>
			<label
				htmlFor={fieldId}
				className="mb-0.5 flex items-center gap-0.5 text-xs text-nova-text-muted"
			>
				{label}
				{required && <span className="text-nova-rose">*</span>}
			</label>
			<div className="relative">
				{multiline ? (
					<textarea
						id={fieldId}
						ref={stopEscape}
						className={`${base} ${tone} ${text} resize-none`}
						rows={2}
						value={value}
						onChange={(e) => onChange(e.target.value)}
						onBlur={onBlur}
						placeholder={placeholder}
						autoComplete="off"
						data-1p-ignore
					/>
				) : (
					<input
						id={fieldId}
						ref={stopEscape}
						type="text"
						className={`${base} ${tone} ${text}${suffix ? " pr-9" : ""}`}
						value={value}
						onChange={(e) => onChange(e.target.value)}
						onBlur={onBlur}
						placeholder={placeholder}
						autoComplete="off"
						data-1p-ignore
					/>
				)}
				{suffix && (
					<span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-nova-text-muted">
						{suffix}
					</span>
				)}
			</div>
			{error ? (
				<p className="mt-1 text-[10px] text-nova-rose">{error}</p>
			) : hint ? (
				<p className="mt-1 text-[10px] leading-snug text-nova-text-muted">
					{hint}
				</p>
			) : null}
		</div>
	);
}

/** A collapsible "Advanced" section: holds the rarely-touched id + XPath
 *  fields so a sub-config card opens to just its essentials. */
function AdvancedDisclosure({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="pt-0.5">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="flex cursor-pointer items-center gap-1 text-xs text-nova-text-muted transition-colors hover:text-nova-text-secondary"
			>
				<Icon
					icon={tablerChevronRight}
					className={`size-3 transition-transform ${open ? "rotate-90" : ""}`}
				/>
				Advanced
			</button>
			{open && <div className="mt-2 space-y-2.5">{children}</div>}
		</div>
	);
}

/** One sub-config card: an opt-in toggle revealing its fields. */
function SubConfigCard({
	title,
	checked,
	onCheckedChange,
	children,
}: {
	title: string;
	checked: boolean;
	onCheckedChange: () => void;
	children?: ReactNode;
}) {
	return (
		<div className="rounded-lg border border-white/[0.06] bg-white/[0.02]">
			<div className="flex items-center justify-between px-3 py-2.5">
				<span className="text-xs font-medium text-nova-text-secondary">
					{title}
				</span>
				<Switch checked={checked} onCheckedChange={onCheckedChange} />
			</div>
			{checked && children && (
				<div className="space-y-2.5 border-t border-white/[0.06] px-3 pb-3 pt-2.5">
					{children}
				</div>
			)}
		</div>
	);
}

/** A Connect XPath slot, rendered with the real expression editor, live
 *  validation, condition parsing, and hashtag/chip autocomplete (the same
 *  CodeMirror field the rest of the builder uses). The buffer starts at the
 *  wire default so the user sees exactly what runs and can replace it; the
 *  editor commits on blur, and a blank commit snaps back to `defaultText`
 *  rather than persisting empty: the slot is never left blank, the same
 *  reset the id fields do (and either way an unchanged default drops to absent
 *  at commit, so the single wire-emit default applies). */
function ConnectXPathField({
	label,
	value,
	defaultText,
	onChange,
	getLintContext,
}: {
	label: string;
	value: string;
	defaultText: string;
	onChange: (value: string) => void;
	getLintContext: () => XPathLintContext | undefined;
}) {
	return (
		<LabeledXPathField
			label={label}
			value={value}
			onSave={(v) => {
				onChange(v.trim() ? v : defaultText);
				return undefined;
			}}
			getLintContext={getLintContext}
		/>
	);
}

/** The learn / deliver sub-config pair for one form's draft, the single
 *  per-form editor, shared by the dialog and the manager. `validateId`
 *  surfaces an explicit id's format / uniqueness reason inline; the XPath
 *  slots use the real editor scoped to `formUuid` for chips + lint. */
export function FormSubConfigs({
	mode,
	draft,
	onPatch,
	validateId,
	derivedId,
	formUuid,
}: {
	mode: ConnectType;
	draft: BlockDraft;
	onPatch: (patch: Partial<BlockDraft>) => void;
	validateId: IdValidator;
	/** The id a blank slot would autofill to, scoped by the parent (the
	 *  manager's in-flight drafts, or the per-form dialog's live doc). Used to
	 *  seed an id field on turn-on and to refill it on a blank blur, never a
	 *  placeholder; what's shown is what the commit will store. */
	derivedId: (kind: SubConfigKind) => string;
	formUuid: string;
}) {
	const idCheck = (kind: SubConfigKind) => (value: string) =>
		value === "" ? null : validateId(kind, value);
	const getLintContext = useConnectLintContext(asUuid(formUuid));

	// Flip a sub-config. Turning it ON seeds the derived id into a still-blank
	// buffer so its "Advanced → ID" field opens showing the real value; an id
	// the draft already carries (an existing block, a restored stash) is left
	// untouched so no Postgres slug churns. Turning OFF preserves the buffers
	// (the same round-trip the names/descriptions get).
	const toggleSub = (kind: SubConfigKind) => {
		switch (kind) {
			case "learn_module":
				return onPatch(
					draft.learnOn
						? { learnOn: false }
						: {
								learnOn: true,
								...(draft.learnId
									? {}
									: { learnId: derivedId("learn_module") }),
							},
				);
			case "assessment":
				return onPatch(
					draft.assessmentOn
						? { assessmentOn: false }
						: {
								assessmentOn: true,
								...(draft.assessmentId
									? {}
									: { assessmentId: derivedId("assessment") }),
							},
				);
			case "deliver_unit":
				return onPatch(
					draft.deliverOn
						? { deliverOn: false }
						: {
								deliverOn: true,
								...(draft.deliverId
									? {}
									: { deliverId: derivedId("deliver_unit") }),
							},
				);
			case "task":
				return onPatch(
					draft.taskOn
						? { taskOn: false }
						: {
								taskOn: true,
								...(draft.taskId ? {} : { taskId: derivedId("task") }),
							},
				);
			default:
				return assertNever(kind);
		}
	};

	// Blur-commit for an id field: a blank buffer snaps back to the derived
	// default so the slot is never left empty (the user who wants the auto id
	// just clears it and leaves; one who wants their own types it). The commit
	// path autofills a blank id regardless: this only keeps the field honest.
	const blurResetId = (kind: SubConfigKind) => () => {
		switch (kind) {
			case "learn_module":
				if (!draft.learnId) onPatch({ learnId: derivedId(kind) });
				return;
			case "assessment":
				if (!draft.assessmentId) onPatch({ assessmentId: derivedId(kind) });
				return;
			case "deliver_unit":
				if (!draft.deliverId) onPatch({ deliverId: derivedId(kind) });
				return;
			case "task":
				if (!draft.taskId) onPatch({ taskId: derivedId(kind) });
				return;
			default:
				return assertNever(kind);
		}
	};

	const body =
		mode === "learn" ? (
			<>
				<SubConfigCard
					title="Learn Module"
					checked={draft.learnOn}
					onCheckedChange={() => toggleSub("learn_module")}
				>
					<DraftField
						label="Name"
						value={draft.learnName}
						onChange={(v) => onPatch({ learnName: v })}
						required
					/>
					<DraftField
						label="Description"
						value={draft.learnDescription}
						onChange={(v) => onPatch({ learnDescription: v })}
						multiline
						required
					/>
					<DraftField
						label="Time estimate (hours)"
						value={draft.learnTimeEstimate}
						onChange={(v) => onPatch({ learnTimeEstimate: v })}
						suffix="hr"
						required
					/>
					<AdvancedDisclosure>
						<DraftField
							label="Module ID"
							value={draft.learnId}
							onChange={(v) => onPatch({ learnId: v })}
							onBlur={blurResetId("learn_module")}
							validate={idCheck("learn_module")}
							mono
						/>
					</AdvancedDisclosure>
				</SubConfigCard>
				<SubConfigCard
					title="Assessment"
					checked={draft.assessmentOn}
					onCheckedChange={() => toggleSub("assessment")}
				>
					<ConnectXPathField
						label="User score"
						value={draft.userScoreText}
						defaultText={DEFAULT_ASSESSMENT_USER_SCORE}
						onChange={(v) => onPatch({ userScoreText: v })}
						getLintContext={getLintContext}
					/>
					<AdvancedDisclosure>
						<DraftField
							label="Assessment ID"
							value={draft.assessmentId}
							onChange={(v) => onPatch({ assessmentId: v })}
							onBlur={blurResetId("assessment")}
							validate={idCheck("assessment")}
							mono
						/>
					</AdvancedDisclosure>
				</SubConfigCard>
			</>
		) : (
			<>
				<SubConfigCard
					title="Deliver Unit"
					checked={draft.deliverOn}
					onCheckedChange={() => toggleSub("deliver_unit")}
				>
					<DraftField
						label="Name"
						value={draft.deliverName}
						onChange={(v) => onPatch({ deliverName: v })}
						required
					/>
					<ConnectXPathField
						label="Entity ID"
						value={draft.entityIdText}
						defaultText={DEFAULT_DELIVER_ENTITY_ID}
						onChange={(v) => onPatch({ entityIdText: v })}
						getLintContext={getLintContext}
					/>
					<ConnectXPathField
						label="Entity name"
						value={draft.entityNameText}
						defaultText={DEFAULT_DELIVER_ENTITY_NAME}
						onChange={(v) => onPatch({ entityNameText: v })}
						getLintContext={getLintContext}
					/>
					<AdvancedDisclosure>
						<DraftField
							label="Deliver Unit ID"
							value={draft.deliverId}
							onChange={(v) => onPatch({ deliverId: v })}
							onBlur={blurResetId("deliver_unit")}
							validate={idCheck("deliver_unit")}
							mono
						/>
					</AdvancedDisclosure>
				</SubConfigCard>
				<SubConfigCard
					title="Task"
					checked={draft.taskOn}
					onCheckedChange={() => toggleSub("task")}
				>
					<DraftField
						label="Name"
						value={draft.taskName}
						onChange={(v) => onPatch({ taskName: v })}
						required
					/>
					<DraftField
						label="Description"
						value={draft.taskDescription}
						onChange={(v) => onPatch({ taskDescription: v })}
						multiline
						required
					/>
					<AdvancedDisclosure>
						<DraftField
							label="Task ID"
							value={draft.taskId}
							onChange={(v) => onPatch({ taskId: v })}
							onBlur={blurResetId("task")}
							validate={idCheck("task")}
							mono
						/>
					</AdvancedDisclosure>
				</SubConfigCard>
			</>
		);

	/* Scope the XPath editors to THIS form so chip resolution + lint read the
	 * right form, even though the manager edits several at once. */
	return <CurrentFormScope formUuid={formUuid}>{body}</CurrentFormScope>;
}

/** Shared footer rejection block: the gate's findings, rendered inline so
 *  a bounce explains itself without relying on the toast. */
export function RejectionNoticeBlock({
	messages,
}: {
	messages: readonly string[];
}) {
	if (messages.length === 0) return null;
	return (
		<div className="space-y-2 rounded-md border border-nova-rose/15 bg-nova-rose/[0.06] px-2.5 py-2">
			{messages.map((m) => (
				<RejectionBody key={m} message={m} label={null} />
			))}
		</div>
	);
}

// ── The per-form enable dialog (form settings) ─────────────────────────────

/** The request the dialog renders; `undefined` closes it. */
export interface ConnectEnableRequest {
	mode: ConnectType;
	targets: readonly ConnectStagingTarget[];
	restoredFormCount: number;
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
	// Stays mounted across open/close so Base UI plays BOTH transitions; the
	// stateful body mounts only while open, so its per-form drafts reset.
	return (
		<Dialog
			open={request !== undefined}
			onOpenChange={(next) => {
				if (!next) onCancel();
			}}
		>
			<DialogContent
				showCloseButton={false}
				className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-lg"
			>
				{request && (
					<ConnectEnableBody
						request={request}
						onCancel={onCancel}
						onConfirm={onConfirm}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function ConnectEnableBody({
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
		Object.fromEntries(targets.map((t) => [t.formUuid, { ...EMPTY_DRAFT }])),
	);
	// One exact id scope for the dialog: committed ids outside the target set
	// plus every in-flight target draft. The shared projection reserves all
	// explicit/live identities before deriving one empty draft, so the inline
	// guard and final app-wide planner admit the same set.
	const appConnectIds = useAppConnectIds();
	const targetFormUuids = new Set(targets.map(({ formUuid }) => formUuid));
	const committedIdsOutsideTargets = appConnectIds.filter(
		({ formUuid }) => !targetFormUuids.has(formUuid),
	);
	const assignedIds = assignDraftConnectIds(
		targets,
		drafts,
		mode,
		committedIdsOutsideTargets,
	);
	const idHelpers: Record<string, ReturnType<typeof connectIdHelpers>> = {};
	for (const t of targets) {
		idHelpers[t.formUuid] = connectIdHelpers(
			assignedIds,
			t.formUuid,
			t.moduleName,
			t.formName,
		);
	}

	const patchDraft = useCallback(
		(formUuid: string, patch: Partial<BlockDraft>) => {
			setDrafts((prev) => ({
				...prev,
				[formUuid]: { ...(prev[formUuid] ?? EMPTY_DRAFT), ...patch },
			}));
		},
		[],
	);

	const draftOf = (formUuid: string) => drafts[formUuid] ?? EMPTY_DRAFT;
	const sectionsComplete = targets.every((t) =>
		draftSectionsComplete(draftOf(t.formUuid), mode),
	);
	const idsValid = targets.every((t) =>
		draftIdsValid(draftOf(t.formUuid), mode, idHelpers[t.formUuid].validateId),
	);
	const participatingCount =
		restoredFormCount +
		targets.filter((t) => draftParticipates(draftOf(t.formUuid), mode)).length;
	const canConfirm = sectionsComplete && idsValid && participatingCount >= 1;

	const docApi = useBlueprintDocApi();
	const confirm = () => {
		const doc = docApi.getState();
		onConfirm(
			Object.fromEntries(
				targets
					.filter((t) => draftParticipates(draftOf(t.formUuid), mode))
					.map((t) => [
						t.formUuid,
						draftToConfig(
							draftOf(t.formUuid),
							mode,
							(text) => parseXPathForForm(doc, asUuid(t.formUuid), text),
							idHelpers[t.formUuid].derivedId,
						),
					]),
			),
		);
	};

	const single = targets.length === 1 && restoredFormCount === 0;
	const hint = !sectionsComplete
		? "Finish the sections you've turned on."
		: !idsValid
			? "Fix the highlighted ID."
			: participatingCount < 1
				? single
					? "Turn on a section to add this form to Connect."
					: "Turn on a section for at least one form."
				: "Ready to enable.";

	return (
		<>
			<header className="flex items-center justify-between border-b border-nova-border px-5 py-3.5">
				<div className="flex items-center gap-2">
					<DialogTitle className="font-display tracking-tighter">
						Set up Connect
					</DialogTitle>
					<span className="flex h-[18px] items-center rounded-full border border-nova-violet/20 bg-nova-violet/10 px-1.5 text-[10px] font-medium text-nova-violet-bright">
						{CONNECT_TYPE_LABELS[mode]}
					</span>
				</div>
				<DialogClose
					render={<Button variant="ghost" size="icon" />}
					aria-label="Close"
				>
					<Icon icon={tablerX} className="size-4" />
				</DialogClose>
			</header>

			<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
				<div className="space-y-1.5">
					<p className="text-xs leading-relaxed text-nova-text-secondary">
						{single
							? "Turn on a section below and fill it in to add this form to Connect."
							: "Pick which forms take part in Connect by turning on their sections and filling them in. Forms you leave off stay out, you can add them later from each form's settings."}
					</p>
					{restoredFormCount > 0 && (
						<p className="text-[11px] text-nova-text-muted">
							{restoredFormCount === 1
								? "1 form you set up earlier will rejoin Connect automatically."
								: `${restoredFormCount} forms you set up earlier will rejoin Connect automatically.`}
						</p>
					)}
				</div>

				{targets.map((t) => (
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
							draft={draftOf(t.formUuid)}
							onPatch={(patch) => patchDraft(t.formUuid, patch)}
							validateId={idHelpers[t.formUuid].validateId}
							derivedId={idHelpers[t.formUuid].derivedId}
							formUuid={t.formUuid}
						/>
					</div>
				))}
			</div>

			<div className="space-y-2 border-t border-nova-border px-5 py-3">
				<RejectionNoticeBlock messages={rejectionMessages} />
				<div className="flex items-center justify-between gap-3">
					<span className="text-[11px] text-nova-text-muted">{hint}</span>
					<div className="flex gap-2">
						<Button type="button" variant="outline" onClick={onCancel}>
							Cancel
						</Button>
						<Button type="button" onClick={confirm} disabled={!canConfirm}>
							Enable Connect
						</Button>
					</div>
				</div>
			</div>
		</>
	);
}
