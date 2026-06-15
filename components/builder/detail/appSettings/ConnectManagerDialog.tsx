"use client";
import { Dialog } from "@base-ui/react/dialog";
import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import { useState } from "react";
import { ConnectSection } from "@/components/builder/detail/formSettings/ConnectSection";
import { RejectionBody } from "@/components/builder/RejectionNotice";
import { parseXPathForForm } from "@/lib/doc/expressionText";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useConnectTypeOrUndefined } from "@/lib/doc/hooks/useConnectType";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
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
	draftParticipates,
	draftSectionsComplete,
	draftToConfig,
	EMPTY_DRAFT,
	FormSubConfigs,
} from "./ConnectEnableDialog";

/**
 * App-wide CommCare Connect manager. The single surface that owns the
 * app-level Connect story — opened from the App Settings "Manage / Set up
 * Connect" button. It has two views:
 *
 *   - LIVE (the app's active mode): every form rendered with its FULL
 *     per-form editor (the same `ConnectSection` form settings use —
 *     participation toggle, sub-config fields, ids, the XPath editors with
 *     lint), edited live through the gated mutation path. This is where all
 *     fields are surfaced; there is nothing left to do in form settings.
 *   - STAGING (switching to the other mode, or enabling from off): a flip is
 *     gated — the app must reach the new mode with ≥1 participant in ONE
 *     atomic batch — so the target mode is collected first with the
 *     lightweight sub-config cards, then committed via `switchConnectMode`.
 *     Once the flip lands, that mode is active and the manager drops into the
 *     LIVE view, where its advanced fields (ids autofilled, XPath defaults
 *     applied) are now editable.
 *
 * The Learn / Deliver control selects the view: the active mode shows LIVE,
 * the other shows STAGING. The active mode carries a dot. Turning Connect off
 * (or applying a switch) routes through the same gate; a rejected switch
 * keeps the staging drafts with the findings inline.
 *
 * Mounts through `Dialog.Portal` so it escapes the app-settings popover's
 * transformed positioner, the same pattern as `ConnectEnableDialog`.
 */

const BACKDROP_CLS =
	"fixed inset-0 z-modal bg-black/60 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0";
const POPUP_CLS =
	"fixed z-modal top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl bg-nova-deep border border-nova-border shadow-xl outline-none transition-[transform,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";

/** One form row the manager renders. */
interface FormRow {
	moduleUuid: Uuid;
	formUuid: Uuid;
	formName: string;
	moduleName: string;
}

/** The app's forms in tree order — captured once on open (the list doesn't
 *  change while the manager is up). */
function listForms(doc: BlueprintDoc): FormRow[] {
	const forms: FormRow[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			forms.push({
				moduleUuid,
				formUuid,
				formName: doc.forms[formUuid]?.name ?? "",
				moduleName: doc.modules[moduleUuid]?.name ?? "",
			});
		}
	}
	return forms;
}

/** Seed the staging drafts for `mode` from the session stash — a form's
 *  prior work for that (currently inactive) mode, or an empty draft. Read
 *  fresh on each entry into staging, since the stash changes as modes flip. */
function seedStaging(
	stash: Record<ConnectType, Record<string, ConnectConfig>>,
	mode: ConnectType,
	forms: FormRow[],
): Record<string, BlockDraft> {
	const drafts: Record<string, BlockDraft> = {};
	for (const f of forms) {
		const stashed = stash[mode]?.[f.formUuid];
		drafts[f.formUuid] = stashed ? configToDraft(stashed) : EMPTY_DRAFT;
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

/** The manager's content — a child of `Dialog.Popup`, so Base UI mounts it
 *  only while open and the staging drafts start fresh each time. */
function ManagerBody({ onClose }: { onClose: () => void }) {
	const connectType = useConnectTypeOrUndefined();
	const lastConnectType = useLastConnectType();
	const switchMode = useSwitchConnectMode();
	const docApi = useBlueprintDocApi();
	const sessionApi = useBuilderSessionApi();

	const enabled = !!connectType;

	const [forms] = useState<FormRow[]>(() => listForms(docApi.getState()));
	const [selectedMode, setSelectedMode] = useState<ConnectType>(
		connectType ?? lastConnectType ?? "learn",
	);
	/** Staging drafts for a switch/enable; `null` while viewing the live
	 *  active mode. Non-null exactly when the view is STAGING. */
	const [staging, setStaging] = useState<Record<string, BlockDraft> | null>(
		() =>
			connectType
				? null
				: seedStaging(
						sessionApi.getState().connectStash,
						connectType ?? lastConnectType ?? "learn",
						listForms(docApi.getState()),
					),
	);
	const [rejectionMessages, setRejectionMessages] = useState<string[]>([]);

	const modeLabel = (m: ConnectType) => (m === "learn" ? "Learn" : "Deliver");
	const isLive = enabled && selectedMode === connectType;

	/** Pick a mode tab: the active mode shows LIVE, any other mode opens
	 *  STAGING seeded fresh from the stash. */
	const selectMode = (mode: ConnectType) => {
		setSelectedMode(mode);
		setRejectionMessages([]);
		if (connectType === mode) {
			setStaging(null);
		} else {
			setStaging(seedStaging(sessionApi.getState().connectStash, mode, forms));
		}
	};

	const patchStaging = (formUuid: string, patch: Partial<BlockDraft>) => {
		setStaging((prev) =>
			prev
				? {
						...prev,
						[formUuid]: { ...(prev[formUuid] ?? EMPTY_DRAFT), ...patch },
					}
				: prev,
		);
	};

	const stagingDraftFor = (formUuid: string) =>
		staging?.[formUuid] ?? EMPTY_DRAFT;
	const sectionsComplete = forms.every((f) =>
		draftSectionsComplete(stagingDraftFor(f.formUuid), selectedMode),
	);
	const participatingCount = forms.filter((f) =>
		draftParticipates(stagingDraftFor(f.formUuid), selectedMode),
	).length;
	/* An app with no forms can still flip Connect on as the bare type change
	 * (the participation floor binds only once forms exist). */
	const canApply =
		forms.length === 0 || (sectionsComplete && participatingCount >= 1);

	const primaryLabel = enabled
		? `Switch to ${modeLabel(selectedMode)}`
		: "Enable Connect";
	const stagingHint = !sectionsComplete
		? "Finish the sections you've turned on."
		: participatingCount < 1 && forms.length > 0
			? "Turn on a section for at least one form."
			: enabled
				? `Ready to switch to ${modeLabel(selectedMode)}.`
				: "Ready to enable.";

	/** Commit a switch/enable: the staging drafts ARE the authoritative
	 *  participating set for the target mode. On success the app is now in
	 *  that mode, so drop into the LIVE view (don't close — the user keeps
	 *  managing). */
	const applySwitch = () => {
		const doc = docApi.getState();
		const blocks: Record<string, ConnectConfig> = Object.fromEntries(
			forms
				.filter((f) =>
					draftParticipates(stagingDraftFor(f.formUuid), selectedMode),
				)
				.map((f) => [
					f.formUuid,
					draftToConfig(stagingDraftFor(f.formUuid), selectedMode, (text) =>
						parseXPathForForm(doc, asUuid(f.formUuid), text),
					),
				]),
		);
		const outcome = switchMode(selectedMode, blocks, { announce: false });
		if (outcome.ok) {
			setStaging(null);
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

	/** Leave staging: back to the live active mode if there is one, else
	 *  close the manager. */
	const cancelStaging = () => {
		if (connectType) selectMode(connectType);
		else onClose();
	};

	return (
		<>
			<header className="flex items-center justify-between border-b border-nova-border px-5 py-3.5">
				<div className="flex items-center gap-3">
					<Dialog.Title className="text-base font-display font-semibold text-nova-text">
						CommCare Connect
					</Dialog.Title>
					{/* Mode selector — picks the view (active mode = live, other =
					 *  staging). The dot marks the app's active mode. */}
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
										onChange={() => selectMode(mode)}
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
						: isLive
							? "Turn forms on or off and edit their Connect details below."
							: enabled
								? `Set up ${modeLabel(selectedMode)} for the forms that should take part, then switch. Your ${modeLabel(connectType)} setup is kept.`
								: `Pick which forms take part as ${modeLabel(selectedMode)} and fill them in. Forms you leave off stay out.`}
				</p>

				{isLive
					? forms.map((f) => (
							<ConnectSection
								key={f.formUuid}
								moduleUuid={f.moduleUuid}
								formUuid={f.formUuid}
								heading={
									<div className="text-xs font-medium text-nova-text">
										{f.formName}
										<span className="font-normal text-nova-text-muted">
											{" "}
											· {f.moduleName}
										</span>
									</div>
								}
							/>
						))
					: forms.map((f) => (
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
									draft={stagingDraftFor(f.formUuid)}
									onPatch={(patch) => patchStaging(f.formUuid, patch)}
								/>
							</div>
						))}
			</div>

			<div className="space-y-2 border-t border-nova-border px-5 py-3">
				{rejectionMessages.length > 0 && (
					/* The gate refused — the drafts above are intact; each finding
					 * reads in the shared rejection anatomy. */
					<div className="space-y-2 rounded-md border border-nova-rose/15 bg-nova-rose/[0.06] px-2.5 py-2">
						{rejectionMessages.map((m) => (
							<RejectionBody key={m} message={m} label={null} />
						))}
					</div>
				)}
				{isLive ? (
					<div className="flex items-center justify-between gap-3">
						<button
							type="button"
							onClick={turnOff}
							className="cursor-pointer text-[11px] font-medium text-nova-rose/80 transition-colors hover:text-nova-rose"
						>
							Turn off Connect
						</button>
						<button
							type="button"
							onClick={onClose}
							className="rounded-lg bg-nova-violet px-3 py-1.5 text-xs font-medium text-white transition-colors cursor-pointer hover:brightness-110"
						>
							Done
						</button>
					</div>
				) : (
					<div className="flex items-center justify-end gap-3">
						<span className="mr-auto text-[11px] text-nova-text-muted">
							{stagingHint}
						</span>
						<button
							type="button"
							onClick={cancelStaging}
							className="cursor-pointer rounded-lg border border-nova-border px-3 py-1.5 text-xs font-medium text-nova-text-secondary transition-colors hover:text-nova-text"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={applySwitch}
							disabled={!canApply}
							className="rounded-lg bg-nova-violet px-3 py-1.5 text-xs font-medium text-white transition-colors enabled:cursor-pointer enabled:hover:brightness-110 disabled:opacity-40"
						>
							{primaryLabel}
						</button>
					</div>
				)}
			</div>
		</>
	);
}
