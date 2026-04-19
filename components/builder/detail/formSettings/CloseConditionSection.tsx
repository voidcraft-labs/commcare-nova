"use client";
import { Menu } from "@base-ui/react/menu";
import { AnimatePresence, motion } from "motion/react";
import { useId, useMemo, useRef } from "react";
import { FieldPicker } from "@/components/ui/FieldPicker";
import { useBlueprintDocShallow } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useForm } from "@/lib/doc/hooks/useEntity";
import { asUuid, type Uuid } from "@/lib/doc/types";
import {
	MENU_ITEM_BASE,
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_SUBMENU_POSITIONER_CLS,
} from "@/lib/styles";
import { findFieldById } from "./findFieldById";
import { InlineField } from "./InlineField";

/**
 * Form-settings panel prop shape. The close-condition, after-submit, and
 * connect sections all accept the same `{ moduleUuid, formUuid }` pair
 * from the parent shell — declared locally because the shell doesn't need
 * an exported type and each section owns its own props contract.
 */
interface FormSettingsPanelProps {
	moduleUuid: Uuid;
	formUuid: Uuid;
}

/** Two-valued mode switch: auto-close ("always") vs. predicate ("conditional"). */
type CloseMode = "always" | "conditional";

/** Options for the top-level close-behavior dropdown. */
const CLOSE_MODE_OPTIONS: Array<{ value: CloseMode; label: string }> = [
	{ value: "always", label: "Always" },
	{ value: "conditional", label: "When condition is met" },
];

/**
 * Close-behavior dropdown rendered only for close forms. The top-level
 * mode switch toggles between "Always" (the default — the form closes
 * the case unconditionally on submit) and "When condition is met". The
 * conditional branch reveals a field picker, an operator selector
 * ("is" / "has selected"), and a value input. When the referenced field
 * carries a finite option list, the value selector swaps to a dropdown
 * of those options; otherwise a plain text input is shown. HQ wraps
 * string values in quotes automatically, so users type literal values
 * rather than XPath expressions.
 */
export function CloseConditionSection({ formUuid }: FormSettingsPanelProps) {
	const form = useForm(formUuid);
	const { updateForm: updateFormAction } = useBlueprintMutations();
	const triggerId = useId();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const operatorTriggerRef = useRef<HTMLButtonElement>(null);
	const valueTriggerRef = useRef<HTMLButtonElement>(null);

	/* Subscribe to the doc's normalized field + order maps. Shallow
	 * equality short-circuits re-renders when an entity map's identity
	 * changes but the referenced slice stays reference-stable (Immer
	 * structural sharing). FieldPicker + close-field resolution both
	 * consume the same slice so the doc walks once per render. */
	const { fields, fieldOrder } = useBlueprintDocShallow((s) => ({
		fields: s.fields,
		fieldOrder: s.fieldOrder,
	}));
	const closeFieldId = form?.closeCondition?.field;

	/* Resolve the referenced field to check if it has selectable options. */
	const selectedFieldOptions = useMemo(() => {
		if (!closeFieldId) return undefined;
		const found = findFieldById(fields, fieldOrder, formUuid, closeFieldId);
		if (!found) return undefined;
		// `options` only exists on select kinds; narrow via `in`.
		return "options" in found && found.options && found.options.length > 0
			? found.options
			: undefined;
	}, [closeFieldId, fields, fieldOrder, formUuid]);

	if (form?.type !== "close") return null;

	const currentMode: CloseMode = form.closeCondition ? "conditional" : "always";
	const currentLabel =
		CLOSE_MODE_OPTIONS.find((o) => o.value === currentMode)?.label ?? "Always";
	const operator = form.closeCondition?.operator ?? "=";

	const handleSelect = (mode: CloseMode) => {
		if (mode === "always") {
			updateFormAction(asUuid(formUuid), { closeCondition: undefined });
		} else {
			updateFormAction(asUuid(formUuid), {
				closeCondition: { field: "", answer: "" },
			});
		}
	};

	const updateCondition = (
		patch: Partial<{
			field: string;
			answer: string;
			operator: "=" | "selected";
		}>,
	) => {
		const current = form.closeCondition ?? { field: "", answer: "" };
		updateFormAction(asUuid(formUuid), {
			closeCondition: { ...current, ...patch },
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
							{/* Field picker — autocomplete of form fields. Reads the
							 *  doc's normalized fields + order maps directly; no
							 *  intermediate assembled-questions shape. */}
							<FieldPicker
								source={{ fields, fieldOrder }}
								parentUuid={formUuid}
								value={form.closeCondition.field}
								onChange={(v) => updateCondition({ field: v })}
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
