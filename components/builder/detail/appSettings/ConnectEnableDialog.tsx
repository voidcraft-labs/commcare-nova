"use client";
import { Dialog } from "@base-ui/react/dialog";
import { Icon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerX from "@iconify-icons/tabler/x";
import { type ReactNode, useCallback, useId, useState } from "react";
import { LabeledXPathField } from "@/components/builder/detail/formSettings/LabeledXPathField";
import { useConnectLintContext } from "@/components/builder/detail/formSettings/useConnectLintContext";
import { RejectionBody } from "@/components/builder/RejectionNotice";
import { Toggle } from "@/components/ui/Toggle";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import {
	assignConnectId,
	connectIdValidity,
	DEFAULT_ASSESSMENT_USER_SCORE,
	DEFAULT_DELIVER_ENTITY_ID,
	DEFAULT_DELIVER_ENTITY_NAME,
	deriveConnectId,
} from "@/lib/doc/connectConfig";
import { parseXPathForForm } from "@/lib/doc/expressionText";
import {
	type AppConnectId,
	connectIdsExcept,
	useAppConnectIds,
} from "@/lib/doc/hooks/useAppConnectIds";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import type { ConnectConfig, ConnectType, XPathExpression } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import { CurrentFormScope } from "@/lib/references/ReferenceContext";
import { useStopEscape } from "@/lib/ui/hooks/useStopEscape";
import { assertNever } from "@/lib/utils/assertNever";

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
 * fields. Every optional slot shows its REAL default as an editable value and
 * refills it on blur, so a slot is never left blank and the editor never has
 * to explain what blank means:
 *   - The XPath slots (`user_score`, `entity_id`, `entity_name`) use the real
 *     expression editor (`XPathField` — live lint, condition parsing, hashtag
 *     chips), seeded with their actual wire default; a blank commit snaps back
 *     to that default, and an unchanged default drops to absent at commit so
 *     the single wire-emit default applies.
 *   - The identifiers sit behind an "Advanced" disclosure, seeded when the
 *     sub-config turns on with the value the commit would derive (never a
 *     placeholder); clearing one and leaving the field snaps it back to that
 *     derived id on blur — the same blur-commit the XPath slots do.
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
	// The XPath buffers start at the ACTUAL wire default (not blank) so the
	// editor shows the user exactly what runs; a buffer left at the default is
	// dropped on commit (`draftToConfig`), so the slot stays absent and the
	// wire-emit fallback — the single source of the default — still applies.
	userScoreText: DEFAULT_ASSESSMENT_USER_SCORE,
	deliverOn: false,
	deliverName: "",
	deliverId: "",
	entityIdText: DEFAULT_DELIVER_ENTITY_ID,
	entityNameText: DEFAULT_DELIVER_ENTITY_NAME,
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
		// Absent XPath slots show their wire default so the user sees what runs.
		userScoreText: assessment?.user_score
			? printExpr(assessment.user_score)
			: DEFAULT_ASSESSMENT_USER_SCORE,
		deliverOn: !!du,
		deliverName: du?.name ?? "",
		deliverId: du?.id ?? "",
		entityIdText: du?.entity_id
			? printExpr(du.entity_id)
			: DEFAULT_DELIVER_ENTITY_ID,
		entityNameText: du?.entity_name
			? printExpr(du.entity_name)
			: DEFAULT_DELIVER_ENTITY_NAME,
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

/** The base name `deriveConnectId` builds a slot's id from: the module name
 *  for the module-level kinds, "<module> <form>" for the per-form kinds. */
function idBaseName(
	kind: SubConfigKind,
	moduleName: string,
	formName: string,
): string {
	return kind === "assessment" || kind === "task"
		? `${moduleName} ${formName}`
		: moduleName;
}

/** Per-form id helpers — derive a blank slot's id, validate a typed one —
 *  bound to a "taken" id universe. The app-wide manager passes its
 *  DRAFT-derived universe (so sibling in-flight drafts AND the mode actually
 *  being edited are in scope); the per-form dialog passes the live-doc
 *  universe. One builder, so a typed id is judged and a blank one seeded
 *  identically wherever the editor runs. */
export function connectIdHelpers(
	ids: readonly AppConnectId[],
	formUuid: string,
	moduleName: string,
	formName: string,
): { derivedId: (kind: SubConfigKind) => string; validateId: IdValidator } {
	const takenFor = (kind: SubConfigKind) =>
		connectIdsExcept(ids, asUuid(formUuid), kind);
	return {
		derivedId: (kind) =>
			deriveConnectId(idBaseName(kind, moduleName, formName), takenFor(kind)),
		validateId: (kind, value) => {
			const id = value.trim();
			return id ? connectIdValidity(id, takenFor(kind)) : null;
		},
	};
}

/** The id every participating sub-config of `mode` will carry, accumulated via
 *  the SHARED `assignConnectId` rule the commit's `dedupeRestoredConnectIds`
 *  also uses (a free explicit id kept verbatim, otherwise derived from the
 *  explicit value or the entity name) and in the same kind order — so the
 *  preview lands the SAME ids the commit will. Built from the manager's drafts
 *  so its id guard and seeding read the in-flight set, not just the live doc:
 *  two blank same-base blocks disambiguate here exactly as they will at commit
 *  (no display-vs-stored drift), and an explicit duplicate typed across two
 *  forms is caught inline. */
export function assignDraftConnectIds(
	forms: readonly { formUuid: string; moduleName: string; formName: string }[],
	modeDrafts: Record<string, BlockDraft>,
	mode: ConnectType,
): AppConnectId[] {
	const taken = new Set<string>();
	const out: AppConnectId[] = [];
	const assign = (
		formUuid: string,
		kind: SubConfigKind,
		on: boolean,
		buffer: string,
		base: string,
	) => {
		if (!on) return;
		const id = assignConnectId(buffer.trim() || undefined, base, taken);
		out.push({ formUuid: asUuid(formUuid), kind, id });
	};
	for (const f of forms) {
		const d = modeDrafts[f.formUuid] ?? EMPTY_DRAFT;
		const pair = `${f.moduleName} ${f.formName}`;
		if (mode === "learn") {
			assign(f.formUuid, "learn_module", d.learnOn, d.learnId, f.moduleName);
			assign(f.formUuid, "assessment", d.assessmentOn, d.assessmentId, pair);
		} else {
			assign(
				f.formUuid,
				"deliver_unit",
				d.deliverOn,
				d.deliverId,
				f.moduleName,
			);
			assign(f.formUuid, "task", d.taskOn, d.taskId, pair);
		}
	}
	return out;
}

/** An XPath buffer counts as an OVERRIDE only when it's non-empty AND
 *  differs from the wire default. Otherwise the slot is left absent so the
 *  single wire-emit default applies (and a blank never trips
 *  `CONNECT_EMPTY_XPATH`) — the editor shows the default as a starting point
 *  the user can replace, not a value Nova pins into the doc. */
function xpathOverride(
	text: string,
	wireDefault: string,
	parseExpr: (text: string) => XPathExpression,
): XPathExpression | undefined {
	const trimmed = text.trim();
	if (!trimmed || trimmed === wireDefault) return undefined;
	return parseExpr(trimmed);
}

/** Lower a draft to the `ConnectConfig` the commit path lands. A blank id
 *  is omitted (the commit autofills); an XPath buffer still at its default is
 *  omitted (the wire-emit default applies); an overridden buffer is parsed
 *  against the form. */
export function draftToConfig(
	draft: BlockDraft,
	mode: ConnectType,
	parseExpr: (text: string) => XPathExpression,
): ConnectConfig {
	if (mode === "learn") {
		const userScore = xpathOverride(
			draft.userScoreText,
			DEFAULT_ASSESSMENT_USER_SCORE,
			parseExpr,
		);
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
					...(userScore && { user_score: userScore }),
				},
			}),
		};
	}
	const entityId = xpathOverride(
		draft.entityIdText,
		DEFAULT_DELIVER_ENTITY_ID,
		parseExpr,
	);
	const entityName = xpathOverride(
		draft.entityNameText,
		DEFAULT_DELIVER_ENTITY_NAME,
		parseExpr,
	);
	return {
		...(draft.deliverOn && {
			deliver_unit: {
				...(draft.deliverId.trim() && { id: draft.deliverId.trim() }),
				name: draft.deliverName.trim(),
				...(entityId && { entity_id: entityId }),
				...(entityName && { entity_name: entityName }),
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
	/** Fired when the field loses focus — the commit moment for fields that
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
	// Escape exits the FIELD (blur), never the surrounding dialog — see hook.
	const stopEscape = useStopEscape();

	// Tones match the form-settings `InlineField` exactly so the two share one
	// visual language (this is a controlled field; that one blur-commits).
	const base =
		"w-full text-xs rounded-md border px-2 py-1.5 outline-none transition-colors placeholder:text-nova-text-muted";
	const tone = error
		? "border-nova-rose/60 bg-nova-surface shadow-[0_0_0_1px_rgba(212,112,143,0.15)]"
		: "border-white/[0.06] bg-nova-deep/50 hover:border-nova-violet/30 focus:border-nova-violet/50 focus:bg-nova-surface focus:shadow-[0_0_0_1px_rgba(139,92,246,0.1)]";
	const text = mono ? "font-mono text-nova-violet-bright" : "text-nova-text";
	return (
		<div>
			<label
				htmlFor={fieldId}
				className="mb-0.5 flex items-center gap-0.5 text-[10px] uppercase tracking-wider text-nova-text-muted"
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

/** A Connect XPath slot, rendered with the real expression editor — live
 *  validation, condition parsing, and hashtag/chip autocomplete (the same
 *  CodeMirror field the rest of the builder uses). The buffer starts at the
 *  wire default so the user sees exactly what runs and can replace it; the
 *  editor commits on blur, and a blank commit snaps back to `defaultText`
 *  rather than persisting empty — the slot is never left blank, the same
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

/** The learn / deliver sub-config pair for one form's draft — the single
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
	 *  seed an id field on turn-on and to refill it on a blank blur — never a
	 *  placeholder; what's shown is what the commit will store. */
	derivedId: (kind: SubConfigKind) => string;
	formUuid: string;
}) {
	const idCheck = (kind: SubConfigKind) => (value: string) =>
		value.trim() ? validateId(kind, value) : null;
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
								...(draft.learnId.trim()
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
								...(draft.assessmentId.trim()
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
								...(draft.deliverId.trim()
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
								...(draft.taskId.trim() ? {} : { taskId: derivedId("task") }),
							},
				);
			default:
				return assertNever(kind);
		}
	};

	// Blur-commit for an id field: a blank buffer snaps back to the derived
	// default so the slot is never left empty (the user who wants the auto id
	// just clears it and leaves; one who wants their own types it). The commit
	// path autofills a blank id regardless — this only keeps the field honest.
	const blurResetId = (kind: SubConfigKind) => () => {
		switch (kind) {
			case "learn_module":
				if (!draft.learnId.trim()) onPatch({ learnId: derivedId(kind) });
				return;
			case "assessment":
				if (!draft.assessmentId.trim())
					onPatch({ assessmentId: derivedId(kind) });
				return;
			case "deliver_unit":
				if (!draft.deliverId.trim()) onPatch({ deliverId: derivedId(kind) });
				return;
			case "task":
				if (!draft.taskId.trim()) onPatch({ taskId: derivedId(kind) });
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
					enabled={draft.learnOn}
					onToggle={() => toggleSub("learn_module")}
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
							onBlur={blurResetId("learn_module")}
							validate={idCheck("learn_module")}
							mono
						/>
					</AdvancedDisclosure>
				</SubConfigCard>
				<SubConfigCard
					title="Assessment"
					enabled={draft.assessmentOn}
					onToggle={() => toggleSub("assessment")}
				>
					<ConnectXPathField
						label="User Score"
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
					enabled={draft.deliverOn}
					onToggle={() => toggleSub("deliver_unit")}
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
						label="Entity Name"
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
					enabled={draft.taskOn}
					onToggle={() => toggleSub("task")}
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
		Object.fromEntries(targets.map((t) => [t.formUuid, { ...EMPTY_DRAFT }])),
	);
	// One id scope for the dialog, built from the LIVE doc — the per-form setup
	// edits the active mode against every other form's committed ids.
	const appConnectIds = useAppConnectIds();
	const idHelpers: Record<string, ReturnType<typeof connectIdHelpers>> = {};
	for (const t of targets) {
		idHelpers[t.formUuid] = connectIdHelpers(
			appConnectIds,
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
