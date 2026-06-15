"use client";
import { Dialog } from "@base-ui/react/dialog";
import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import { useState } from "react";
import { parseXPathForForm, printXPathInDoc } from "@/lib/doc/expressionText";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useConnectTypeOrUndefined } from "@/lib/doc/hooks/useConnectType";
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
	type BlockDraft,
	configToDraft,
	draftIdsValid,
	draftParticipates,
	draftSectionsComplete,
	draftToConfig,
	EMPTY_DRAFT,
	FormSubConfigs,
	RejectionNoticeBlock,
	useIdValidator,
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
 * Mounts through `Dialog.Portal` so it escapes the app-settings popover's
 * transformed positioner, the same pattern as `ConnectEnableDialog`.
 */

const BACKDROP_CLS =
	"fixed inset-0 z-modal bg-black/60 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0";
const POPUP_CLS =
	"fixed z-modal top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl bg-nova-deep border border-nova-border shadow-xl outline-none transition-[transform,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";

/** One form row the manager renders + drafts for. */
interface FormRow {
	formUuid: string;
	formName: string;
	moduleName: string;
}

type ModeDrafts = Record<ConnectType, Record<string, BlockDraft>>;

/** The app's forms in tree order — captured once on open. */
function listForms(doc: BlueprintDoc): FormRow[] {
	const forms: FormRow[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			forms.push({
				formUuid,
				formName: doc.forms[formUuid]?.name ?? "",
				moduleName: doc.modules[moduleUuid]?.name ?? "",
			});
		}
	}
	return forms;
}

/** Seed a draft per form per mode: the ACTIVE mode from each form's live
 *  block, the other mode from the session stash. Existing XPath is printed
 *  to its buffer so it round-trips. */
function seedDrafts(
	forms: FormRow[],
	doc: BlueprintDoc,
	stash: Record<ConnectType, Record<string, ConnectConfig>>,
	currentType: ConnectType | undefined,
	printExpr: (expr: XPathExpression) => string,
): ModeDrafts {
	const drafts: ModeDrafts = { learn: {}, deliver: {} };
	for (const f of forms) {
		for (const mode of CONNECT_TYPES) {
			const src =
				currentType === mode
					? doc.forms[f.formUuid]?.connect
					: stash[mode]?.[f.formUuid];
			drafts[mode][f.formUuid] = src
				? configToDraft(src, printExpr)
				: EMPTY_DRAFT;
		}
	}
	return drafts;
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
		<Dialog.Root
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<Dialog.Portal>
				<Dialog.Backdrop className={BACKDROP_CLS} />
				<Dialog.Popup className={POPUP_CLS}>
					{open && <ManagerBody onClose={onClose} />}
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function ManagerBody({ onClose }: { onClose: () => void }) {
	const connectType = useConnectTypeOrUndefined();
	const lastConnectType = useLastConnectType();
	const switchMode = useSwitchConnectMode();
	const docApi = useBlueprintDocApi();
	const sessionApi = useBuilderSessionApi();
	const idValidatorFor = useIdValidator();

	const enabled = !!connectType;

	const [forms] = useState<FormRow[]>(() => listForms(docApi.getState()));
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

	const isCurrentMode = enabled && selectedMode === connectType;
	const dirty =
		JSON.stringify(drafts[selectedMode]) !==
		JSON.stringify(seeded[selectedMode]);

	const sectionsComplete = forms.every((f) =>
		draftSectionsComplete(draftOf(f.formUuid), selectedMode),
	);
	const idsValid = forms.every((f) =>
		draftIdsValid(
			draftOf(f.formUuid),
			selectedMode,
			idValidatorFor(f.formUuid),
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
		const doc = docApi.getState();
		const next = seedDrafts(
			forms,
			doc,
			sessionApi.getState().connectStash,
			(doc.connectType ?? undefined) as ConnectType | undefined,
			(expr) => printXPathInDoc(doc, expr),
		);
		setDrafts(next);
		setSeeded(next);
	};

	const apply = () => {
		const doc = docApi.getState();
		const blocks: Record<string, ConnectConfig> = Object.fromEntries(
			forms
				.filter((f) => draftParticipates(draftOf(f.formUuid), selectedMode))
				.map((f) => [
					f.formUuid,
					draftToConfig(draftOf(f.formUuid), selectedMode, (text) =>
						parseXPathForForm(doc, asUuid(f.formUuid), text),
					),
				]),
		);
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
					<Dialog.Title className="font-display text-base font-semibold text-nova-text">
						CommCare Connect
					</Dialog.Title>
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
				<Dialog.Close
					className="rounded-md p-1 text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text focus-visible:outline-1 focus-visible:outline-nova-violet-bright"
					aria-label="Close"
				>
					<Icon icon={tablerX} className="size-4" />
				</Dialog.Close>
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
							validateId={idValidatorFor(f.formUuid)}
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
							className="cursor-pointer text-[11px] font-medium text-nova-rose/80 transition-colors hover:text-nova-rose"
						>
							Turn off Connect
						</button>
					) : (
						<span />
					)}
					<div className="flex items-center gap-3">
						<span className="text-[11px] text-nova-text-muted">{hint}</span>
						<button
							type="button"
							onClick={apply}
							disabled={!canApply}
							className="rounded-lg bg-nova-violet px-3 py-1.5 text-xs font-medium text-white transition-colors enabled:cursor-pointer enabled:hover:brightness-110 disabled:opacity-40"
						>
							{primaryLabel}
						</button>
					</div>
				</div>
			</div>
		</>
	);
}
