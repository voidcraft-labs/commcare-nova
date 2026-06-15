"use client";
import { Dialog } from "@base-ui/react/dialog";
import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import { useState } from "react";
import { RejectionBody } from "@/components/builder/RejectionNotice";
import { parseXPathForForm } from "@/lib/doc/expressionText";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useConnectTypeOrUndefined } from "@/lib/doc/hooks/useConnectType";
import type { BlueprintDoc } from "@/lib/domain";
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
 * Connect" button:
 *
 *   - switch the app between Learn and Deliver in-place (the segmented
 *     control is pure draft navigation — only the primary button commits);
 *   - pick which forms participate and edit each participating form's core
 *     content (name / description / time), reusing the per-form sub-config
 *     cards;
 *   - turn Connect off entirely.
 *
 * Everything commits as ONE gated batch through `switchConnectMode`, which
 * treats the collected blocks as the authoritative participating set: the
 * gate still refuses a state that leaves the app with no participating form
 * of its mode, and the findings render inline rather than as a toast.
 *
 * The advanced per-form slots the cards don't expose (sub-config ids, the
 * `user_score` / `entity_id` / `entity_name` XPaths) ride through the draft
 * untouched (`configToDraft` captures them, `draftToConfig` re-emits them),
 * so editing a name here never drops an expression or re-slugs an id —
 * those live in each form's own settings panel.
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

/** The mount-time snapshot: the form list plus a draft per form per mode,
 *  seeded from the live doc (the current mode) and the session stash (the
 *  inactive mode). Captured once so editing never fights a doc subscription
 *  mid-session — the manager applies one batch and closes. */
function seedManager(
	doc: BlueprintDoc,
	stash: Record<ConnectType, Record<string, ConnectConfig>>,
	currentType: ConnectType | undefined,
): {
	forms: FormRow[];
	drafts: Record<ConnectType, Record<string, BlockDraft>>;
} {
	const forms: FormRow[] = [];
	const drafts: Record<ConnectType, Record<string, BlockDraft>> = {
		learn: {},
		deliver: {},
	};
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			forms.push({
				formUuid,
				formName: doc.forms[formUuid]?.name ?? "",
				moduleName: doc.modules[moduleUuid]?.name ?? "",
			});
			const live = doc.forms[formUuid]?.connect;
			for (const mode of CONNECT_TYPES) {
				/* The active mode's block lives on the doc; the inactive mode's
				 * is whatever the user last had (the stash). */
				const src = currentType === mode ? live : stash[mode]?.[formUuid];
				drafts[mode][formUuid] = src ? configToDraft(src) : EMPTY_DRAFT;
			}
		}
	}
	return { forms, drafts };
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
 *  only while open and the per-form drafts start fresh each time. */
function ManagerBody({ onClose }: { onClose: () => void }) {
	const connectType = useConnectTypeOrUndefined();
	const lastConnectType = useLastConnectType();
	const switchMode = useSwitchConnectMode();
	const docApi = useBlueprintDocApi();
	const sessionApi = useBuilderSessionApi();

	const enabled = !!connectType;

	const [{ forms, drafts: seededDrafts }] = useState(() =>
		seedManager(
			docApi.getState(),
			sessionApi.getState().connectStash,
			connectType,
		),
	);
	const [drafts, setDrafts] =
		useState<Record<ConnectType, Record<string, BlockDraft>>>(seededDrafts);
	const [selectedMode, setSelectedMode] = useState<ConnectType>(
		connectType ?? lastConnectType ?? "learn",
	);
	const [rejectionMessages, setRejectionMessages] = useState<string[]>([]);

	const patchDraft = (
		mode: ConnectType,
		formUuid: string,
		patch: Partial<BlockDraft>,
	) => {
		setDrafts((prev) => ({
			...prev,
			[mode]: {
				...prev[mode],
				[formUuid]: { ...(prev[mode][formUuid] ?? EMPTY_DRAFT), ...patch },
			},
		}));
	};

	const modeDrafts = drafts[selectedMode];
	const draftFor = (formUuid: string) => modeDrafts[formUuid] ?? EMPTY_DRAFT;
	const sectionsComplete = forms.every((f) =>
		draftSectionsComplete(draftFor(f.formUuid), selectedMode),
	);
	const participatingCount = forms.filter((f) =>
		draftParticipates(draftFor(f.formUuid), selectedMode),
	).length;
	/* An app with no forms can still flip Connect on as the bare type change
	 * (the participation floor binds only once forms exist) — otherwise the
	 * primary stays gated on a real participant. */
	const canApply =
		forms.length === 0 || (sectionsComplete && participatingCount >= 1);

	const isCurrentMode = connectType === selectedMode;
	const modeLabel = (m: ConnectType) => (m === "learn" ? "Learn" : "Deliver");
	const primaryLabel = !enabled
		? "Enable Connect"
		: isCurrentMode
			? "Apply changes"
			: `Switch to ${modeLabel(selectedMode)}`;

	const hint = !sectionsComplete
		? "Finish the sections you've turned on."
		: participatingCount < 1 && forms.length > 0
			? "Turn on a section for at least one form."
			: !enabled
				? "Ready to enable."
				: isCurrentMode
					? "Apply your changes."
					: `Ready to switch to ${modeLabel(selectedMode)}.`;

	const apply = () => {
		const doc = docApi.getState();
		const blocks: Record<string, ConnectConfig> = Object.fromEntries(
			forms
				.filter((f) => draftParticipates(draftFor(f.formUuid), selectedMode))
				.map((f) => [
					f.formUuid,
					draftToConfig(draftFor(f.formUuid), selectedMode, (text) =>
						parseXPathForForm(doc, asUuid(f.formUuid), text),
					),
				]),
		);
		const outcome = switchMode(selectedMode, blocks, { announce: false });
		if (outcome.ok) {
			onClose();
			return;
		}
		setRejectionMessages(outcome.messages);
	};

	const turnOff = () => {
		/* Disabling is always valid (the stash preserves each mode's work),
		 * so this never bounces — but route a hypothetical finding inline for
		 * symmetry rather than letting it announce. */
		const outcome = switchMode(null, undefined, { announce: false });
		if (outcome.ok) onClose();
		else setRejectionMessages(outcome.messages);
	};

	return (
		<>
			<header className="flex items-center justify-between border-b border-nova-border px-5 py-3.5">
				<div className="flex items-center gap-3">
					<Dialog.Title className="text-base font-display font-semibold text-nova-text">
						CommCare Connect
					</Dialog.Title>
					{/* Mode selector — pure draft navigation; only the primary
					 *  button commits a flip. */}
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
						? "This app has no forms yet. You can turn Connect on now and set up which forms take part once you add them."
						: isCurrentMode && enabled
							? "Turn forms on or off and edit their details. Each form's advanced settings live in its own panel."
							: `Pick which forms take part as ${modeLabel(selectedMode)} and fill them in. Forms you leave off stay out — you can add them later from each form's settings.`}
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
							draft={draftFor(f.formUuid)}
							onPatch={(patch) => patchDraft(selectedMode, f.formUuid, patch)}
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
						<div className="flex gap-2">
							<button
								type="button"
								onClick={onClose}
								className="cursor-pointer rounded-lg border border-nova-border px-3 py-1.5 text-xs font-medium text-nova-text-secondary transition-colors hover:text-nova-text"
							>
								Cancel
							</button>
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
			</div>
		</>
	);
}
