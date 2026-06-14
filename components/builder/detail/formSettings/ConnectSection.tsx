"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";
import {
	ConnectEnableDialog,
	type ConnectStagingTarget,
} from "@/components/builder/detail/appSettings/ConnectEnableDialog";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { Toggle } from "@/components/ui/Toggle";
import { dedupeRestoredConnectIds } from "@/lib/doc/connectConfig";
import { useAppConnectIds } from "@/lib/doc/hooks/useAppConnectIds";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useConnectTypeOrUndefined } from "@/lib/doc/hooks/useConnectType";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import { asUuid } from "@/lib/doc/types";
import type { ConnectConfig } from "@/lib/domain";
import { useFormConnectStash, useStashFormConnect } from "@/lib/session/hooks";
import { DeliverConfig } from "./DeliverConfig";
import { LearnConfig } from "./LearnConfig";
import type { FormSettingsSectionProps } from "./types";

/**
 * Connect-mode configuration section — only rendered when the app has a
 * connect type set. Owns:
 *
 * 1. The per-form Connect PARTICIPATION toggle. A connect block opts the
 *    form into Connect; a form without one is auxiliary and ships
 *    nothing Connect-side, so both directions are ordinary gated edits.
 *    OFF stashes the block (the user's work survives a round-trip) and
 *    clears it — legal unless this is the app's LAST participating form,
 *    in which case the gate bounces with the app-level finding naming
 *    the alternatives (make another form participate, or turn Connect
 *    off for the whole app). ON restores a stashed block silently — it
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
	/* Inline flavor throughout: every rejection in this section has a
	 * contextual surface — the sub-config editors keep refused drafts with
	 * the finding, the staging dialog shows findings in its footer, and a
	 * refused toggle-off renders its notice right under the toggle row. */
	const { inline } = useBlueprintMutations();
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
	/** The gate's finding from a refused toggle-OFF (removing the app's
	 *  last participating form's block) — rendered under the toggle row,
	 *  cleared on the next toggle gesture. */
	const [disableRejection, setDisableRejection] = useState<string | null>(null);

	/* Session stash — a block stashed here (or by an app-level mode
	 * switch) restores when the user toggles participation back on. */
	const stashedConfig = useFormConnectStash(connectType ?? "learn", formUuid);
	const stashFormConnect = useStashFormConnect();

	const save = useCallback(
		(config: ConnectConfig | null) => {
			// Forward the gated outcome so sub-config editors keep a refused
			// draft on screen with the finding.
			return inline.updateForm(asUuid(formUuid), {
				connect: config ?? undefined,
			});
		},
		[inline, formUuid],
	);

	const toggle = useCallback(() => {
		if (!connectType) return;
		setDisableRejection(null);

		if (enabled) {
			// Toggle-off: an ordinary gated edit. Removing the app's LAST
			// participating form's block bounces with the app-level finding,
			// shown right under the toggle row; otherwise the form simply
			// stops participating. The block is stashed only after the
			// commit lands so toggling back on restores the user's work.
			const removed = connect;
			const outcome = save(null);
			if (outcome.ok) {
				if (removed) stashFormConnect(connectType, formUuid, removed);
			} else {
				setDisableRejection(outcome.messages[0] ?? null);
			}
			return;
		}

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
		connect,
		connectType,
		stashedConfig,
		stashFormConnect,
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
				<Toggle enabled={enabled} onToggle={toggle} />
			</div>

			{/* A refused toggle-off explains itself where the gesture happened —
			 * the label keeps the toggle's own vocabulary. */}
			<RejectionInline message={disableRejection} label="Still participating" />

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

			{/* Always mounted so Base UI animates open AND close; a single
			 *  form is the only target, never stash-restored. */}
			<ConnectEnableDialog
				request={
					staging
						? {
								mode: connectType,
								targets: stagingTargets,
								restoredFormCount: 0,
								rejectionMessages: staging.rejectionMessages,
							}
						: undefined
				}
				onCancel={() => setStaging(undefined)}
				onConfirm={confirmStaging}
			/>
		</div>
	);
}
