"use client";
import { Popover } from "@base-ui/react/popover";
import { Icon } from "@iconify/react/offline";
import tablerSettings from "@iconify-icons/tabler/settings";
import tablerX from "@iconify-icons/tabler/x";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useRef, useState } from "react";
import { ConnectLogomark } from "@/components/icons/ConnectLogomark";
import { Toggle } from "@/components/ui/Toggle";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import { asUuid, type Uuid } from "@/lib/doc/types";
import type { ConnectConfig } from "@/lib/domain";
import { toSnakeId } from "@/lib/services/commcare/validate";
import { useFormConnectStash, useStashFormConnect } from "@/lib/session/hooks";
import { POPOVER_POPUP_CLS, POPOVER_POSITIONER_GLASS_CLS } from "@/lib/styles";
import { AfterSubmitSection } from "./formSettings/AfterSubmitSection";
import { CloseConditionSection } from "./formSettings/CloseConditionSection";
import { InlineField } from "./formSettings/InlineField";
import { LabeledXPathField } from "./formSettings/LabeledXPathField";
import { useConnectLintContext } from "./formSettings/useConnectLintContext";

// ── Types ─────────────────────────────────────────────────────────────

interface FormSettingsPanelProps {
	moduleUuid: Uuid;
	formUuid: Uuid;
}

// ── Toggle Button (for FormScreen header) ─────────────────────────────

export function FormSettingsButton({
	moduleUuid,
	formUuid,
}: FormSettingsPanelProps) {
	const form = useForm(formUuid);
	const connectType = useBlueprintDoc((s) => s.connectType);
	const hasConnect = !!form?.connect && !!connectType;
	const [open, setOpen] = useState(false);

	/** Guard dismiss when a CodeMirror autocomplete tooltip (portal-mounted
	 *  to body, outside the panel DOM) received the click. */
	const handleOpenChange = useCallback(
		(nextOpen: boolean, details: Popover.Root.ChangeEventDetails) => {
			if (
				!nextOpen &&
				(details.reason === "outside-press" ||
					details.reason === "escape-key") &&
				document.querySelector(".cm-tooltip-autocomplete")
			) {
				return;
			}
			setOpen(nextOpen);
		},
		[],
	);

	return (
		<Popover.Root open={open} onOpenChange={handleOpenChange}>
			<Popover.Trigger
				className="ml-auto flex items-center gap-1 p-1.5 rounded-md transition-colors cursor-pointer text-nova-text-muted hover:text-nova-text hover:bg-white/5"
				aria-label="Form settings"
			>
				<Icon icon={tablerSettings} width="18" height="18" />
				{hasConnect && (
					<ConnectLogomark size={12} className="text-nova-violet-bright" />
				)}
			</Popover.Trigger>

			<Popover.Portal>
				<Popover.Positioner
					side="bottom"
					align="end"
					sideOffset={8}
					className={POPOVER_POSITIONER_GLASS_CLS}
				>
					<Popover.Popup className={POPOVER_POPUP_CLS}>
						<FormSettingsPanel
							moduleUuid={moduleUuid}
							formUuid={formUuid}
							onClose={() => setOpen(false)}
						/>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}

// ── Panel ──────────────────────────────────────────────────────────────

function FormSettingsPanel({
	moduleUuid,
	formUuid,
	onClose,
}: FormSettingsPanelProps & { onClose: () => void }) {
	return (
		<div className="w-80">
			{/* Header */}
			<div className="flex items-center justify-between px-3.5 py-2.5 border-b border-white/[0.06]">
				<span className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider">
					Form Settings
				</span>
				<button
					type="button"
					onClick={onClose}
					className="p-1 -mr-1 rounded-md text-nova-text-muted hover:text-nova-text hover:bg-white/[0.06] transition-colors cursor-pointer"
				>
					<Icon icon={tablerX} width="14" height="14" />
				</button>
			</div>

			{/* Content */}
			<div className="px-3.5 py-3 space-y-3 overflow-y-auto max-h-[480px]">
				<CloseConditionSection moduleUuid={moduleUuid} formUuid={formUuid} />

				<AfterSubmitSection moduleUuid={moduleUuid} formUuid={formUuid} />

				<ConnectSection moduleUuid={moduleUuid} formUuid={formUuid} />
			</div>
		</div>
	);
}

// ── Connect Configuration Section ──────────────────────────────────────

function ConnectSection({ moduleUuid, formUuid }: FormSettingsPanelProps) {
	const form = useForm(formUuid);
	const mod = useModule(moduleUuid);
	const { updateForm: updateFormAction } = useBlueprintMutations();
	const connectType = useBlueprintDoc((s) => s.connectType ?? undefined);
	const connect = form?.connect;
	const enabled = !!connect;

	/* Session hooks for connect stash — keyed by form uuid (stable across
	 * reorder + rename), replacing the legacy engine's index-based stash. */
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
		} else if (connectType) {
			if (stashedConfig) {
				save(stashedConfig);
			} else {
				const modSlug = toSnakeId(mod?.name ?? "");
				const formSlug = toSnakeId(form?.name ?? "");
				if (connectType === "learn") {
					save({
						learn_module: {
							id: modSlug,
							name: form?.name ?? "",
							description: form?.name ?? "",
							time_estimate: 5,
						},
						assessment: {
							id: `${modSlug}_${formSlug}`,
							user_score: "100",
						},
					});
				} else {
					save({
						deliver_unit: {
							id: modSlug,
							name: form?.name ?? "",
							entity_id: "concat(#user/username, '-', today())",
							entity_name: "#user/username",
						},
						task: {
							id: `${modSlug}_${formSlug}`,
							name: form?.name ?? "",
							description: form?.name ?? "",
						},
					});
				}
			}
		}
	}, [
		enabled,
		connect,
		connectType,
		stashFormConnect,
		stashedConfig,
		mod,
		form,
		formUuid,
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

// ── Shared types for sub-configs ───────────────────────────────────────

interface ConnectSubConfigProps {
	connect: ConnectConfig;
	save: (c: ConnectConfig) => void;
	moduleUuid: Uuid;
	formUuid: Uuid;
}

// ── Learn Config Fields ────────────────────────────────────────────────

function LearnConfig({
	connect,
	save,
	moduleUuid,
	formUuid,
}: ConnectSubConfigProps) {
	const mod = useModule(moduleUuid);
	const form = useForm(formUuid);
	const lm = connect.learn_module;
	const assessment = connect.assessment;
	const learnEnabled = !!lm;
	const assessmentEnabled = !!assessment;
	const lastLearnRef = useRef(lm);
	const lastAssessmentRef = useRef(assessment);
	if (lm) lastLearnRef.current = lm;
	if (assessment) lastAssessmentRef.current = assessment;
	const getLintContext = useConnectLintContext(formUuid);

	const defaultIds = useCallback(() => {
		const modSlug = toSnakeId(mod?.name ?? "");
		const formSlug = toSnakeId(form?.name ?? "");
		return { learnId: modSlug, assessmentId: `${modSlug}_${formSlug}` };
	}, [mod, form]);

	const updateLearnModule = useCallback(
		(field: string, value: string | number) => {
			const { learnId } = defaultIds();
			const current = connect.learn_module ?? {
				id: learnId,
				name: "",
				description: "",
				time_estimate: 5,
			};
			save({ ...connect, learn_module: { ...current, [field]: value } });
		},
		[connect, save, defaultIds],
	);

	const toggleLearn = useCallback(() => {
		if (learnEnabled) {
			const { learn_module: _removed, ...rest } = connect;
			save(rest as ConnectConfig);
		} else {
			const restored = lastLearnRef.current;
			if (restored?.name.trim()) {
				save({ ...connect, learn_module: restored });
			} else {
				const { learnId } = defaultIds();
				save({
					...connect,
					learn_module: {
						id: learnId,
						name: form?.name ?? "",
						description: form?.name ?? "",
						time_estimate: 5,
					},
				});
			}
		}
	}, [learnEnabled, connect, save, form, defaultIds]);

	const toggleAssessment = useCallback(() => {
		if (assessmentEnabled) {
			const { assessment: _removed, ...rest } = connect;
			save(rest as ConnectConfig);
		} else {
			const restored = lastAssessmentRef.current;
			if (restored?.user_score.trim()) {
				save({ ...connect, assessment: restored });
			} else {
				const { assessmentId } = defaultIds();
				save({
					...connect,
					assessment: { id: assessmentId, user_score: "100" },
				});
			}
		}
	}, [assessmentEnabled, connect, save, defaultIds]);

	return (
		<div className="space-y-2">
			{/* Learn Module sub-toggle */}
			<div className="rounded-lg bg-white/[0.03] border border-white/[0.05] px-2.5 py-2">
				<div className="flex items-center justify-between">
					<span className="text-[10px] text-nova-text-muted uppercase tracking-wider">
						Learn Module
					</span>
					<Toggle enabled={learnEnabled} onToggle={toggleLearn} variant="sub" />
				</div>
				<AnimatePresence>
					{lm && (
						<motion.div
							initial={{ opacity: 0, height: 0 }}
							animate={{ opacity: 1, height: "auto" }}
							exit={{ opacity: 0, height: 0 }}
							transition={{ duration: 0.15, ease: "easeOut" }}
							className="overflow-hidden"
						>
							<div className="space-y-2 pt-2.5 mt-2 border-t border-white/[0.05]">
								<InlineField
									label="Module ID"
									value={lm.id ?? "connect_learn"}
									onChange={(v) => updateLearnModule("id", v)}
									mono
									required
								/>
								<InlineField
									label="Name"
									value={lm.name}
									onChange={(v) => updateLearnModule("name", v)}
									required
								/>
								<InlineField
									label="Description"
									value={lm.description}
									onChange={(v) => updateLearnModule("description", v)}
									multiline
									required
								/>
								<InlineField
									label="Time Estimate"
									value={String(lm.time_estimate)}
									onChange={(v) =>
										updateLearnModule(
											"time_estimate",
											Math.max(1, parseInt(v, 10) || 1),
										)
									}
									suffix="min"
									type="number"
									required
								/>
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			</div>

			{/* Assessment sub-toggle */}
			<div className="rounded-lg bg-white/[0.03] border border-white/[0.05] px-2.5 py-2">
				<div className="flex items-center justify-between">
					<span className="text-[10px] text-nova-text-muted uppercase tracking-wider">
						Assessment
					</span>
					<Toggle
						enabled={assessmentEnabled}
						onToggle={toggleAssessment}
						variant="sub"
					/>
				</div>
				<AnimatePresence>
					{assessment && (
						<motion.div
							initial={{ opacity: 0, height: 0 }}
							animate={{ opacity: 1, height: "auto" }}
							exit={{ opacity: 0, height: 0 }}
							transition={{ duration: 0.15, ease: "easeOut" }}
							className="overflow-hidden"
						>
							<div className="space-y-2 pt-2.5 mt-2 border-t border-white/[0.05]">
								<InlineField
									label="Assessment ID"
									value={assessment.id ?? "connect_assessment"}
									onChange={(v) =>
										save({ ...connect, assessment: { ...assessment, id: v } })
									}
									mono
									required
								/>
								<LabeledXPathField
									label="User Score"
									required
									value={assessment.user_score}
									onSave={(v) => {
										if (v.trim())
											save({
												...connect,
												assessment: { ...assessment, user_score: v },
											});
									}}
									getLintContext={getLintContext}
								/>
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			</div>
		</div>
	);
}

// ── Deliver Config Fields ──────────────────────────────────────────────

/**
 * Deliver config — two independent sub-toggles (deliver_unit + task),
 * mirroring LearnConfig's pattern with learn_module + assessment.
 */
function DeliverConfig({
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
