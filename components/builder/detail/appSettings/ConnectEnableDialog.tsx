"use client";
import { Dialog } from "@base-ui/react/dialog";
import { Icon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerX from "@iconify-icons/tabler/x";
import { type ReactNode, useCallback, useId, useState } from "react";
import { RejectionBody } from "@/components/builder/RejectionNotice";
import { Toggle } from "@/components/ui/Toggle";
import { connectIdValidity } from "@/lib/doc/connectConfig";
import { parseXPathForForm } from "@/lib/doc/expressionText";
import {
	connectIdsExcept,
	useAppConnectIds,
} from "@/lib/doc/hooks/useAppConnectIds";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import type { ConnectConfig, ConnectType, XPathExpression } from "@/lib/domain";
import { asUuid } from "@/lib/domain";

/**
 * The per-form Connect enable dialog (form settings) plus the shared
 * building blocks the app-wide `ConnectManagerDialog` reuses. Enabling
 * Connect commits as ONE gated batch — `setConnectType` plus each
 * participating form's connect block — and the commit gate rejects a flip
 * that leaves the app with no participating form. Participation is per form:
 * a connect block opts the form INTO Connect; a form left without one stays
 * auxiliary and needs nothing. Nothing is pre-filled: a block's name and
 * description are content the user writes, not placeholders Nova invents.
 *
 * Per form, the user opts into the mode's sub-configs (learn: Learn module /
 * Assessment; deliver: Deliver unit / Task) and fills each enabled one's
 * fields. Identifiers and the advanced XPath slots live behind an "Advanced"
 * disclosure — ids autofill when left blank, the XPaths fall back to their
 * wire defaults — so the common case stays a name and a description.
 *
 * The dialog mounts through `Dialog.Portal` (the media picker's pattern) so
 * it escapes the app-settings popover's transformed positioner.
 */

const BACKDROP_CLS =
	"fixed inset-0 z-modal bg-black/60 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0";
const POPUP_CLS =
	"fixed z-modal top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl bg-nova-deep border border-nova-border shadow-xl outline-none transition-[transform,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";

/** One form the dialog collects a block for. */
export interface ConnectStagingTarget {
	formUuid: string;
	formName: string;
	moduleName: string;
}

// ── Draft model ───────────────────────────────────────────────────────────

/** One form's editable block. Every field is a string buffer (typed as-is,
 *  parsed on commit) so the same draft drives both the per-form dialog and
 *  the app-wide manager. Ids autofill when blank; the XPath buffers fall
 *  back to their wire defaults when blank. The kind of each sub-config is
 *  carried by its `*On` flag, not by which fields are filled. */
export interface BlockDraft {
	learnOn: boolean;
	learnName: string;
	learnDescription: string;
	learnTimeEstimate: string;
	learnId: string;
	assessmentOn: boolean;
	assessmentId: string;
	userScoreText: string;
	deliverOn: boolean;
	deliverName: string;
	deliverId: string;
	entityIdText: string;
	entityNameText: string;
	taskOn: boolean;
	taskName: string;
	taskDescription: string;
	taskId: string;
}

export const EMPTY_DRAFT: BlockDraft = {
	learnOn: false,
	learnName: "",
	learnDescription: "",
	learnTimeEstimate: "",
	learnId: "",
	assessmentOn: false,
	assessmentId: "",
	userScoreText: "",
	deliverOn: false,
	deliverName: "",
	deliverId: "",
	entityIdText: "",
	entityNameText: "",
	taskOn: false,
	taskName: "",
	taskDescription: "",
	taskId: "",
};

/** Which sub-configs of a mode the draft has turned on. */
type SubConfigKind = "learn_module" | "assessment" | "deliver_unit" | "task";

/** Seed a draft from an existing block (the manager's per-form starting
 *  point). `printExpr` lowers a stored XPath AST to its text so the buffers
 *  show what's there — required so an existing `user_score` / entity
 *  expression isn't silently dropped on the next commit. */
export function configToDraft(
	config: ConnectConfig,
	printExpr: (expr: XPathExpression) => string,
): BlockDraft {
	const lm = config.learn_module;
	const assessment = config.assessment;
	const du = config.deliver_unit;
	const task = config.task;
	return {
		learnOn: !!lm,
		learnName: lm?.name ?? "",
		learnDescription: lm?.description ?? "",
		learnTimeEstimate: lm ? String(lm.time_estimate) : "",
		learnId: lm?.id ?? "",
		assessmentOn: !!assessment,
		assessmentId: assessment?.id ?? "",
		userScoreText: assessment?.user_score
			? printExpr(assessment.user_score)
			: "",
		deliverOn: !!du,
		deliverName: du?.name ?? "",
		deliverId: du?.id ?? "",
		entityIdText: du?.entity_id ? printExpr(du.entity_id) : "",
		entityNameText: du?.entity_name ? printExpr(du.entity_name) : "",
		taskOn: !!task,
		taskName: task?.name ?? "",
		taskDescription: task?.description ?? "",
		taskId: task?.id ?? "",
	};
}

/** Parse the time-estimate buffer: a positive integer (minutes) or null. */
export function parseTimeEstimate(raw: string): number | null {
	const n = Number(raw.trim());
	return Number.isInteger(n) && n >= 1 ? n : null;
}

/** Whether one draft PARTICIPATES: at least one sub-config is enabled. */
export function draftParticipates(
	draft: BlockDraft,
	mode: ConnectType,
): boolean {
	return mode === "learn"
		? draft.learnOn || draft.assessmentOn
		: draft.deliverOn || draft.taskOn;
}

/** Whether every ENABLED sub-config's required content is filled. Ids and
 *  the optional XPath buffers don't gate (they autofill / wire-default); an
 *  enabled assessment is always complete. */
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

/** Validate an explicitly-typed id (format + app-wide uniqueness). A blank
 *  id is valid — the commit autofills it. */
export type IdValidator = (kind: SubConfigKind, value: string) => string | null;

/** Whether every enabled sub-config's typed id is valid. Blank ids pass
 *  (autofill). Used alongside `draftSectionsComplete` so a bad id can't slip
 *  past to a gate bounce. */
export function draftIdsValid(
	draft: BlockDraft,
	mode: ConnectType,
	validateId: IdValidator,
): boolean {
	const check = (kind: SubConfigKind, on: boolean, id: string) =>
		!on || validateId(kind, id) === null;
	return mode === "learn"
		? check("learn_module", draft.learnOn, draft.learnId) &&
				check("assessment", draft.assessmentOn, draft.assessmentId)
		: check("deliver_unit", draft.deliverOn, draft.deliverId) &&
				check("task", draft.taskOn, draft.taskId);
}

/** Lower a draft to the `ConnectConfig` the commit path lands. A blank id
 *  is omitted (the commit autofills); a blank XPath buffer is omitted (the
 *  wire-emit default applies — writing `""` would trip
 *  `CONNECT_EMPTY_XPATH`); a filled buffer is parsed against the form. */
export function draftToConfig(
	draft: BlockDraft,
	mode: ConnectType,
	parseExpr: (text: string) => XPathExpression,
): ConnectConfig {
	if (mode === "learn") {
		return {
			...(draft.learnOn && {
				learn_module: {
					...(draft.learnId.trim() && { id: draft.learnId.trim() }),
					name: draft.learnName.trim(),
					description: draft.learnDescription.trim(),
					time_estimate: parseTimeEstimate(draft.learnTimeEstimate) ?? 1,
				},
			}),
			...(draft.assessmentOn && {
				assessment: {
					...(draft.assessmentId.trim() && { id: draft.assessmentId.trim() }),
					...(draft.userScoreText.trim() && {
						user_score: parseExpr(draft.userScoreText.trim()),
					}),
				},
			}),
		};
	}
	return {
		...(draft.deliverOn && {
			deliver_unit: {
				...(draft.deliverId.trim() && { id: draft.deliverId.trim() }),
				name: draft.deliverName.trim(),
				...(draft.entityIdText.trim() && {
					entity_id: parseExpr(draft.entityIdText.trim()),
				}),
				...(draft.entityNameText.trim() && {
					entity_name: parseExpr(draft.entityNameText.trim()),
				}),
			},
		}),
		...(draft.taskOn && {
			task: {
				...(draft.taskId.trim() && { id: draft.taskId.trim() }),
				name: draft.taskName.trim(),
				description: draft.taskDescription.trim(),
			},
		}),
	};
}

// ── Field + card primitives ───────────────────────────────────────────────

/** One polished, controlled field — the single input style for every
 *  Connect draft surface (this dialog, the manager, and the form-settings
 *  sub-toggles). Blur-commit lives in `InlineField`; this one is pure
 *  controlled state, validated live and committed by its owner on apply. */
export function DraftField({
	label,
	value,
	onChange,
	validate,
	mono,
	multiline,
	suffix,
	placeholder,
	required,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	/** Reason the current value is invalid, or `null`. Rendered beneath the
	 *  field; also tints the border. */
	validate?: (value: string) => string | null;
	mono?: boolean;
	multiline?: boolean;
	suffix?: string;
	placeholder?: string;
	required?: boolean;
}) {
	const fieldId = useId();
	const error = validate?.(value) ?? null;
	const base =
		"w-full text-xs rounded-md border px-2.5 py-1.5 outline-none transition-colors placeholder:text-nova-text-muted/60";
	const tone = error
		? "border-nova-rose/60 bg-nova-surface shadow-[0_0_0_1px_rgba(212,112,143,0.12)]"
		: "border-white/[0.07] bg-nova-deep/50 hover:border-nova-violet/30 focus:border-nova-violet/50 focus:bg-nova-surface";
	const text = mono ? "font-mono text-nova-violet-bright" : "text-nova-text";
	return (
		<div>
			<label
				htmlFor={fieldId}
				className="mb-1 flex items-center gap-0.5 text-[10px] uppercase tracking-wider text-nova-text-muted"
			>
				{label}
				{required && <span className="text-nova-rose">*</span>}
			</label>
			<div className="relative">
				{multiline ? (
					<textarea
						id={fieldId}
						className={`${base} ${tone} ${text} resize-none`}
						rows={2}
						value={value}
						onChange={(e) => onChange(e.target.value)}
						placeholder={placeholder}
						autoComplete="off"
						data-1p-ignore
					/>
				) : (
					<input
						id={fieldId}
						type="text"
						className={`${base} ${tone} ${text}${suffix ? " pr-9" : ""}`}
						value={value}
						onChange={(e) => onChange(e.target.value)}
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
			{error && <p className="mt-1 text-[10px] text-nova-rose">{error}</p>}
		</div>
	);
}

/** A collapsible "Advanced" section — holds the rarely-touched id + XPath
 *  fields so a sub-config card opens to just its essentials. */
function AdvancedDisclosure({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="pt-0.5">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="flex cursor-pointer items-center gap-1 text-[10px] uppercase tracking-wider text-nova-text-muted transition-colors hover:text-nova-text-secondary"
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
	enabled,
	onToggle,
	children,
}: {
	title: string;
	enabled: boolean;
	onToggle: () => void;
	children?: ReactNode;
}) {
	return (
		<div className="rounded-lg border border-white/[0.06] bg-white/[0.02]">
			<div className="flex items-center justify-between px-3 py-2.5">
				<span className="text-[11px] font-medium uppercase tracking-wider text-nova-text-secondary">
					{title}
				</span>
				<Toggle enabled={enabled} onToggle={onToggle} variant="sub" />
			</div>
			{enabled && children && (
				<div className="space-y-2.5 border-t border-white/[0.06] px-3 pb-3 pt-2.5">
					{children}
				</div>
			)}
		</div>
	);
}

/** The learn / deliver sub-config pair for one form's draft — the single
 *  per-form editor, shared by the dialog and the manager. `validateId`
 *  surfaces an explicit id's format / uniqueness reason inline. */
export function FormSubConfigs({
	mode,
	draft,
	onPatch,
	validateId,
}: {
	mode: ConnectType;
	draft: BlockDraft;
	onPatch: (patch: Partial<BlockDraft>) => void;
	validateId: IdValidator;
}) {
	const idCheck = (kind: SubConfigKind) => (value: string) =>
		value.trim() ? validateId(kind, value) : null;

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
						label="Time Estimate"
						value={draft.learnTimeEstimate}
						onChange={(v) => onPatch({ learnTimeEstimate: v })}
						suffix="min"
						required
					/>
					<AdvancedDisclosure>
						<DraftField
							label="Module ID"
							value={draft.learnId}
							onChange={(v) => onPatch({ learnId: v })}
							validate={idCheck("learn_module")}
							placeholder="Auto-generated"
							mono
						/>
					</AdvancedDisclosure>
				</SubConfigCard>
				<SubConfigCard
					title="Assessment"
					enabled={draft.assessmentOn}
					onToggle={() => onPatch({ assessmentOn: !draft.assessmentOn })}
				>
					<DraftField
						label="User Score"
						value={draft.userScoreText}
						onChange={(v) => onPatch({ userScoreText: v })}
						placeholder="Default (final assessment score)"
						mono
					/>
					<AdvancedDisclosure>
						<DraftField
							label="Assessment ID"
							value={draft.assessmentId}
							onChange={(v) => onPatch({ assessmentId: v })}
							validate={idCheck("assessment")}
							placeholder="Auto-generated"
							mono
						/>
					</AdvancedDisclosure>
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
					required
				/>
				<AdvancedDisclosure>
					<DraftField
						label="Deliver Unit ID"
						value={draft.deliverId}
						onChange={(v) => onPatch({ deliverId: v })}
						validate={idCheck("deliver_unit")}
						placeholder="Auto-generated"
						mono
					/>
					<DraftField
						label="Entity ID"
						value={draft.entityIdText}
						onChange={(v) => onPatch({ entityIdText: v })}
						placeholder="Default"
						mono
					/>
					<DraftField
						label="Entity Name"
						value={draft.entityNameText}
						onChange={(v) => onPatch({ entityNameText: v })}
						placeholder="Default"
						mono
					/>
				</AdvancedDisclosure>
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
						validate={idCheck("task")}
						placeholder="Auto-generated"
						mono
					/>
				</AdvancedDisclosure>
			</SubConfigCard>
		</>
	);
}

/** Bind an {@link IdValidator} over the app's current connect ids — format
 *  legality plus uniqueness against every OTHER form's ids. Shared by the
 *  dialog and the manager so a typed id is judged the same everywhere. */
export function useIdValidator(): (formUuid: string) => IdValidator {
	const appConnectIds = useAppConnectIds();
	return useCallback(
		(formUuid: string): IdValidator =>
			(kind, value) => {
				const id = value.trim();
				if (!id) return null;
				return connectIdValidity(
					id,
					connectIdsExcept(appConnectIds, asUuid(formUuid), kind),
				);
			},
		[appConnectIds],
	);
}

/** Shared footer rejection block — the gate's findings, rendered inline so
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
	const idValidatorFor = useIdValidator();

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
		draftIdsValid(draftOf(t.formUuid), mode, idValidatorFor(t.formUuid)),
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
						draftToConfig(draftOf(t.formUuid), mode, (text) =>
							parseXPathForForm(doc, asUuid(t.formUuid), text),
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
					<Dialog.Title className="font-display text-base font-semibold text-nova-text">
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
							validateId={idValidatorFor(t.formUuid)}
						/>
					</div>
				))}
			</div>

			<div className="space-y-2 border-t border-nova-border px-5 py-3">
				<RejectionNoticeBlock messages={rejectionMessages} />
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
