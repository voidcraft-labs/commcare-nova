"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback } from "react";
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
import { DEFAULT_LEARN_TIME_ESTIMATE, LearnConfig } from "./LearnConfig";
import type { FormSettingsSectionProps } from "./types";

/**
 * Connect-mode configuration section — only rendered when the app has a
 * connect type set. Owns:
 *
 * 1. The app-level Connect toggle. Flipping it off stashes the current
 *    config keyed by form uuid so flipping it back on restores the
 *    user's work rather than regenerating a default. The stash lives in
 *    session state (ephemeral) so it survives toggle round-trips within
 *    a session but doesn't persist cross-session.
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
	// App-wide connect ids so the seed below derives unique ids by
	// construction — the toggle is a source, like LearnConfig/DeliverConfig.
	const appConnectIds = useAppConnectIds();

	/* Session hooks for connect stash — keyed by form uuid so the stash
	 * remains stable across reorders and renames. */
	const stashFormConnect = useStashFormConnect();
	const stashedConfig = useFormConnectStash(connectType ?? "learn", formUuid);

	const save = useCallback(
		(config: ConnectConfig | null) => {
			updateFormAction(asUuid(formUuid), {
				connect: config ?? undefined,
			});
		},
		[updateFormAction, formUuid],
	);

	const toggle = useCallback(() => {
		if (enabled) {
			/* Stash the current config before clearing, so re-enabling
			 * restores it instead of generating a new default. */
			if (connect && connectType) {
				stashFormConnect(connectType, formUuid, connect);
			}
			save(null);
			return;
		}
		if (!connectType) return;

		// Toggle-on. Either restore the stashed config or seed a fresh pair of
		// id-less blocks — both flow through `dedupeRestoredConnectIds`, the
		// single source-enforcement path. It fills the seed's absent ids from
		// the entity names (exactly as creation-time autofill would) and
		// re-derives any stashed id that drifted into a collision while Connect
		// was off, so a restore can never write a duplicate. Routing seed and
		// restore through one path keeps them from drifting apart.
		const name = form?.name ?? "";
		const config: ConnectConfig =
			stashedConfig ??
			(connectType === "learn"
				? {
						learn_module: {
							name,
							description: name,
							time_estimate: DEFAULT_LEARN_TIME_ESTIMATE,
						},
						assessment: { user_score: "100" },
					}
				: {
						deliver_unit: {
							name,
							entity_id: "concat(#user/username, '-', today())",
							entity_name: "#user/username",
						},
						task: { name, description: name },
					});
		save(
			dedupeRestoredConnectIds(config, {
				formUuid,
				appConnectIds,
				moduleName: mod?.name ?? "",
				formName: name,
			}),
		);
	}, [
		enabled,
		connect,
		connectType,
		stashFormConnect,
		stashedConfig,
		mod,
		form,
		formUuid,
		appConnectIds,
		save,
	]);

	if (!connectType) return null;

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
		</div>
	);
}
