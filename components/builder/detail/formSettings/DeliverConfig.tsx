"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useRef, useState } from "react";
import { DraftField } from "@/components/builder/detail/appSettings/ConnectEnableDialog";
import {
	DELIVER_BLOCK_WITHHELD_NOTE,
	deliverBlockOffered,
} from "@/components/builder/detail/appSettings/connectDraft";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { Switch } from "@/components/shadcn/switch";
import { deriveConnectId } from "@/lib/commcare/connectSlugs";
import {
	connectIdsExcept,
	useAppConnectIds,
	useRootFieldIdsByForm,
} from "@/lib/doc/hooks/useAppConnectIds";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import {
	useFormExpressionText,
	useParseFormExpression,
} from "@/lib/doc/hooks/useXPathSlots";
import type { Uuid } from "@/lib/doc/types";
import type { CommitOutcome, ConnectDeliverConfig } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { InlineField } from "./InlineField";
import { LabeledXPathField } from "./LabeledXPathField";
import { StagedCommitRow } from "./StagedCommitRow";
import { useFormLintContext } from "./useFormLintContext";

/**
 * Shared prop contract mirroring LearnConfig's: declared locally so each
 * sub-config file owns its contract rather than importing from a sibling.
 */
interface ConnectSubConfigProps {
	connect: ConnectDeliverConfig;
	/** Persist the new config through the gated form update:
	 *  returns the commit outcome so a refused edit keeps the
	 *  inline editor's draft + finding on screen. */
	save: (c: ConnectDeliverConfig | null) => CommitOutcome;
	moduleUuid: Uuid;
	formUuid: Uuid;
}

/**
 * Deliver-mode connect sub-config: two sub-toggles for the `deliver_unit`
 * and `task` halves of a Connect deliver app, each offered only while the
 * other is off (`deliverBlockOffered`). Structurally
 * parallel to LearnConfig: each sub-toggle remembers the last populated
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
	const idSlot = {
		entity: "form" as const,
		uuid: formUuid,
		slot: "deliver_entity_id" as const,
	};
	const nameSlot = {
		entity: "form" as const,
		uuid: formUuid,
		slot: "deliver_entity_name" as const,
	};
	const getIdLintContext = useFormLintContext(idSlot);
	const getNameLintContext = useFormLintContext(nameSlot);
	// AST-stored slots ⇄ text: display prints against the live doc,
	// commit parses against the doc of the moment.
	const entityIdText = useFormExpressionText(du?.entity_id, idSlot);
	const entityNameText = useFormExpressionText(du?.entity_name, nameSlot);
	const parseId = useParseFormExpression(idSlot);
	const parseName = useParseFormExpression(nameSlot);
	/** In-flight staged blocks: component state only, until committed
	 *  (or toggled off, which discards). */
	const [stagedDeliver, setStagedDeliver] = useState<
		{ name: string } | undefined
	>();
	const [stagedTask, setStagedTask] = useState<
		{ name: string; description: string } | undefined
	>();
	/** A refusal from a gesture with no input of its own: the sub-toggles,
	 *  restores, clears, and the staged Add: rendered beneath the cards.
	 *  The field editors present their own outcomes and bypass this. */
	const [saveRejection, setSaveRejection] = useState<string | null>(null);
	const dispatchSave = useCallback(
		(config: ConnectDeliverConfig | null) => {
			const outcome = save(config);
			setSaveRejection(outcome.ok ? null : (outcome.messages[0] ?? null));
			return outcome;
		},
		[save],
	);

	// Name-derived defaults for a freshly enabled sub-config, unique against
	// every other connect id in the app (connect ids share one app-wide
	// namespace). Same `deriveConnectId` + scope the SA path uses.
	// A block's wrapper sits beside the form's top-level fields, so a
	// derived id avoids theirs too.
	const appConnectIds = useAppConnectIds();
	const rootFieldIds = useRootFieldIdsByForm()[formUuid];
	const defaultIds = useCallback(() => {
		const modName = mod?.name ?? "";
		const pairName = `${modName} ${form?.name ?? ""}`;
		const beside = (kind: "deliver_unit" | "task") =>
			new Set([
				...connectIdsExcept(appConnectIds, formUuid, kind),
				...(rootFieldIds ?? []),
			]);
		const deliverId = deriveConnectId(modName, beside("deliver_unit"));
		const taskId = deriveConnectId(pairName, beside("task"));
		return { deliverId, taskId };
	}, [mod, form, appConnectIds, formUuid, rootFieldIds]);

	// Refs preserve each sub-block's last-seen value exactly. A restore
	// proposes that explicit id verbatim; if another form claimed it while
	// inactive, the gate refuses the edit and the inline finding remains.

	const updateDeliverUnit = useCallback(
		(field: string, value: string | Expression) => {
			const current = connect.deliver_unit;
			if (current === undefined) {
				throw new Error("Deliver-unit edit reached a disabled block.");
			}
			return save({ ...connect, deliver_unit: { ...current, [field]: value } });
		},
		[connect, save],
	);

	/**
	 * Clear an optional field on the deliver_unit by removing the key
	 * outright. An empty editor is absence, not a stored expression. The user clears the
	 * editor → the field becomes absent on the doc → the wire-emit
	 * fallback substitutes the canonical default XPath. This is what
	 * makes "leave blank → wire default applies" reachable from the UI.
	 */
	const clearDeliverField = useCallback(
		(field: "entity_id" | "entity_name") => {
			if (!connect.deliver_unit) return;
			const { [field]: _removed, ...rest } = connect.deliver_unit;
			dispatchSave({
				...connect,
				deliver_unit: rest,
			});
		},
		[connect, dispatchSave],
	);

	const updateTask = useCallback(
		(field: string, value: string) => {
			const current = connect.task;
			if (current === undefined) {
				throw new Error("Task edit reached a disabled block.");
			}
			return save({ ...connect, task: { ...current, [field]: value } });
		},
		[connect, save],
	);

	const toggleDeliver = useCallback(() => {
		if (stagedDeliver) {
			/* Discard the uncommitted draft: nothing ever reached the doc,
			 * so nothing refused remains. */
			setStagedDeliver(undefined);
			setSaveRejection(null);
		} else if (deliverEnabled) {
			const { deliver_unit: _removed, ...rest } = connect;
			dispatchSave(connect.task === undefined ? null : rest);
		} else {
			const restored = lastDeliverRef.current;
			if (restored?.name.trim()) {
				dispatchSave({ ...connect, deliver_unit: restored });
			} else {
				/* No prior work to restore: stage and collect the name from
				 * the user before anything commits. */
				setStagedDeliver({ name: "" });
			}
		}
	}, [stagedDeliver, deliverEnabled, connect, dispatchSave]);

	const commitStagedDeliver = useCallback(() => {
		if (!stagedDeliver?.name.trim()) return;
		const { deliverId } = defaultIds();
		/* Commit only the user-written name plus the derived id. `entity_id`
		 * and `entity_name` are intentionally left undefined so the
		 * wire-emit fallback in `lib/commcare/xform/builder.ts` is the
		 * single home for the canonical default XPath expressions:
		 * duplicating those literals here would silently bake stale strings
		 * into the persisted doc if the canonical defaults ever evolve. */
		const outcome = dispatchSave({
			...connect,
			deliver_unit: { id: deliverId, name: stagedDeliver.name.trim() },
		});
		if (outcome.ok) setStagedDeliver(undefined);
	}, [stagedDeliver, connect, dispatchSave, defaultIds]);

	const toggleTask = useCallback(() => {
		if (stagedTask) {
			setStagedTask(undefined);
			setSaveRejection(null);
		} else if (taskEnabled) {
			const { task: _removed, ...rest } = connect;
			dispatchSave(connect.deliver_unit === undefined ? null : rest);
		} else {
			const restored = lastTaskRef.current;
			if (restored && (restored.name.trim() || restored.description.trim())) {
				dispatchSave({ ...connect, task: restored });
			} else {
				setStagedTask({ name: "", description: "" });
			}
		}
	}, [stagedTask, taskEnabled, connect, dispatchSave]);

	const stagedTaskReady =
		stagedTask !== undefined &&
		stagedTask.name.trim().length > 0 &&
		stagedTask.description.trim().length > 0;

	const commitStagedTask = useCallback(() => {
		if (!stagedTask?.name.trim() || !stagedTask.description.trim()) return;
		const { taskId } = defaultIds();
		const outcome = dispatchSave({
			...connect,
			task: {
				id: taskId,
				name: stagedTask.name.trim(),
				description: stagedTask.description.trim(),
			},
		});
		if (outcome.ok) setStagedTask(undefined);
	}, [stagedTask, connect, dispatchSave, defaultIds]);

	/* A deliver unit and a task each go in a form without the other, so a
	 * block is offered only while its counterpart is off, staged or held. */
	const held = {
		deliver_unit: deliverEnabled || stagedDeliver !== undefined,
		task: taskEnabled || stagedTask !== undefined,
	};
	const deliverWithheld =
		!held.deliver_unit && !deliverBlockOffered("deliver_unit", held);
	const taskWithheld = !held.task && !deliverBlockOffered("task", held);

	return (
		<div className="space-y-2">
			{/* Deliver Unit sub-toggle */}
			<div className="rounded-lg bg-white/[0.03] border border-white/[0.05] px-2.5 py-2">
				<div className="flex items-center justify-between">
					<span className="text-xs text-nova-text-muted">Deliver Unit</span>
					<Switch
						checked={held.deliver_unit}
						onCheckedChange={toggleDeliver}
						disabled={deliverWithheld}
					/>
				</div>
				{deliverWithheld && (
					<p className="mt-1.5 text-[11px] leading-snug text-nova-text-muted">
						{DELIVER_BLOCK_WITHHELD_NOTE}
					</p>
				)}
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
											 * wire-emit fallback kicks in. */
											value={entityIdText}
											onSave={(v) => {
												if (v.trim())
													return updateDeliverUnit("entity_id", parseId(v));
												clearDeliverField("entity_id");
												return undefined;
											}}
											getLintContext={getIdLintContext}
										/>
										<LabeledXPathField
											label="Entity name"
											value={entityNameText}
											onSave={(v) => {
												if (v.trim())
													return updateDeliverUnit("entity_name", parseName(v));
												clearDeliverField("entity_name");
												return undefined;
											}}
											getLintContext={getNameLintContext}
										/>
									</>
								) : stagedDeliver ? (
									/* STAGED: collect the name before anything commits;
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
					<span className="text-xs text-nova-text-muted">Task</span>
					<Switch
						checked={held.task}
						onCheckedChange={toggleTask}
						disabled={taskWithheld}
					/>
				</div>
				{taskWithheld && (
					<p className="mt-1.5 text-[11px] leading-snug text-nova-text-muted">
						{DELIVER_BLOCK_WITHHELD_NOTE}
					</p>
				)}
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
											label="Task name"
											value={task.name}
											onChange={(v) => updateTask("name", v)}
											required
										/>
										<InlineField
											label="Task description"
											value={task.description}
											onChange={(v) => updateTask("description", v)}
											multiline
											required
										/>
									</>
								) : stagedTask ? (
									<>
										<DraftField
											label="Task name"
											value={stagedTask.name}
											onChange={(v) =>
												setStagedTask((d) => d && { ...d, name: v })
											}
										/>
										<DraftField
											label="Task description"
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

			{/* A refused toggle/restore/clear/Add explains itself here: those
			 * gestures have no input to anchor the finding to. */}
			<RejectionInline message={saveRejection} />
		</div>
	);
}
