"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";
import {
	ConnectEnableDialog,
	type ConnectStagingTarget,
} from "@/components/builder/detail/appSettings/ConnectEnableDialog";
import { Toggle } from "@/components/ui/Toggle";
import { dedupeRestoredConnectIds } from "@/lib/doc/connectConfig";
import { useAppConnectIds } from "@/lib/doc/hooks/useAppConnectIds";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useConnectTypeOrUndefined } from "@/lib/doc/hooks/useConnectType";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import { asUuid } from "@/lib/doc/types";
import type { ConnectConfig } from "@/lib/domain";
import { useFormConnectStash } from "@/lib/session/hooks";
import { DeliverConfig } from "./DeliverConfig";
import { LearnConfig } from "./LearnConfig";
import type { FormSettingsSectionProps } from "./types";

/**
 * Connect-mode configuration section — only rendered when the app has a
 * connect type set. Owns:
 *
 * 1. The per-form Connect toggle. Its OFF direction is permanently
 *    closed on a Connect-typed app: every form must carry its block, so
 *    removing one introduces a finding the gate rejects — the toggle
 *    renders DISABLED with that reason rather than as a live control
 *    that always bounces (disable Connect for the whole app in App
 *    Settings instead). The ON direction stays live for a form that's
 *    missing its block (a doc persisted before the per-form obligation):
 *    a block stashed by an app-level mode switch restores silently — it
 *    is the user's own prior work — and otherwise the same
 *    collect-before-commit dialog the app-level enable flow uses gathers
 *    this one form's block FROM THE USER. Nothing is pre-filled: a
 *    block's names and descriptions are content the user writes, not
 *    placeholders Nova invents.
 * 2. Dispatch to `LearnConfig` or `DeliverConfig` based on the app's
 *    connect type. The sub-configs are structurally parallel (two
 *    independent sub-toggles each) but have distinct field shapes.
 *
 * The `save` callback passed to sub-configs writes the ConnectConfig
 * wholesale — sub-configs always spread the current connect object so
 * the other half's state round-trips through this single mutation path.
 */
export function ConnectSection({
	moduleUuid,
	formUuid,
}: FormSettingsSectionProps) {
	const form = useForm(formUuid);
	const mod = useModule(moduleUuid);
	const { updateForm: updateFormAction } = useBlueprintMutations();
	const connectType = useConnectTypeOrUndefined();
	const connect = form?.connect;
	const enabled = !!connect;
	// App-wide connect ids so a restored/collected block's ids derive
	// unique by construction — the toggle is a source, like
	// LearnConfig/DeliverConfig.
	const appConnectIds = useAppConnectIds();
	/** The in-flight staged enable; `rejectionMessages` carries the gate
	 *  findings from a bounced confirm so the dialog explains itself. */
	const [staging, setStaging] = useState<
		{ rejectionMessages: string[] } | undefined
	>();

	/* Session stash read — a block stashed by an app-level mode switch
	 * restores here when the user re-adds a missing form's block. */
	const stashedConfig = useFormConnectStash(connectType ?? "learn", formUuid);

	const save = useCallback(
		(config: ConnectConfig | null) => {
			// Forward the gated outcome so sub-config editors keep a refused
			// draft on screen with the finding.
			return updateFormAction(asUuid(formUuid), {
				connect: config ?? undefined,
			});
		},
		[updateFormAction, formUuid],
	);

	const toggle = useCallback(() => {
		/* The OFF direction never reaches here — the toggle renders
		 * disabled while a block is present (see the JSX below). */
		if (enabled || !connectType) return;

		// Toggle-on. A stashed config is the user's own prior work for this
		// mode — restore it through `dedupeRestoredConnectIds`, the single
		// source-enforcement path (a stashed id another form claimed while
		// Connect was off re-derives instead of landing a duplicate). With
		// no stash, the user writes the block: open the same staging dialog
		// the app-level enable flow uses, scoped to this one form.
		if (stashedConfig) {
			save(
				dedupeRestoredConnectIds(stashedConfig, {
					formUuid,
					appConnectIds,
					moduleName: mod?.name ?? "",
					formName: form?.name ?? "",
				}),
			);
			return;
		}
		setStaging({ rejectionMessages: [] });
	}, [
		enabled,
		connectType,
		stashedConfig,
		mod,
		form,
		formUuid,
		appConnectIds,
		save,
	]);

	const confirmStaging = useCallback(
		(blocks: Record<string, ConnectConfig>) => {
			const block = blocks[formUuid];
			if (!block) return;
			const outcome = save(
				dedupeRestoredConnectIds(block, {
					formUuid,
					appConnectIds,
					moduleName: mod?.name ?? "",
					formName: form?.name ?? "",
				}),
			);
			if (outcome.ok) {
				setStaging(undefined);
				return;
			}
			/* The gate refused — keep the dialog (and the user's drafts) on
			 * screen with the findings inline, so the bounce explains itself. */
			setStaging({ rejectionMessages: outcome.messages });
		},
		[save, formUuid, appConnectIds, mod, form],
	);

	if (!connectType) return null;

	const stagingTargets: ConnectStagingTarget[] = [
		{
			formUuid,
			formName: form?.name ?? "",
			moduleName: mod?.name ?? "",
		},
	];

	return (
		<div className="border-t border-white/[0.06] pt-3">
			{/* Header row with toggle */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider">
						Connect
					</span>
					<span className="h-[18px] px-1.5 text-[10px] font-medium rounded bg-nova-violet/10 text-nova-violet-bright border border-nova-violet/20 flex items-center capitalize">
						{connectType}
					</span>
				</div>
				<Toggle
					enabled={enabled}
					onToggle={toggle}
					disabled={enabled}
					disabledReason="Every form in a Connect app carries its Connect settings. To turn Connect off, switch it off for the whole app in App Settings."
				/>
			</div>
			{enabled && (
				<p className="pt-1.5 text-[10px] leading-snug text-nova-text-muted">
					Every form in a Connect app keeps its Connect settings — turn Connect
					off for the whole app in App Settings.
				</p>
			)}

			<AnimatePresence>
				{connect && (
					<motion.div
						initial={{ opacity: 0, height: 0 }}
						animate={{ opacity: 1, height: "auto" }}
						exit={{ opacity: 0, height: 0 }}
						transition={{ duration: 0.15, ease: "easeOut" }}
						className="overflow-hidden"
					>
						<div className="pt-2.5 space-y-3">
							{/* Learn config — sub-toggles for learn_module and assessment */}
							{connectType === "learn" && (
								<LearnConfig
									connect={connect}
									save={save}
									moduleUuid={moduleUuid}
									formUuid={formUuid}
								/>
							)}

							{/* Deliver config — sub-toggles for deliver_unit and task */}
							{connectType === "deliver" && (
								<DeliverConfig
									connect={connect}
									save={save}
									moduleUuid={moduleUuid}
									formUuid={formUuid}
								/>
							)}
						</div>
					</motion.div>
				)}
			</AnimatePresence>

			{staging && (
				<ConnectEnableDialog
					mode={connectType}
					targets={stagingTargets}
					rejectionMessages={staging.rejectionMessages}
					onCancel={() => setStaging(undefined)}
					onConfirm={confirmStaging}
				/>
			)}
		</div>
	);
}
