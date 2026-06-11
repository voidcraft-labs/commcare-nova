"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useRef, useState } from "react";
import { DraftField } from "@/components/builder/detail/appSettings/ConnectEnableDialog";
import { Toggle } from "@/components/ui/Toggle";
import { deriveConnectId } from "@/lib/commcare/connectSlugs";
import { dedupeRestoredConnectIds } from "@/lib/doc/connectConfig";
import {
	connectIdsExcept,
	useAppConnectIds,
} from "@/lib/doc/hooks/useAppConnectIds";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import {
	useParseXPathForForm,
	useXPathText,
} from "@/lib/doc/hooks/useXPathSlots";
import type { Uuid } from "@/lib/doc/types";
import type {
	CommitOutcome,
	ConnectConfig,
	XPathExpression,
} from "@/lib/domain";
import { InlineField } from "./InlineField";
import { LabeledXPathField } from "./LabeledXPathField";
import { StagedCommitRow } from "./StagedCommitRow";
import { useConnectLintContext } from "./useConnectLintContext";

/**
 * Shared prop contract mirroring LearnConfig's — declared locally so each
 * sub-config file owns its contract rather than importing from a sibling.
 */
interface ConnectSubConfigProps {
	connect: ConnectConfig;
	/** Persist the new config through the gated form update —
	 *  returns the commit outcome so a refused edit keeps the
	 *  inline editor's draft + finding on screen. */
	save: (c: ConnectConfig) => CommitOutcome;
	moduleUuid: Uuid;
	formUuid: Uuid;
}

/**
 * Deliver-mode connect sub-config: two independent sub-toggles for the
 * `deliver_unit` and `task` halves of a Connect deliver app. Structurally
 * parallel to LearnConfig — each sub-toggle remembers the last populated
 * value in a ref so off+on restores rather than resets, and with no
 * restorable value STAGES the block: the names and descriptions are
 * content the user writes (the same collect-before-commit pattern the
 * app-level enable dialog uses, scaled to one sub-config), so nothing
 * commits until they exist. Identifiers are derived at commit; the
 * deliver entity XPaths stay absent so the wire-emit defaults apply.
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
	// AST-stored slots ⇄ text: display prints against the live doc,
	// commit parses against the doc of the moment.
	const entityIdText = useXPathText(du?.entity_id);
	const entityNameText = useXPathText(du?.entity_name);
	const parseForForm = useParseXPathForForm(formUuid);
	/** In-flight staged blocks — component state only, until committed
	 *  (or toggled off, which discards). */
	const [stagedDeliver, setStagedDeliver] = useState<
		{ name: string } | undefined
	>();
	const [stagedTask, setStagedTask] = useState<
		{ name: string; description: string } | undefined
	>();

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
		(field: string, value: string | XPathExpression) => {
			/* Defensive fallback for the rare case the deliver_unit was
			 * stripped between render and edit. Only `name` is required
			 * on the domain shape; `entity_id` / `entity_name` are
			 * optional and default at wire-emit time. */
			const current = connect.deliver_unit ?? { name: "" };
			return save({ ...connect, deliver_unit: { ...current, [field]: value } });
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
			return save({ ...connect, task: { ...current, [field]: value } });
		},
		[connect, save],
	);

	const toggleDeliver = useCallback(() => {
		if (stagedDeliver) {
			/* Discard the uncommitted draft — nothing ever reached the doc. */
			setStagedDeliver(undefined);
		} else if (deliverEnabled) {
			const { deliver_unit: _removed, ...rest } = connect;
			save(rest as ConnectConfig);
		} else {
			const restored = lastDeliverRef.current;
			if (restored?.name.trim()) {
				save(restoreConfig({ ...connect, deliver_unit: restored }));
			} else {
				/* No prior work to restore — stage and collect the name from
				 * the user before anything commits. */
				setStagedDeliver({ name: "" });
			}
		}
	}, [stagedDeliver, deliverEnabled, connect, save, restoreConfig]);

	const commitStagedDeliver = useCallback(() => {
		if (!stagedDeliver?.name.trim()) return;
		const { deliverId } = defaultIds();
		/* Commit only the user-written name plus the derived id. `entity_id`
		 * and `entity_name` are intentionally left undefined so the
		 * wire-emit fallback in `lib/commcare/xform/builder.ts` is the
		 * single home for the canonical default XPath expressions —
		 * duplicating those literals here would silently bake stale strings
		 * into the persisted doc if the canonical defaults ever evolve. */
		const outcome = save({
			...connect,
			deliver_unit: { id: deliverId, name: stagedDeliver.name.trim() },
		});
		if (outcome.ok) setStagedDeliver(undefined);
	}, [stagedDeliver, connect, save, defaultIds]);

	const toggleTask = useCallback(() => {
		if (stagedTask) {
			setStagedTask(undefined);
		} else if (taskEnabled) {
			const { task: _removed, ...rest } = connect;
			save(rest as ConnectConfig);
		} else {
			const restored = lastTaskRef.current;
			if (restored && (restored.name.trim() || restored.description.trim())) {
				save(restoreConfig({ ...connect, task: restored }));
			} else {
				setStagedTask({ name: "", description: "" });
			}
		}
	}, [stagedTask, taskEnabled, connect, save, restoreConfig]);

	const stagedTaskReady =
		stagedTask !== undefined &&
		stagedTask.name.trim().length > 0 &&
		stagedTask.description.trim().length > 0;

	const commitStagedTask = useCallback(() => {
		if (!stagedTask?.name.trim() || !stagedTask.description.trim()) return;
		const { taskId } = defaultIds();
		const outcome = save({
			...connect,
			task: {
				id: taskId,
				name: stagedTask.name.trim(),
				description: stagedTask.description.trim(),
			},
		});
		if (outcome.ok) setStagedTask(undefined);
	}, [stagedTask, connect, save, defaultIds]);

	return (
		<div className="space-y-2">
			{/* Deliver Unit sub-toggle */}
			<div className="rounded-lg bg-white/[0.03] border border-white/[0.05] px-2.5 py-2">
				<div className="flex items-center justify-between">
					<span className="text-[10px] text-nova-text-muted uppercase tracking-wider">
						Deliver Unit
					</span>
					<Toggle
						enabled={deliverEnabled || stagedDeliver !== undefined}
						onToggle={toggleDeliver}
						variant="sub"
					/>
				</div>
				<AnimatePresence>
					{(du || stagedDeliver) && (
						<motion.div
							initial={{ opacity: 0, height: 0 }}
							animate={{ opacity: 1, height: "auto" }}
							exit={{ opacity: 0, height: 0 }}
							transition={{ duration: 0.15, ease: "easeOut" }}
							className="overflow-hidden"
						>
							<div className="space-y-2 pt-2.5 mt-2 border-t border-white/[0.05]">
								{du ? (
									<>
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
											value={entityIdText}
											onSave={(v) => {
												if (v.trim())
													return updateDeliverUnit(
														"entity_id",
														parseForForm(v),
													);
												clearDeliverField("entity_id");
												return undefined;
											}}
											getLintContext={getLintContext}
										/>
										<LabeledXPathField
											label="Entity Name"
											value={entityNameText}
											onSave={(v) => {
												if (v.trim())
													return updateDeliverUnit(
														"entity_name",
														parseForForm(v),
													);
												clearDeliverField("entity_name");
												return undefined;
											}}
											getLintContext={getLintContext}
										/>
									</>
								) : stagedDeliver ? (
									/* STAGED — collect the name before anything commits;
									 * the id derives at commit, the entity XPaths stay on
									 * the wire-emit defaults. */
									<>
										<DraftField
											label="Name"
											value={stagedDeliver.name}
											onChange={(v) => setStagedDeliver({ name: v })}
										/>
										<StagedCommitRow
											ready={stagedDeliver.name.trim().length > 0}
											hint={
												stagedDeliver.name.trim().length > 0
													? "Ready to add."
													: "A name is needed first."
											}
											onCommit={commitStagedDeliver}
										/>
									</>
								) : null}
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
					<Toggle
						enabled={taskEnabled || stagedTask !== undefined}
						onToggle={toggleTask}
						variant="sub"
					/>
				</div>
				<AnimatePresence>
					{(task || stagedTask) && (
						<motion.div
							initial={{ opacity: 0, height: 0 }}
							animate={{ opacity: 1, height: "auto" }}
							exit={{ opacity: 0, height: 0 }}
							transition={{ duration: 0.15, ease: "easeOut" }}
							className="overflow-hidden"
						>
							<div className="space-y-2 pt-2.5 mt-2 border-t border-white/[0.05]">
								{task ? (
									<>
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
									</>
								) : stagedTask ? (
									<>
										<DraftField
											label="Task Name"
											value={stagedTask.name}
											onChange={(v) =>
												setStagedTask((d) => d && { ...d, name: v })
											}
										/>
										<DraftField
											label="Task Description"
											value={stagedTask.description}
											onChange={(v) =>
												setStagedTask((d) => d && { ...d, description: v })
											}
											multiline
										/>
										<StagedCommitRow
											ready={stagedTaskReady}
											hint={
												stagedTaskReady
													? "Ready to add."
													: "Name and description are needed first."
											}
											onCommit={commitStagedTask}
										/>
									</>
								) : null}
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			</div>
		</div>
	);
}
