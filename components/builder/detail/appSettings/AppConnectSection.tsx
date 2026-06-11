"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";
import { Toggle } from "@/components/ui/Toggle";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useConnectTypeOrUndefined } from "@/lib/doc/hooks/useConnectType";
import type { ConnectConfig, ConnectType } from "@/lib/domain";
import { useLastConnectType, useSwitchConnectMode } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import {
	ConnectEnableDialog,
	type ConnectStagingTarget,
} from "./ConnectEnableDialog";

/**
 * App-level CommCare Connect section in the App Settings panel. Mirrors the
 * form-level `ConnectSection`'s layout (header row with a Toggle, an
 * animated reveal beneath), but owns the APP's connect *type* rather than
 * a per-form config:
 *
 *   - Toggle off dispatches `null`, clearing the app connect type —
 *     always valid (standard apps carry no blocks; the stash preserves
 *     the per-form work for a later re-enable).
 *   - Toggle on (and the learn / deliver pills) runs the STAGED enable
 *     flow: Connect lands as one atomic batch — `setConnectType` plus
 *     each participating form's connect block — so before anything
 *     commits, the flow restores each form's stashed block and lets the
 *     user pick which remaining forms participate (and fill their
 *     blocks) in `ConnectEnableDialog`. Forms left unpicked stay
 *     auxiliary and need nothing; the gate only insists at least one
 *     form participates.
 */

/** The in-flight enable request: the resolved mode, the forms the stash
 *  doesn't cover (the user picks which of them participate), how many
 *  forms restore from the stash (they participate without appearing in
 *  the dialog), and any gate findings from a bounced confirm. */
interface StagingState {
	mode: ConnectType;
	targets: ConnectStagingTarget[];
	restoredFormCount: number;
	rejectionMessages: string[];
}

export function AppConnectSection() {
	const connectType = useConnectTypeOrUndefined();
	const lastConnectType = useLastConnectType();
	const switchMode = useSwitchConnectMode();
	const docApi = useBlueprintDocApi();
	const sessionApi = useBuilderSessionApi();
	const [staging, setStaging] = useState<StagingState | undefined>();
	const enabled = !!connectType;

	/** Enable Connect in `target` mode (or the last-used mode). Commits
	 *  directly when the stash covers every form; otherwise opens the
	 *  staging dialog so the user picks which uncovered forms participate
	 *  and fills their blocks. */
	const requestMode = useCallback(
		(target: ConnectType | undefined) => {
			const mode = target ?? lastConnectType ?? "learn";
			const doc = docApi.getState();
			const stash = sessionApi.getState().connectStash[mode] ?? {};
			const targets: ConnectStagingTarget[] = [];
			let restoredFormCount = 0;
			for (const moduleUuid of doc.moduleOrder) {
				for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
					if (stash[formUuid]) {
						restoredFormCount++;
						continue;
					}
					targets.push({
						formUuid,
						formName: doc.forms[formUuid]?.name ?? "",
						moduleName: doc.modules[moduleUuid]?.name ?? "",
					});
				}
			}
			if (targets.length === 0) {
				/* Every form restores from the stash — commit directly. A
				 * rejection surfaces through the standard rejection toast. */
				switchMode(mode);
				return;
			}
			setStaging({ mode, targets, restoredFormCount, rejectionMessages: [] });
		},
		[lastConnectType, docApi, sessionApi, switchMode],
	);

	const confirmStaging = useCallback(
		(blocks: Record<string, ConnectConfig>) => {
			if (!staging) return;
			const outcome = switchMode(staging.mode, blocks);
			if (outcome.ok) {
				setStaging(undefined);
				return;
			}
			/* The gate refused — keep the dialog (and the user's drafts) on
			 * screen with the findings inline, so the bounce explains itself. */
			setStaging({ ...staging, rejectionMessages: outcome.messages });
		},
		[staging, switchMode],
	);

	return (
		<div className="border-t border-white/[0.06] pt-3">
			{/* Header row: label + active-mode badge + enable/disable toggle. */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider">
						CommCare Connect
					</span>
					{connectType && (
						<span className="h-[18px] px-1.5 text-[10px] font-medium rounded bg-nova-violet/10 text-nova-violet-bright border border-nova-violet/20 flex items-center capitalize">
							{connectType}
						</span>
					)}
				</div>
				{/* Off is one always-valid commit; on runs the staged flow. */}
				<Toggle
					enabled={enabled}
					onToggle={() => {
						if (enabled) switchMode(null);
						else requestMode(undefined);
					}}
				/>
			</div>

			<AnimatePresence>
				{enabled && (
					<motion.div
						initial={{ opacity: 0, height: 0 }}
						animate={{ opacity: 1, height: "auto" }}
						exit={{ opacity: 0, height: 0 }}
						transition={{ duration: 0.15, ease: "easeOut" }}
						className="overflow-hidden"
					>
						<div
							className="flex items-center gap-1.5 pt-2.5"
							role="radiogroup"
							aria-label="Connect type"
						>
							{(["learn", "deliver"] as const).map((type) => {
								const isActive = connectType === type;
								return (
									<label
										key={type}
										className={`flex items-center h-[22px] px-2 text-[11px] font-medium rounded-full border outline-none transition-all duration-200 cursor-pointer ${
											isActive
												? "bg-nova-violet/10 border-nova-violet/30 text-nova-violet-bright shadow-[0_0_6px_rgba(139,92,246,0.1)]"
												: "bg-nova-surface border-nova-border/60 text-nova-text-muted hover:border-nova-violet/50 hover:text-nova-text-secondary"
										}`}
									>
										<input
											type="radio"
											name="app-connect-type"
											value={type}
											checked={isActive}
											onChange={() => requestMode(type)}
											className="sr-only"
										/>
										{type.charAt(0).toUpperCase() + type.slice(1)}
									</label>
								);
							})}
						</div>
					</motion.div>
				)}
			</AnimatePresence>

			{staging && (
				<ConnectEnableDialog
					mode={staging.mode}
					targets={staging.targets}
					restoredFormCount={staging.restoredFormCount}
					rejectionMessages={staging.rejectionMessages}
					onCancel={() => setStaging(undefined)}
					onConfirm={confirmStaging}
				/>
			)}
		</div>
	);
}
