"use client";
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { Icon } from "@iconify/react/offline";
import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
import tablerHome from "@iconify-icons/tabler/home";
import tablerSettings from "@iconify-icons/tabler/settings";
import tablerTable from "@iconify-icons/tabler/table";
import tablerX from "@iconify-icons/tabler/x";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { SavedCheck } from "@/components/builder/EditableTitle";
import { SaveShortcutHint } from "@/components/builder/SaveShortcutHint";
import { XPathField } from "@/components/builder/XPathField";
import { ConnectLogomark } from "@/components/icons/ConnectLogomark";
import { FieldPicker } from "@/components/ui/FieldPicker";
import { Toggle } from "@/components/ui/Toggle";
import {
	useAssembledForm,
	useBuilderEngine,
	useBuilderStore,
	useForm,
	useModule,
} from "@/hooks/useBuilder";
import { useCommitField } from "@/hooks/useCommitField";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import {
	type ConnectConfig,
	type ConnectType,
	defaultPostSubmit,
	type PostSubmitDestination,
	type Question,
} from "@/lib/schemas/blueprint";
import { toSnakeId } from "@/lib/services/commcare/validate";
import {
	assembleBlueprint,
	assembleForm,
	getEntityData,
} from "@/lib/services/normalizedState";
import {
	MENU_ITEM_BASE,
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_SUBMENU_POSITIONER_CLS,
	POPOVER_POPUP_CLS,
	POPOVER_POSITIONER_GLASS_CLS,
} from "@/lib/styles";

// ── Types ─────────────────────────────────────────────────────────────

interface FormSettingsPanelProps {
	moduleIndex: number;
	formIndex: number;
}

// ── Toggle Button (for FormScreen header) ─────────────────────────────

export function FormSettingsButton({
	moduleIndex,
	formIndex,
}: FormSettingsPanelProps) {
	const form = useForm(moduleIndex, formIndex);
	const connectType = useBuilderStore((s) => s.connectType);
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
							moduleIndex={moduleIndex}
							formIndex={formIndex}
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
	moduleIndex,
	formIndex,
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
				<CloseConditionSection
					moduleIndex={moduleIndex}
					formIndex={formIndex}
				/>

				<AfterSubmitSection moduleIndex={moduleIndex} formIndex={formIndex} />

				<ConnectSection moduleIndex={moduleIndex} formIndex={formIndex} />
			</div>
		</div>
	);
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Recursively find a question by ID in a nested question tree. */
function findQuestionById(
	questions: Question[],
	id: string,
): Question | undefined {
	for (const q of questions) {
		if (q.id === id) return q;
		if ((q.type === "group" || q.type === "repeat") && q.children) {
			const found = findQuestionById(q.children, id);
			if (found) return found;
		}
	}
	return undefined;
}

// ── Close Condition Section ───────────────────────────────────────────

type CloseMode = "always" | "conditional";

const CLOSE_MODE_OPTIONS: Array<{ value: CloseMode; label: string }> = [
	{ value: "always", label: "Always" },
	{ value: "conditional", label: "When condition is met" },
];

/**
 * Close behavior dropdown for close forms. "Always" (default) vs
 * "When condition is met" (reveals field picker + operator + value).
 * Mirrors the AfterSubmitSection dropdown pattern.
 */
function CloseConditionSection({
	moduleIndex,
	formIndex,
}: FormSettingsPanelProps) {
	const form = useForm(moduleIndex, formIndex);
	const assembledForm = useAssembledForm(moduleIndex, formIndex);
	const updateFormAction = useBuilderStore((s) => s.updateForm);
	const triggerId = useId();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const operatorTriggerRef = useRef<HTMLButtonElement>(null);
	const valueTriggerRef = useRef<HTMLButtonElement>(null);

	const questions = assembledForm?.questions ?? [];
	const closeQuestion = form?.closeCondition?.question;

	/* Resolve the referenced field to check if it has selectable options */
	const selectedFieldOptions = useMemo(() => {
		if (!closeQuestion) return undefined;
		const found = findQuestionById(questions, closeQuestion);
		return found?.options && found.options.length > 0
			? found.options
			: undefined;
	}, [closeQuestion, questions]);

	if (form?.type !== "close") return null;

	const currentMode: CloseMode = form.closeCondition ? "conditional" : "always";
	const currentLabel =
		CLOSE_MODE_OPTIONS.find((o) => o.value === currentMode)?.label ?? "Always";
	const operator = form.closeCondition?.operator ?? "=";

	const handleSelect = (mode: CloseMode) => {
		if (mode === "always") {
			updateFormAction(moduleIndex, formIndex, { close_condition: null });
		} else {
			updateFormAction(moduleIndex, formIndex, {
				close_condition: { question: "", answer: "" },
			});
		}
	};

	const updateCondition = (
		patch: Partial<{
			question: string;
			answer: string;
			operator: "=" | "selected";
		}>,
	) => {
		const current = form.closeCondition ?? { question: "", answer: "" };
		updateFormAction(moduleIndex, formIndex, {
			close_condition: { ...current, ...patch },
		});
	};

	return (
		<div>
			<label
				htmlFor={triggerId}
				className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider mb-1.5 block"
			>
				Close Behavior
			</label>
			<Menu.Root>
				<Menu.Trigger
					ref={triggerRef}
					id={triggerId}
					className="group w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-nova-text bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30"
				>
					<span>{currentLabel}</span>
					<svg
						aria-hidden="true"
						width="10"
						height="10"
						viewBox="0 0 10 10"
						className="text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
					>
						<path
							d="M2 3.5L5 6.5L8 3.5"
							stroke="currentColor"
							strokeWidth="1.2"
							fill="none"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</Menu.Trigger>

				<Menu.Portal>
					<Menu.Positioner
						side="bottom"
						align="start"
						sideOffset={4}
						anchor={triggerRef}
						className={MENU_SUBMENU_POSITIONER_CLS}
						style={{ minWidth: "var(--anchor-width)" }}
					>
						<Menu.Popup className={MENU_POPUP_CLS}>
							{CLOSE_MODE_OPTIONS.map((opt, i) => {
								const isActive = opt.value === currentMode;
								const last = CLOSE_MODE_OPTIONS.length - 1;
								const corners =
									i === 0 && i === last
										? "rounded-xl"
										: i === 0
											? "rounded-t-xl"
											: i === last
												? "rounded-b-xl"
												: "";

								return (
									<Menu.Item
										key={opt.value}
										onClick={() => handleSelect(opt.value)}
										className={`${corners} ${
											isActive
												? `${MENU_ITEM_BASE} text-nova-violet-bright bg-nova-violet/10 cursor-pointer`
												: MENU_ITEM_CLS
										}`}
									>
										<span>{opt.label}</span>
									</Menu.Item>
								);
							})}
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>

			{/* Conditional close fields — field ID, operator, value */}
			<AnimatePresence>
				{form.closeCondition && (
					<motion.div
						initial={{ opacity: 0, height: 0 }}
						animate={{ opacity: 1, height: "auto" }}
						exit={{ opacity: 0, height: 0 }}
						transition={{ duration: 0.15, ease: "easeOut" }}
						className="overflow-hidden"
					>
						<div className="space-y-2 mt-2 rounded-lg bg-white/[0.03] border border-white/[0.05] px-2.5 py-2">
							{/* Field picker — autocomplete of form fields */}
							<FieldPicker
								questions={questions}
								value={form.closeCondition.question}
								onChange={(v) => updateCondition({ question: v })}
								label="Field"
								placeholder="Search fields..."
								required
							/>

							{/* Operator — "is" (=) vs "has selected" (selected) */}
							<div>
								<span className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-0.5 block">
									Operator
								</span>
								<Menu.Root>
									<Menu.Trigger
										ref={operatorTriggerRef}
										className="group w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-nova-text bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30"
									>
										<span>
											{operator === "selected" ? "has selected" : "is"}
										</span>
										<svg
											aria-hidden="true"
											width="10"
											height="10"
											viewBox="0 0 10 10"
											className="text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
										>
											<path
												d="M2 3.5L5 6.5L8 3.5"
												stroke="currentColor"
												strokeWidth="1.2"
												fill="none"
												strokeLinecap="round"
												strokeLinejoin="round"
											/>
										</svg>
									</Menu.Trigger>
									<Menu.Portal>
										<Menu.Positioner
											side="bottom"
											align="start"
											sideOffset={4}
											anchor={operatorTriggerRef}
											className={MENU_SUBMENU_POSITIONER_CLS}
											style={{ minWidth: "var(--anchor-width)" }}
										>
											<Menu.Popup className={MENU_POPUP_CLS}>
												{(
													[
														{ value: "=", label: "is" },
														{
															value: "selected",
															label: "has selected",
														},
													] as const
												).map((opt, i) => {
													const isActive = opt.value === operator;
													return (
														<Menu.Item
															key={opt.value}
															onClick={() =>
																updateCondition({ operator: opt.value })
															}
															className={`${i === 0 ? "rounded-t-xl" : "rounded-b-xl"} ${
																isActive
																	? `${MENU_ITEM_BASE} text-nova-violet-bright bg-nova-violet/10 cursor-pointer`
																	: MENU_ITEM_CLS
															}`}
														>
															<span>{opt.label}</span>
														</Menu.Item>
													);
												})}
											</Menu.Popup>
										</Menu.Positioner>
									</Menu.Portal>
								</Menu.Root>
							</div>

							{/* Value — dropdown of field options when available, free text otherwise.
							 * HQ wraps the value in quotes automatically (it's a string literal,
							 * not an XPath expression), so users type plain values like "yes". */}
							{selectedFieldOptions ? (
								<div>
									<span className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-0.5 block">
										Value <span className="text-nova-rose ml-0.5">*</span>
									</span>
									<Menu.Root>
										<Menu.Trigger
											ref={valueTriggerRef}
											className="group w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-nova-text bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30"
										>
											<span
												className={
													form.closeCondition.answer
														? "font-mono text-nova-violet-bright"
														: "text-nova-text-muted"
												}
											>
												{form.closeCondition.answer
													? (selectedFieldOptions.find(
															(o) => o.value === form.closeCondition?.answer,
														)?.label ?? form.closeCondition.answer)
													: "Select a value..."}
											</span>
											<svg
												aria-hidden="true"
												width="10"
												height="10"
												viewBox="0 0 10 10"
												className="text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
											>
												<path
													d="M2 3.5L5 6.5L8 3.5"
													stroke="currentColor"
													strokeWidth="1.2"
													fill="none"
													strokeLinecap="round"
													strokeLinejoin="round"
												/>
											</svg>
										</Menu.Trigger>
										<Menu.Portal>
											<Menu.Positioner
												side="bottom"
												align="start"
												sideOffset={4}
												anchor={valueTriggerRef}
												className={MENU_SUBMENU_POSITIONER_CLS}
												style={{ minWidth: "var(--anchor-width)" }}
											>
												<Menu.Popup className={MENU_POPUP_CLS}>
													{selectedFieldOptions.map((opt, i) => {
														const isActive =
															opt.value === form.closeCondition?.answer;
														const last = selectedFieldOptions.length - 1;
														const corners =
															i === 0 && i === last
																? "rounded-xl"
																: i === 0
																	? "rounded-t-xl"
																	: i === last
																		? "rounded-b-xl"
																		: "";
														return (
															<Menu.Item
																key={opt.value}
																onClick={() =>
																	updateCondition({ answer: opt.value })
																}
																className={`${corners} ${
																	isActive
																		? `${MENU_ITEM_BASE} text-nova-violet-bright bg-nova-violet/10 cursor-pointer`
																		: MENU_ITEM_CLS
																}`}
															>
																<span className="font-mono text-xs">
																	{opt.value}
																</span>
																{opt.label !== opt.value && (
																	<span className="text-xs text-nova-text-muted ml-auto">
																		{opt.label}
																	</span>
																)}
															</Menu.Item>
														);
													})}
												</Menu.Popup>
											</Menu.Positioner>
										</Menu.Portal>
									</Menu.Root>
								</div>
							) : (
								<InlineField
									label="Value"
									value={form.closeCondition.answer}
									onChange={(v) => updateCondition({ answer: v })}
									mono
									required
									placeholder="Plain text value"
								/>
							)}
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}

// ── After Submit Section ──────────────────────────────────────────────

const AFTER_SUBMIT_OPTIONS: Array<{
	value: PostSubmitDestination;
	label: string;
	description: string;
	icon: typeof tablerHome;
}> = [
	{
		value: "app_home",
		label: "App Home",
		description: "Back to the main screen",
		icon: tablerHome,
	},
	{
		value: "module",
		label: "This Module",
		description: "Stay in this module's form list",
		icon: tablerTable,
	},
	{
		value: "previous",
		label: "Previous Screen",
		description: "Back to where the user was",
		icon: tablerArrowBackUp,
	},
];

/** Map internal-only values (root, parent_module) to their user-facing equivalent. */
function resolveUserFacing(dest: PostSubmitDestination): PostSubmitDestination {
	if (dest === "root") return "app_home";
	if (dest === "parent_module") return "module";
	return dest;
}

function AfterSubmitSection({
	moduleIndex,
	formIndex,
}: FormSettingsPanelProps) {
	const form = useForm(moduleIndex, formIndex);
	const updateForm = useBuilderStore((s) => s.updateForm);
	const formType = form?.type ?? "survey";
	const current = resolveUserFacing(
		form?.postSubmit ?? defaultPostSubmit(formType),
	);
	const currentOption =
		AFTER_SUBMIT_OPTIONS.find((o) => o.value === current) ??
		AFTER_SUBMIT_OPTIONS[0];
	const triggerId = useId();
	const triggerRef = useRef<HTMLButtonElement>(null);

	const handleSelect = useCallback(
		(dest: PostSubmitDestination) => {
			updateForm(moduleIndex, formIndex, {
				post_submit: dest === defaultPostSubmit(formType) ? null : dest,
			});
		},
		[updateForm, moduleIndex, formIndex, formType],
	);

	const last = AFTER_SUBMIT_OPTIONS.length - 1;

	return (
		<div>
			<label
				htmlFor={triggerId}
				className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider mb-1.5 block"
			>
				After Submit
			</label>
			<Menu.Root>
				<Menu.Trigger
					ref={triggerRef}
					id={triggerId}
					className="group w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-nova-text bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30"
				>
					<span>{currentOption.label}</span>
					<svg
						aria-hidden="true"
						width="10"
						height="10"
						viewBox="0 0 10 10"
						className="text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
					>
						<path
							d="M2 3.5L5 6.5L8 3.5"
							stroke="currentColor"
							strokeWidth="1.2"
							fill="none"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</Menu.Trigger>

				<Menu.Portal>
					<Menu.Positioner
						side="bottom"
						align="start"
						sideOffset={4}
						anchor={triggerRef}
						className={MENU_SUBMENU_POSITIONER_CLS}
						style={{ minWidth: "var(--anchor-width)" }}
					>
						<Menu.Popup className={MENU_POPUP_CLS}>
							{AFTER_SUBMIT_OPTIONS.map((opt, i) => {
								const isActive = opt.value === current;
								const corners =
									i === 0 && i === last
										? "rounded-xl"
										: i === 0
											? "rounded-t-xl"
											: i === last
												? "rounded-b-xl"
												: "";

								return (
									<Menu.Item
										key={opt.value}
										onClick={() => handleSelect(opt.value)}
										className={`${corners} ${
											isActive
												? `${MENU_ITEM_BASE} text-nova-violet-bright bg-nova-violet/10 cursor-pointer`
												: MENU_ITEM_CLS
										}`}
									>
										<Icon
											icon={opt.icon}
											width="16"
											height="16"
											className={
												isActive
													? "text-nova-violet-bright"
													: "text-nova-text-muted"
											}
										/>
										<span className="flex-1 text-left">
											<div>{opt.label}</div>
											<div
												className={`text-xs leading-tight ${
													isActive
														? "text-nova-violet-bright/60"
														: "text-nova-text-muted"
												}`}
											>
												{opt.description}
											</div>
										</span>
									</Menu.Item>
								);
							})}
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>
		</div>
	);
}

// ── Connect Configuration Section ──────────────────────────────────────

/**
 * Compact labeled XPathField for settings panels. Shows the save shortcut
 * hint beside the label while the editor is active.
 */
function LabeledXPathField({
	label,
	required,
	value,
	onSave,
	getLintContext,
}: {
	label: string;
	required?: boolean;
	value: string;
	onSave: (value: string) => void;
	getLintContext: () => XPathLintContext | undefined;
}) {
	const [editing, setEditing] = useState(false);

	return (
		<div>
			<span className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-0.5 flex items-center gap-0.5">
				{label}
				{required && <span className="text-nova-rose">*</span>}
				{editing && <SaveShortcutHint />}
			</span>
			<XPathField
				value={value}
				onSave={onSave}
				getLintContext={getLintContext}
				onEditingChange={setEditing}
			/>
		</div>
	);
}

function ConnectSection({ moduleIndex, formIndex }: FormSettingsPanelProps) {
	const engine = useBuilderEngine();
	const form = useForm(moduleIndex, formIndex);
	const mod = useModule(moduleIndex);
	const updateFormAction = useBuilderStore((s) => s.updateForm);
	const connectType = useBuilderStore((s) => s.connectType) as
		| ConnectType
		| undefined;
	const connect = form?.connect;
	const enabled = !!connect;

	const save = useCallback(
		(config: ConnectConfig | null) => {
			updateFormAction(moduleIndex, formIndex, {
				connect: config,
			});
		},
		[updateFormAction, moduleIndex, formIndex],
	);

	const toggle = useCallback(() => {
		if (enabled) {
			if (connect && connectType) {
				engine.stashFormConnect(connectType, moduleIndex, formIndex, connect);
			}
			save(null);
		} else if (connectType) {
			const stashed = engine.getFormConnectStash(
				connectType,
				moduleIndex,
				formIndex,
			);
			if (stashed) {
				save(stashed);
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
		engine,
		mod,
		form,
		moduleIndex,
		formIndex,
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
									moduleIndex={moduleIndex}
									formIndex={formIndex}
								/>
							)}

							{/* Deliver config — sub-toggles for deliver_unit and task */}
							{connectType === "deliver" && (
								<DeliverConfig
									connect={connect}
									save={save}
									moduleIndex={moduleIndex}
									formIndex={formIndex}
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
	moduleIndex: number;
	formIndex: number;
}

/** Shared lint context getter for XPath fields in connect sub-configs.
 *  Reads from the Zustand store imperatively — always reflects latest state. */
function useConnectLintContext(moduleIndex: number, formIndex: number) {
	const builder = useBuilderEngine();
	return useCallback((): XPathLintContext | undefined => {
		const s = builder.store.getState();
		const moduleId = s.moduleOrder[moduleIndex];
		if (!moduleId) return undefined;
		const mod = s.modules[moduleId];
		const formIds = s.formOrder[moduleId];
		const formId = formIds?.[formIndex];
		if (!formId) return undefined;
		const formEntity = s.forms[formId];
		if (!formEntity) return undefined;
		const form = assembleForm(formEntity, formId, s.questions, s.questionOrder);
		const blueprint = assembleBlueprint(getEntityData(s));
		return { blueprint, form, moduleCaseType: mod?.caseType ?? undefined };
	}, [builder, moduleIndex, formIndex]);
}

// ── Learn Config Fields ────────────────────────────────────────────────

function LearnConfig({
	connect,
	save,
	moduleIndex,
	formIndex,
}: ConnectSubConfigProps) {
	const mod = useModule(moduleIndex);
	const form = useForm(moduleIndex, formIndex);
	const lm = connect.learn_module;
	const assessment = connect.assessment;
	const learnEnabled = !!lm;
	const assessmentEnabled = !!assessment;
	const lastLearnRef = useRef(lm);
	const lastAssessmentRef = useRef(assessment);
	if (lm) lastLearnRef.current = lm;
	if (assessment) lastAssessmentRef.current = assessment;
	const getLintContext = useConnectLintContext(moduleIndex, formIndex);

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
	moduleIndex,
	formIndex,
}: ConnectSubConfigProps) {
	const mod = useModule(moduleIndex);
	const form = useForm(moduleIndex, formIndex);
	const du = connect.deliver_unit;
	const task = connect.task;
	const deliverEnabled = !!du;
	const taskEnabled = !!task;
	const lastDeliverRef = useRef(du);
	const lastTaskRef = useRef(task);
	if (du) lastDeliverRef.current = du;
	if (task) lastTaskRef.current = task;
	const getLintContext = useConnectLintContext(moduleIndex, formIndex);

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

// ── Inline Field ───────────────────────────────────────────────────────

/**
 * Compact text field used inside FormSettingsPanel for connect configuration.
 * Shares the same commit/cancel/checkmark model as EditableText (via
 * useCommitField): blur or Enter commits, Escape cancels with stopPropagation,
 * and an emerald checkmark animates in the label for 1.5 s after a save.
 */
function InlineField({
	label,
	value,
	onChange,
	mono,
	multiline,
	placeholder,
	suffix,
	type = "text",
	required,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	mono?: boolean;
	multiline?: boolean;
	placeholder?: string;
	suffix?: string;
	type?: string;
	required?: boolean;
}) {
	const fieldId = useId();
	const {
		draft,
		setDraft,
		focused,
		saved,
		ref,
		handleFocus,
		handleBlur,
		handleKeyDown,
	} = useCommitField({
		value,
		onSave: onChange,
		required,
		multiline,
	});

	const Tag = multiline ? "textarea" : "input";

	return (
		<div>
			<label
				htmlFor={fieldId}
				className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-0.5 flex items-center gap-0.5"
			>
				{label}
				{required && <span className="text-nova-rose ml-0.5">*</span>}
				<SavedCheck
					visible={saved && !focused}
					size={10}
					className="shrink-0"
				/>
			</label>
			<div className="relative">
				<Tag
					id={fieldId}
					ref={ref as React.RefCallback<HTMLInputElement & HTMLTextAreaElement>}
					type={type === "number" ? "number" : "text"}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onFocus={handleFocus}
					onBlur={handleBlur}
					onKeyDown={handleKeyDown}
					placeholder={placeholder}
					autoComplete="off"
					data-1p-ignore
					rows={multiline ? 2 : undefined}
					min={type === "number" ? 1 : undefined}
					className={`w-full text-xs px-2 py-1.5 rounded-md border transition-colors outline-none resize-none ${
						mono ? "font-mono text-nova-violet-bright" : "text-nova-text"
					} ${
						focused
							? "bg-nova-surface border-nova-violet/50 shadow-[0_0_0_1px_rgba(139,92,246,0.1)]"
							: "bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30"
					} ${suffix ? "pr-8" : ""}`}
				/>
				{suffix && (
					<span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-nova-text-muted pointer-events-none">
						{suffix}
					</span>
				)}
			</div>
		</div>
	);
}
