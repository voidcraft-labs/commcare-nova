"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";
import {
	ConnectEnableDialog,
	type ConnectStagingTarget,
} from "@/components/builder/detail/appSettings/ConnectEnableDialog";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { Switch } from "@/components/shadcn/switch";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useConnectTypeOrUndefined } from "@/lib/doc/hooks/useConnectType";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import { asUuid } from "@/lib/doc/types";
import type {
	ConnectConfig,
	ConnectDeliverConfig,
	ConnectLearnConfig,
} from "@/lib/domain";
import { CONNECT_TYPE_LABELS } from "@/lib/domain";
import { useFormConnectStash, useSwitchConnectMode } from "@/lib/session/hooks";
import { DeliverConfig } from "./DeliverConfig";
import { LearnConfig } from "./LearnConfig";
import type { FormSettingsSectionProps } from "./types";

/**
 * Connect-mode configuration section: only rendered when the app has a
 * connect type set. Owns:
 *
 * 1. The per-form Connect PARTICIPATION toggle. A connect block opts the
 *    form into Connect; a form without one is auxiliary and ships
 *    nothing Connect-side. Either direction rebuilds the complete live
 *    participant map and sends it through the same app-wide exact-target
 *    planner as the manager: participation has one owner. OFF stashes the
 *    dropped block through that owner and clears it, while the last
 *    participant is rejected. ON restores a stashed block only when the
 *    exact saved value still passes the app-wide gate. A conflict refuses
 *    the restore and opens the editor with the finding; Nova never renames
 *    an explicit id. Otherwise the same
 *    collect-before-commit dialog the app-level enable flow uses gathers
 *    this one form's block FROM THE USER. Nothing is pre-filled: a
 *    block's names and descriptions are content the user writes, not
 *    placeholders Nova invents.
 * 2. Dispatch to `LearnConfig` or `DeliverConfig` based on the app's
 *    connect type. The sub-configs are structurally parallel (two
 *    independent sub-toggles each) but have distinct field shapes.
 *
 * The `save` callback passed to sub-configs writes the ConnectConfig
 * wholesale: sub-configs always spread the current connect object so
 * the other half's state round-trips through this single mutation path.
 */
export function ConnectSection({
	moduleUuid,
	formUuid,
}: FormSettingsSectionProps) {
	const form = useForm(formUuid);
	const mod = useModule(moduleUuid);
	/* Inline flavor throughout: every rejection in this section has a
	 * contextual surface: the sub-config editors keep refused drafts with
	 * the finding, the staging dialog shows findings in its footer, and a
	 * refused toggle-off renders its notice right under the toggle row. */
	const { inline } = useBlueprintMutations();
	const docApi = useBlueprintDocApi();
	const switchMode = useSwitchConnectMode();
	const connectType = useConnectTypeOrUndefined();
	const connect = form?.connect;
	const enabled = !!connect;
	/** The in-flight staged enable; `rejectionMessages` carries the gate
	 *  findings from a bounced confirm so the dialog explains itself. */
	const [staging, setStaging] = useState<
		{ rejectionMessages: string[] } | undefined
	>();
	/** The gate's finding from a refused toggle-OFF (removing the app's
	 *  last participating form's block): rendered under the toggle row,
	 *  cleared on the next toggle gesture. */
	const [disableRejection, setDisableRejection] = useState<string | null>(null);

	/* Session stash: a block stashed here (or by an app-level mode
	 * switch) restores when the user toggles participation back on. */
	const stashedConfig = useFormConnectStash(connectType ?? "learn", formUuid);
	const save = useCallback(
		(config: ConnectConfig | null) => {
			if (!connectType) {
				return {
					ok: false as const,
					messages: ["CommCare Connect is not enabled for this app."],
				};
			}
			// Updating the body of an existing participant is the one
			// form-scoped Connect edit. Adding/removing participation is an
			// app-wide target replacement: read the doc imperatively inside the
			// event (no render subscription), preserve every other live block,
			// and let switchConnectMode plan/gate the complete set once.
			if (connect && config !== null) {
				return inline.refineFormConnect(asUuid(formUuid), config);
			}
			const desiredBlocks: Record<string, ConnectConfig> = {};
			for (const [uuid, candidate] of Object.entries(docApi.getState().forms)) {
				if (candidate?.connect) desiredBlocks[uuid] = candidate.connect;
			}
			if (config === null) delete desiredBlocks[formUuid];
			else desiredBlocks[formUuid] = config;
			return switchMode(connectType, desiredBlocks, { announce: false });
		},
		[connect, connectType, docApi, formUuid, inline, switchMode],
	);

	const toggle = useCallback(() => {
		if (!connectType) return;
		setDisableRejection(null);

		if (enabled) {
			// Toggle-off is a complete participant-set replacement. The shared
			// session action stashes dropped live blocks only after commit.
			const outcome = save(null);
			if (!outcome.ok) {
				setDisableRejection(outcome.messages[0] ?? null);
			}
			return;
		}

		// Toggle-on. Propose a stashed config exactly as the user authored it.
		// If its id was claimed while inactive, the app-wide planner refuses
		// the complete target; keep the exact stash and open the editor with
		// the finding. No restore path silently rewrites an explicit id. With
		// no stash, the user writes the block in the same staging dialog the
		// app-level enable flow uses, scoped to this one form.
		if (stashedConfig) {
			const outcome = save(stashedConfig);
			if (!outcome.ok) {
				setStaging({ rejectionMessages: outcome.messages });
			}
			return;
		}
		setStaging({ rejectionMessages: [] });
	}, [enabled, connectType, stashedConfig, save]);

	const confirmStaging = useCallback(
		(blocks: Record<string, ConnectConfig>) => {
			const block = blocks[formUuid];
			if (!block) return;
			const outcome = save(block);
			if (outcome.ok) {
				setStaging(undefined);
				return;
			}
			/* The gate refused: keep the dialog (and the user's drafts) on
			 * screen with the findings inline, so the bounce explains itself. */
			setStaging({ rejectionMessages: outcome.messages });
		},
		[save, formUuid],
	);

	if (!connectType) return null;
	if (
		connect &&
		((connectType === "learn" &&
			!("learn_module" in connect || "assessment" in connect)) ||
			(connectType === "deliver" &&
				!("deliver_unit" in connect || "task" in connect)))
	) {
		throw new Error(
			"Stored Connect configuration does not match the app mode.",
		);
	}
	const learnConnect =
		connect && ("learn_module" in connect || "assessment" in connect)
			? (connect as ConnectLearnConfig)
			: undefined;
	const deliverConnect =
		connect && ("deliver_unit" in connect || "task" in connect)
			? (connect as ConnectDeliverConfig)
			: undefined;

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
					<span className="text-xs font-medium text-nova-text-secondary">
						Connect
					</span>
					<span className="h-[18px] px-1.5 text-[10px] font-medium rounded-full bg-nova-violet/10 text-nova-violet-bright border border-nova-violet/20 flex items-center">
						{CONNECT_TYPE_LABELS[connectType]}
					</span>
				</div>
				<Switch checked={enabled} onCheckedChange={toggle} />
			</div>

			{/* A refused toggle-off explains itself where the gesture happened:
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
							{/* Learn config: sub-toggles for learn_module and assessment */}
							{connectType === "learn" && learnConnect && (
								<LearnConfig
									connect={learnConnect}
									save={save}
									moduleUuid={moduleUuid}
									formUuid={formUuid}
								/>
							)}

							{/* Deliver config: sub-toggles for deliver_unit and task */}
							{connectType === "deliver" && deliverConnect && (
								<DeliverConfig
									connect={deliverConnect}
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
