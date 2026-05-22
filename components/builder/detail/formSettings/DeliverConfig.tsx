"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useRef } from "react";
import { Toggle } from "@/components/ui/Toggle";
import { deriveConnectId } from "@/lib/commcare/connectSlugs";
import { dedupeRestoredConnectIds } from "@/lib/doc/connectConfig";
import {
	connectIdsExcept,
	useAppConnectIds,
} from "@/lib/doc/hooks/useAppConnectIds";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import type { Uuid } from "@/lib/doc/types";
import type { ConnectConfig } from "@/lib/domain";
import { InlineField } from "./InlineField";
import { LabeledXPathField } from "./LabeledXPathField";
import { useConnectLintContext } from "./useConnectLintContext";

/**
 * Shared prop contract mirroring LearnConfig's — declared locally so each
 * sub-config file owns its contract rather than importing from a sibling.
 */
interface ConnectSubConfigProps {
	connect: ConnectConfig;
	save: (c: ConnectConfig) => void;
	moduleUuid: Uuid;
	formUuid: Uuid;
}

/**
 * Deliver-mode connect sub-config: two independent sub-toggles for the
 * `deliver_unit` and `task` halves of a Connect deliver app. Structurally
 * parallel to LearnConfig — each sub-toggle remembers the last populated
 * value in a ref so off+on restores rather than resets. Default ids for
 * the entity_id / entity_name XPaths seed from `#user/username` because
 * delivery entries are typically per-FLW-per-day.
 */
export function DeliverConfig({
	connect,
	save,
	moduleUuid,
	formUuid,
}: ConnectSubConfigProps) {
	const mod = useModule(moduleUuid);
	const form = useForm(formUuid);
	const du = connect.deliver_unit;
	const task = connect.task;
	const deliverEnabled = !!du;
	const taskEnabled = !!task;
	const lastDeliverRef = useRef(du);
	const lastTaskRef = useRef(task);
	if (du) lastDeliverRef.current = du;
	if (task) lastTaskRef.current = task;
	const getLintContext = useConnectLintContext(formUuid);

	// Name-derived defaults for a freshly enabled sub-config, unique against
	// every other connect id in the app (connect ids share one app-wide
	// namespace). Same `deriveConnectId` + scope the SA path uses.
	const appConnectIds = useAppConnectIds();
	const defaultIds = useCallback(() => {
		const modName = mod?.name ?? "";
		const pairName = `${modName} ${form?.name ?? ""}`;
		const deliverId = deriveConnectId(
			modName,
			connectIdsExcept(appConnectIds, formUuid, "deliver_unit"),
		);
		const taskId = deriveConnectId(
			pairName,
			connectIdsExcept(appConnectIds, formUuid, "task"),
		);
		return { deliverId, taskId };
	}, [mod, form, appConnectIds, formUuid]);

	// A ref holds each sub-block's last-seen value with its ORIGINAL id;
	// while the block was toggled off, another form may have claimed that
	// id. Route restores through the shared dedup path so a now-stale id
	// can't be re-written as a duplicate.
	const restoreConfig = useCallback(
		(config: ConnectConfig): ConnectConfig =>
			dedupeRestoredConnectIds(config, {
				formUuid,
				appConnectIds,
				moduleName: mod?.name ?? "",
				formName: form?.name ?? "",
			}),
		[formUuid, appConnectIds, mod, form],
	);

	const updateDeliverUnit = useCallback(
		(field: string, value: string) => {
			/* Defensive fallback for the rare case the deliver_unit was
			 * stripped between render and edit. Only `name` is required
			 * on the domain shape; `entity_id` / `entity_name` are
			 * optional and default at wire-emit time. */
			const current = connect.deliver_unit ?? { name: "" };
			save({ ...connect, deliver_unit: { ...current, [field]: value } });
		},
		[connect, save],
	);

	/**
	 * Clear an optional field on the deliver_unit by removing the key
	 * outright (rather than writing `""`, which would trip the
	 * `CONNECT_EMPTY_XPATH` validator). Result: the user clears the
	 * editor → the field becomes absent on the doc → the wire-emit
	 * fallback substitutes the canonical default XPath. This is what
	 * makes "leave blank → wire default applies" reachable from the UI.
	 */
	const clearDeliverField = useCallback(
		(field: "entity_id" | "entity_name") => {
			if (!connect.deliver_unit) return;
			const { [field]: _removed, ...rest } = connect.deliver_unit;
			save({
				...connect,
				deliver_unit: rest as NonNullable<ConnectConfig["deliver_unit"]>,
			});
		},
		[connect, save],
	);

	const updateTask = useCallback(
		(field: string, value: string) => {
			const current = connect.task ?? { name: "", description: "" };
			save({ ...connect, task: { ...current, [field]: value } });
		},
		[connect, save],
	);

	const toggleDeliver = useCallback(() => {
		if (deliverEnabled) {
			const { deliver_unit: _removed, ...rest } = connect;
			save(rest as ConnectConfig);
		} else {
			const restored = lastDeliverRef.current;
			if (restored?.name.trim()) {
				save(restoreConfig({ ...connect, deliver_unit: restored }));
			} else {
				const { deliverId } = defaultIds();
				/* Seed only the user-semantic fields. `entity_id` and
				 * `entity_name` are intentionally left undefined so the
				 * wire-emit fallback in `lib/commcare/xform/builder.ts`
				 * is the single home for the canonical default XPath
				 * expressions — duplicating those literals here would
				 * silently bake stale strings into the persisted doc if
				 * the canonical defaults ever evolve. */
				save({
					...connect,
					deliver_unit: {
						id: deliverId,
						name: form?.name ?? "",
					},
				});
			}
		}
	}, [deliverEnabled, connect, save, form, defaultIds, restoreConfig]);

	const toggleTask = useCallback(() => {
		if (taskEnabled) {
			const { task: _removed, ...rest } = connect;
			save(rest as ConnectConfig);
		} else {
			const restored = lastTaskRef.current;
			if (restored && (restored.name.trim() || restored.description.trim())) {
				save(restoreConfig({ ...connect, task: restored }));
			} else {
				const { taskId } = defaultIds();
				save({
					...connect,
					task: {
						id: taskId,
						name: form?.name ?? "",
						description: form?.name ?? "",
					},
				});
			}
		}
	}, [taskEnabled, connect, save, form, defaultIds, restoreConfig]);

	return (
		<div className="space-y-2">
			{/* Deliver Unit sub-toggle */}
			<div className="rounded-lg bg-white/[0.03] border border-white/[0.05] px-2.5 py-2">
				<div className="flex items-center justify-between">
					<span className="text-[10px] text-nova-text-muted uppercase tracking-wider">
						Deliver Unit
					</span>
					<Toggle
						enabled={deliverEnabled}
						onToggle={toggleDeliver}
						variant="sub"
					/>
				</div>
				<AnimatePresence>
					{du && (
						<motion.div
							initial={{ opacity: 0, height: 0 }}
							animate={{ opacity: 1, height: "auto" }}
							exit={{ opacity: 0, height: 0 }}
							transition={{ duration: 0.15, ease: "easeOut" }}
							className="overflow-hidden"
						>
							<div className="space-y-2 pt-2.5 mt-2 border-t border-white/[0.05]">
								<InlineField
									label="Name"
									value={du.name}
									onChange={(v) => updateDeliverUnit("name", v)}
									required
								/>
								<LabeledXPathField
									label="Entity ID"
									/* No `required` flag: the field is optional
									 * on the domain and the wire layer
									 * substitutes the canonical default XPath
									 * when the doc carries no explicit value.
									 * Marking required would tell the user a
									 * lie. Saving an empty value clears the key
									 * outright (via `clearDeliverField`) so the
									 * wire-emit fallback kicks in — writing
									 * `""` would trip `CONNECT_EMPTY_XPATH`. */
									value={du.entity_id ?? ""}
									onSave={(v) => {
										if (v.trim()) updateDeliverUnit("entity_id", v);
										else clearDeliverField("entity_id");
									}}
									getLintContext={getLintContext}
								/>
								<LabeledXPathField
									label="Entity Name"
									value={du.entity_name ?? ""}
									onSave={(v) => {
										if (v.trim()) updateDeliverUnit("entity_name", v);
										else clearDeliverField("entity_name");
									}}
									getLintContext={getLintContext}
								/>
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			</div>

			{/* Task sub-toggle */}
			<div className="rounded-lg bg-white/[0.03] border border-white/[0.05] px-2.5 py-2">
				<div className="flex items-center justify-between">
					<span className="text-[10px] text-nova-text-muted uppercase tracking-wider">
						Task
					</span>
					<Toggle enabled={taskEnabled} onToggle={toggleTask} variant="sub" />
				</div>
				<AnimatePresence>
					{task && (
						<motion.div
							initial={{ opacity: 0, height: 0 }}
							animate={{ opacity: 1, height: "auto" }}
							exit={{ opacity: 0, height: 0 }}
							transition={{ duration: 0.15, ease: "easeOut" }}
							className="overflow-hidden"
						>
							<div className="space-y-2 pt-2.5 mt-2 border-t border-white/[0.05]">
								<InlineField
									label="Task Name"
									value={task.name}
									onChange={(v) => updateTask("name", v)}
									required
								/>
								<InlineField
									label="Task Description"
									value={task.description}
									onChange={(v) => updateTask("description", v)}
									multiline
									required
								/>
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			</div>
		</div>
	);
}
