"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useRef } from "react";
import { Toggle } from "@/components/ui/Toggle";
import { toSnakeId } from "@/lib/commcare";
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

	const defaultIds = useCallback(() => {
		const modSlug = toSnakeId(mod?.name ?? "");
		const formSlug = toSnakeId(form?.name ?? "");
		return { deliverId: modSlug, taskId: `${modSlug}_${formSlug}` };
	}, [mod, form]);

	const updateDeliverUnit = useCallback(
		(field: string, value: string) => {
			const current = connect.deliver_unit ?? {
				name: "",
				entity_id: "",
				entity_name: "",
			};
			save({ ...connect, deliver_unit: { ...current, [field]: value } });
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
				save({ ...connect, deliver_unit: restored });
			} else {
				const { deliverId } = defaultIds();
				save({
					...connect,
					deliver_unit: {
						id: deliverId,
						name: form?.name ?? "",
						entity_id: "concat(#user/username, '-', today())",
						entity_name: "#user/username",
					},
				});
			}
		}
	}, [deliverEnabled, connect, save, form, defaultIds]);

	const toggleTask = useCallback(() => {
		if (taskEnabled) {
			const { task: _removed, ...rest } = connect;
			save(rest as ConnectConfig);
		} else {
			const restored = lastTaskRef.current;
			if (restored && (restored.name.trim() || restored.description.trim())) {
				save({ ...connect, task: restored });
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
	}, [taskEnabled, connect, save, form, defaultIds]);

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
									required
									value={du.entity_id}
									onSave={(v) => {
										if (v.trim()) updateDeliverUnit("entity_id", v);
									}}
									getLintContext={getLintContext}
								/>
								<LabeledXPathField
									label="Entity Name"
									required
									value={du.entity_name}
									onSave={(v) => {
										if (v.trim()) updateDeliverUnit("entity_name", v);
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
