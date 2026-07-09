"use client";
import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import { useMemo, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { parseXPathForForm, printXPathInDoc } from "@/lib/doc/expressionText";
import { useAppStructure } from "@/lib/doc/hooks/useAppStructure";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useConnectTypeOrUndefined } from "@/lib/doc/hooks/useConnectType";
import { useDocEntityMaps } from "@/lib/doc/hooks/useDocEntityMaps";
import { bySortKey } from "@/lib/doc/order/compare";
import type { BlueprintDoc, XPathExpression } from "@/lib/domain";
import {
	asUuid,
	CONNECT_TYPES,
	type ConnectConfig,
	type ConnectType,
} from "@/lib/domain";
import { useLastConnectType, useSwitchConnectMode } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import {
	assignDraftConnectIds,
	type BlockDraft,
	configToDraft,
	connectIdHelpers,
	draftIdsValid,
	draftParticipates,
	draftSectionsComplete,
	draftToConfig,
	EMPTY_DRAFT,
	FormSubConfigs,
	RejectionNoticeBlock,
} from "./ConnectEnableDialog";

/**
 * App-wide CommCare Connect manager — the single surface that owns the
 * app-level Connect story, opened from App Settings. ONE coherent editor:
 * every form is a draft, every field (names, descriptions, time, ids, the
 * XPath slots behind "Advanced") edits in place, and a single primary action
 * commits the whole set through the gated `switchConnectMode`.
 *
 *   - The Learn / Deliver control picks which mode you're editing; the active
 *     mode carries a dot. Each mode keeps its own drafts, seeded from the
 *     live doc (active mode) and the session stash (the other), so flipping
 *     the control never loses in-progress work.
 *   - The primary action reads "Apply changes" (editing the active mode),
 *     "Switch to <mode>" (moving to the other mode — gated on reaching it
 *     with ≥1 participant in one atomic batch), or "Enable Connect" (off).
 *     A rejected commit keeps the drafts with the gate's findings inline.
 *   - "Turn off Connect" disables it entirely (the stash preserves the work).
 *
 * Mounts through a portal so it escapes the app-settings popover's
 * transformed positioner, the same pattern as `ConnectEnableDialog`.
 */

/** One form row the manager renders + drafts for. */
interface FormRow {
	formUuid: string;
	formName: string;
	moduleName: string;
}

type ModeDrafts = Record<ConnectType, Record<string, BlockDraft>>;

/** The app's forms in tree order — subscribes to the live structure + name
 *  maps so the manager tracks a concurrent edit (an agent adding, removing, or
 *  renaming a form while the modal is open) instead of editing a stale
 *  snapshot. Drafts stay keyed by uuid, so an added form is editable via the
 *  `EMPTY_DRAFT` fallback and a removed one simply stops rendering. */
function useFormRows(): FormRow[] {
	const { moduleOrder, formOrder } = useAppStructure();
	const { modules, forms } = useDocEntityMaps();
	return useMemo(() => {
		const out: FormRow[] = [];
		// DISPLAY order (`sort-by-(order, uuid)`) — the manager renders one row
		// per form, so it must match the app's rendered module/form sequence,
		// not `moduleOrder` / `formOrder` array position.
		const sortedModules = [...moduleOrder].sort((a, b) =>
			bySortKey(modules[a] ?? {}, modules[b] ?? {}),
		);
		for (const moduleUuid of sortedModules) {
			const sortedForms = [...(formOrder[moduleUuid] ?? [])].sort((a, b) =>
				bySortKey(forms[a] ?? {}, forms[b] ?? {}),
			);
			for (const formUuid of sortedForms) {
				out.push({
					formUuid,
					formName: forms[formUuid]?.name ?? "",
					moduleName: modules[moduleUuid]?.name ?? "",
				});
			}
		}
		return out;
	}, [moduleOrder, formOrder, modules, forms]);
}

/** Seed one mode's draft per form: the form's live block when `mode` is the
 *  app's active mode, the session stash otherwise. Existing XPath is printed
 *  to its buffer so it round-trips. Each empty slot gets its OWN cloned
 *  `EMPTY_DRAFT` — never the shared singleton — so a slot can never alias
 *  another (or the dirty baseline). */
function seedModeDrafts(
	forms: FormRow[],
	doc: BlueprintDoc,
	stash: Record<ConnectType, Record<string, ConnectConfig>>,
	mode: ConnectType,
	currentType: ConnectType | undefined,
	printExpr: (expr: XPathExpression) => string,
): Record<string, BlockDraft> {
	const out: Record<string, BlockDraft> = {};
	for (const f of forms) {
		const src =
			currentType === mode
				? doc.forms[f.formUuid]?.connect
				: stash[mode]?.[f.formUuid];
		out[f.formUuid] = src ? configToDraft(src, printExpr) : { ...EMPTY_DRAFT };
	}
	return out;
}

/** Seed both modes' drafts (open-time). */
function seedDrafts(
	forms: FormRow[],
	doc: BlueprintDoc,
	stash: Record<ConnectType, Record<string, ConnectConfig>>,
	currentType: ConnectType | undefined,
	printExpr: (expr: XPathExpression) => string,
): ModeDrafts {
	const drafts = {} as ModeDrafts;
	for (const mode of CONNECT_TYPES) {
		drafts[mode] = seedModeDrafts(
			forms,
			doc,
			stash,
			mode,
			currentType,
			printExpr,
		);
	}
	return drafts;
}

/** A normalized key for "would committing this mode change anything" — only
 *  the fields of ENABLED sub-configs count, so a residual id/name left in a
 *  toggled-OFF sub-config's buffer never reads as a change. A draft with NO
 *  enabled sub-config is skipped entirely so it reads identically to an absent
 *  one — otherwise a form added to the doc while the modal is open (present in
 *  `drafts` but not the once-captured `seeded`) and toggled on→off would read
 *  as permanently dirty. */
function dirtyKey(
	modeDrafts: Record<string, BlockDraft>,
	mode: ConnectType,
): string {
	const norm: Record<string, unknown> = {};
	for (const [uuid, d] of Object.entries(modeDrafts)) {
		if (!draftParticipates(d, mode)) continue;
		norm[uuid] =
			mode === "learn"
				? [
						d.learnOn && [
							d.learnName,
							d.learnDescription,
							d.learnTimeEstimate,
							d.learnId,
						],
						d.assessmentOn && [d.assessmentId, d.userScoreText],
					]
				: [
						d.deliverOn && [
							d.deliverName,
							d.deliverId,
							d.entityIdText,
							d.entityNameText,
						],
						d.taskOn && [d.taskName, d.taskDescription, d.taskId],
					];
	}
	return JSON.stringify(norm);
}

export function ConnectManagerDialog({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	// Stays mounted across open/close so Base UI plays BOTH transitions; the
	// stateful body mounts only while open, so its drafts re-seed every open.
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<DialogContent
				showCloseButton={false}
				className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-lg"
			>
				{open && <ManagerBody onClose={onClose} />}
			</DialogContent>
		</Dialog>
	);
}

function ManagerBody({ onClose }: { onClose: () => void }) {
	const connectType = useConnectTypeOrUndefined();
	const lastConnectType = useLastConnectType();
	const switchMode = useSwitchConnectMode();
	const docApi = useBlueprintDocApi();
	const sessionApi = useBuilderSessionApi();

	const enabled = !!connectType;

	const forms = useFormRows();
	const initialDrafts = useState<ModeDrafts>(() => {
		const doc = docApi.getState();
		return seedDrafts(
			forms,
			doc,
			sessionApi.getState().connectStash,
			connectType,
			(expr) => printXPathInDoc(doc, expr),
		);
	})[0];
	const [drafts, setDrafts] = useState<ModeDrafts>(initialDrafts);
	/** The last-committed snapshot — diffed against `drafts` to gate "Apply
	 *  changes" on real edits and to drive the saved/unsaved hint. */
	const [seeded, setSeeded] = useState<ModeDrafts>(initialDrafts);
	const [selectedMode, setSelectedMode] = useState<ConnectType>(
		connectType ?? lastConnectType ?? "learn",
	);
	const [rejectionMessages, setRejectionMessages] = useState<string[]>([]);

	const modeDrafts = drafts[selectedMode];
	const draftOf = (formUuid: string) => modeDrafts[formUuid] ?? EMPTY_DRAFT;

	const patchDraft = (formUuid: string, patch: Partial<BlockDraft>) => {
		// An edit invalidates any inline gate findings from a prior apply — clear
		// them so a stale rejection can't describe a problem the user just fixed.
		setRejectionMessages((m) => (m.length ? [] : m));
		setDrafts((prev) => ({
			...prev,
			[selectedMode]: {
				...prev[selectedMode],
				[formUuid]: {
					...(prev[selectedMode][formUuid] ?? EMPTY_DRAFT),
					...patch,
				},
			},
		}));
	};

	// Id uniqueness scoped to the IN-FLIGHT drafts of the mode being edited —
	// NOT the live doc. So a duplicate id the user types across two forms is
	// caught inline, a seeded id matches what the commit will store, and editing
	// the mode the app isn't currently in validates against the right set. One
	// helper per form (built from the same shared scope) drives both the seed
	// and the inline check.
	const assignedIds = assignDraftConnectIds(forms, modeDrafts, selectedMode);
	const idHelpers: Record<string, ReturnType<typeof connectIdHelpers>> = {};
	for (const f of forms) {
		idHelpers[f.formUuid] = connectIdHelpers(
			assignedIds,
			f.formUuid,
			f.moduleName,
			f.formName,
		);
	}

	const isCurrentMode = enabled && selectedMode === connectType;
	const dirty =
		dirtyKey(drafts[selectedMode], selectedMode) !==
		dirtyKey(seeded[selectedMode], selectedMode);

	const sectionsComplete = forms.every((f) =>
		draftSectionsComplete(draftOf(f.formUuid), selectedMode),
	);
	const idsValid = forms.every((f) =>
		draftIdsValid(
			draftOf(f.formUuid),
			selectedMode,
			idHelpers[f.formUuid].validateId,
		),
	);
	const participatingCount = forms.filter((f) =>
		draftParticipates(draftOf(f.formUuid), selectedMode),
	).length;
	const hasParticipant = forms.length === 0 || participatingCount >= 1;
	// Same-mode apply needs real edits; a switch / enable is itself the change.
	const canApply =
		sectionsComplete &&
		idsValid &&
		hasParticipant &&
		(isCurrentMode ? dirty : true);

	const modeLabel = (m: ConnectType) => (m === "learn" ? "Learn" : "Deliver");
	const primaryLabel = !enabled
		? "Enable Connect"
		: isCurrentMode
			? "Apply changes"
			: `Switch to ${modeLabel(selectedMode)}`;

	const hint = !sectionsComplete
		? "Finish the sections you've turned on."
		: !idsValid
			? "Fix the highlighted ID."
			: !hasParticipant
				? "Turn on a section for at least one form."
				: !enabled
					? "Ready to enable."
					: isCurrentMode
						? dirty
							? "Unsaved changes."
							: "All changes saved."
						: `Ready to switch to ${modeLabel(selectedMode)}.`;

	const reseed = () => {
		// Only the just-applied mode changed on the doc — rebuild ITS drafts +
		// baseline and PRESERVE the other mode's in-progress work (reseeding both
		// would silently discard uncommitted edits the user made to the mode they
		// didn't apply).
		const doc = docApi.getState();
		const fresh = seedModeDrafts(
			forms,
			doc,
			sessionApi.getState().connectStash,
			selectedMode,
			(doc.connectType ?? undefined) as ConnectType | undefined,
			(expr) => printXPathInDoc(doc, expr),
		);
		setDrafts((prev) => ({ ...prev, [selectedMode]: fresh }));
		setSeeded((prev) => ({ ...prev, [selectedMode]: fresh }));
	};

	const apply = () => {
		const doc = docApi.getState();
		const blocks: Record<string, ConnectConfig> = {};
		for (const f of forms) {
			if (!draftParticipates(draftOf(f.formUuid), selectedMode)) continue;
			// A same-mode participating form the user never touched (its draft is
			// still the exact object we seeded) commits its STORED block verbatim,
			// so re-deriving (which trims names + re-canonicalizes XPath) can't
			// emit a redundant updateForm that bumps `updated_at` on an untouched
			// form. A touched form, a switch, or an enable always re-derives.
			const untouched =
				isCurrentMode &&
				drafts[selectedMode][f.formUuid] === seeded[selectedMode][f.formUuid];
			const stored = doc.forms[f.formUuid]?.connect;
			blocks[f.formUuid] =
				untouched && stored
					? stored
					: draftToConfig(draftOf(f.formUuid), selectedMode, (text) =>
							parseXPathForForm(doc, asUuid(f.formUuid), text),
						);
		}
		const outcome = switchMode(selectedMode, blocks, { announce: false });
		if (outcome.ok) {
			reseed();
			setRejectionMessages([]);
			return;
		}
		setRejectionMessages(outcome.messages);
	};

	const turnOff = () => {
		/* Disabling is always valid (the stash preserves each mode's work),
		 * so this never bounces — route any hypothetical finding inline. */
		const outcome = switchMode(null, undefined, { announce: false });
		if (outcome.ok) onClose();
		else setRejectionMessages(outcome.messages);
	};

	return (
		<>
			<header className="flex items-center justify-between border-b border-nova-border px-5 py-3.5">
				<div className="flex items-center gap-3">
					<DialogTitle className="font-display">CommCare Connect</DialogTitle>
					{/* Mode selector — the active mode carries a dot. */}
					<div
						className="flex items-center gap-1 rounded-lg bg-white/[0.04] p-0.5"
						role="radiogroup"
						aria-label="Connect mode"
					>
						{CONNECT_TYPES.map((mode) => {
							const active = selectedMode === mode;
							return (
								<label
									key={mode}
									className={`flex h-[24px] cursor-pointer items-center rounded-md px-2.5 text-[11px] font-medium outline-none transition-colors ${
										active
											? "bg-nova-violet/15 text-nova-violet-bright"
											: "text-nova-text-muted hover:text-nova-text-secondary"
									}`}
								>
									<input
										type="radio"
										name="connect-manager-mode"
										value={mode}
										checked={active}
										onChange={() => {
											setSelectedMode(mode);
											setRejectionMessages([]);
										}}
										className="sr-only"
									/>
									{modeLabel(mode)}
									{connectType === mode && (
										<span className="ml-1.5 size-1 rounded-full bg-nova-violet-bright" />
									)}
								</label>
							);
						})}
					</div>
				</div>
				<DialogClose
					render={<Button variant="ghost" size="icon-sm" />}
					aria-label="Close"
				>
					<Icon icon={tablerX} className="size-4" />
				</DialogClose>
			</header>

			<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
				<p className="text-xs leading-relaxed text-nova-text-secondary">
					{forms.length === 0
						? "This app has no forms yet. You can turn Connect on now and choose which forms take part once you add them."
						: isCurrentMode
							? "Turn forms on or off and edit their Connect details. Changes apply together when you save."
							: enabled
								? `Set up ${modeLabel(selectedMode)} for the forms that should take part, then switch. Your ${modeLabel(connectType)} setup is kept.`
								: `Pick which forms take part as ${modeLabel(selectedMode)} and fill them in. Forms you leave off stay out.`}
				</p>

				{forms.map((f) => (
					<div key={f.formUuid} className="space-y-2">
						<div className="text-xs font-medium text-nova-text">
							{f.formName}
							<span className="font-normal text-nova-text-muted">
								{" "}
								· {f.moduleName}
							</span>
						</div>
						<FormSubConfigs
							mode={selectedMode}
							draft={draftOf(f.formUuid)}
							onPatch={(patch) => patchDraft(f.formUuid, patch)}
							validateId={idHelpers[f.formUuid].validateId}
							derivedId={idHelpers[f.formUuid].derivedId}
							formUuid={f.formUuid}
						/>
					</div>
				))}
			</div>

			<div className="space-y-2 border-t border-nova-border px-5 py-3">
				<RejectionNoticeBlock messages={rejectionMessages} />
				<div className="flex items-center justify-between gap-3">
					{enabled ? (
						<button
							type="button"
							onClick={turnOff}
							className="cursor-pointer text-[11px] font-medium text-nova-rose transition-colors hover:text-nova-rose"
						>
							Turn off Connect
						</button>
					) : (
						<span />
					)}
					<div className="flex items-center gap-3">
						<span className="text-[11px] text-nova-text-muted">{hint}</span>
						<Button
							type="button"
							size="sm"
							onClick={apply}
							disabled={!canApply}
						>
							{primaryLabel}
						</Button>
					</div>
				</div>
			</div>
		</>
	);
}
