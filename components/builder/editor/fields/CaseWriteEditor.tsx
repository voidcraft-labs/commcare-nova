/**
 * One field's local case-storage destination.
 *
 * The chooser commits only complete `{ caseType, property }` pairs. Every
 * existing and newly-authored pair is dry-run through the full mutation gate,
 * so impossible destinations stay visible with the exact reason they cannot
 * be chosen. Field ID remains independently owned by FieldIdentitySection.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerCircleOff from "@iconify-icons/tabler/circle-off";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerSearch from "@iconify-icons/tabler/search";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { INSPECTOR_LABEL_CLS } from "@/components/builder/inspector/inspectorChrome";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { propertyDisplayLabel } from "@/components/builder/shared/primitives/propertyDisplay";
import { Button } from "@/components/shadcn/button";
import {
	Combobox,
	ComboboxCollection,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxGroup,
	ComboboxInput,
	ComboboxItem,
	ComboboxLabel,
	ComboboxList,
	ComboboxTrigger,
} from "@/components/shadcn/combobox";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import type { CaseWriteChoiceVerdict } from "@/lib/doc/caseWriteChoices";
import { useEffectiveCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useCaseWriteChoices } from "@/lib/doc/hooks/useCaseWriteChoices";
import {
	type ProseProjector,
	useProseProjection,
} from "@/lib/doc/hooks/useProseProjection";
import {
	type AuthoredCasePropertyName,
	authoredCasePropertyNameSchema,
	type CaptureCaseWrite,
	type CaptureCaseWriteMode,
	type CaseProperty,
	type CaseType,
	type CaseWrite,
	type Field,
	getModuleCaseTypes,
	humanizeId,
	isCaptureField,
} from "@/lib/domain";

/**
 * Either destination shape a field's schema may carry.
 *
 * The capture kinds extend the pair with a `mode` naming what reaches the
 * case, because their answer is a file name rather than the value itself.
 */
type AuthoredCaseWrite = CaseWrite | CaptureCaseWrite;

import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { useSelectedFormContext } from "@/lib/routing/hooks";

interface CaseWriteChoice {
	readonly id: string;
	readonly group: string;
	readonly label: string;
	readonly detail: string;
	/** True when `detail` is a `#case-type/property` ref rather than prose:
	 *  a ref is a data value and sets in mono, prose sets in the sans. */
	readonly detailIsRef?: boolean;
	readonly searchText: string;
	readonly kind: "clear" | "destination" | "new";
	readonly caseWrite?: AuthoredCaseWrite;
	readonly disabledReason?: string;
}

interface CaseWriteChoiceGroup {
	readonly value: string;
	readonly items: readonly CaseWriteChoice[];
}

function destinationId(caseType: string, property: string): string {
	return JSON.stringify([caseType, property]);
}

function typeLabel(caseType: string): string {
	return humanizeId(caseType) || caseType;
}

function propertyChoice(
	caseType: CaseType,
	property: CaseProperty,
	caseWrite: AuthoredCaseWrite,
	verdict: CaseWriteChoiceVerdict,
	project: ProseProjector,
): CaseWriteChoice {
	const label = propertyDisplayLabel(property, project);
	return {
		id: destinationId(caseType.name, property.name),
		group: typeLabel(caseType.name),
		label,
		detail: verdict.ok ? `#${caseType.name}/${property.name}` : verdict.reason,
		detailIsRef: verdict.ok,
		searchText: `${caseType.name} ${property.name} ${label}`,
		kind: "destination",
		caseWrite,
		...(!verdict.ok && { disabledReason: verdict.reason }),
	};
}

/* The Select root's `items` map is what lets a bare <SelectValue /> render
 * the label; without it Base UI falls back to the raw stored value. */
const CAPTURE_MODE_LABELS: Readonly<Record<CaptureCaseWriteMode, string>> = {
	url: "A link to the file",
	attachment: "The file itself",
};

function nameError(value: string): string | null {
	const parsed = authoredCasePropertyNameSchema.safeParse(value);
	return parsed.success
		? null
		: (parsed.error.issues[0]?.message ?? "Choose a valid property name.");
}

export function CaseWriteEditor<F extends Field>(
	props: FieldEditorComponentProps<F, "caseWrite" & keyof F>,
) {
	const { field, value, onChange, label, autoFocus } = props;
	const context = useSelectedFormContext();
	const projectProse = useProseProjection();
	const effectiveCaseTypes = useEffectiveCaseTypes();
	const { choiceVerdict } = useCaseWriteChoices(field);
	const triggerId = useId();
	const newNameId = useId();
	const newTypeId = useId();
	const modeId = useId();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const newNameRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [creating, setCreating] = useState(false);
	const [newCaseType, setNewCaseType] = useState("");
	const [newName, setNewName] = useState("");
	const [rejection, setRejection] = useState<string | null>(null);

	const current =
		typeof value === "object" && value !== null
			? (value as unknown as AuthoredCaseWrite)
			: undefined;
	/**
	 * Whether this field's answer is a file rather than the value itself.
	 *
	 * What a capture puts in the case is a link, and the link's address comes
	 * from the CommCare HQ project space the app was published to. That is a
	 * fact about the destination, not a reason it cannot be chosen, so it is
	 * stated here rather than raised as a finding: every one of these
	 * destinations is admissible, and the commit gate the verdicts run
	 * through only ever reports states the document itself is in.
	 */
	const savesAttachment = isCaptureField(field);
	/**
	 * The destination shape this field's schema takes.
	 *
	 * An attachment's answer is a file name, so its destination also says
	 * what reaches the case — a link to the file, or the file itself. The
	 * mode carries forward when the author changes property, because
	 * picking a different destination is not a decision about what to put
	 * in it; only the mode control below changes the mode.
	 */
	const currentMode: CaptureCaseWriteMode =
		current !== undefined && "mode" in current
			? (current as CaptureCaseWrite).mode
			: "url";
	const destinationFor = useCallback(
		(
			caseType: string,
			property: AuthoredCasePropertyName,
			mode: CaptureCaseWriteMode = currentMode,
		): AuthoredCaseWrite =>
			isCaptureField(field)
				? { caseType, property, mode }
				: { caseType, property },
		[field, currentMode],
	);
	const writableTypeNames = useMemo(
		() =>
			context === null
				? []
				: getModuleCaseTypes(context.module.caseType, [...effectiveCaseTypes]),
		[context, effectiveCaseTypes],
	);
	const writableTypes = useMemo(
		() =>
			writableTypeNames.flatMap((caseTypeName) => {
				const caseType = effectiveCaseTypes.find(
					(candidate) => candidate.name === caseTypeName,
				);
				return caseType === undefined ? [] : [caseType];
			}),
		[effectiveCaseTypes, writableTypeNames],
	);
	const clearVerdict = choiceVerdict(null);
	const choices = useMemo<readonly CaseWriteChoice[]>(() => {
		const result: CaseWriteChoice[] = [
			{
				id: "__clear__",
				group: "Case data",
				label: "Don't save to case data",
				detail: clearVerdict.ok
					? "Keep this answer only in the form"
					: clearVerdict.reason,
				searchText: "none clear don't save form only",
				kind: "clear",
				...(!clearVerdict.ok && { disabledReason: clearVerdict.reason }),
			},
		];
		for (const caseType of writableTypes) {
			for (const property of caseType.properties) {
				const caseWrite = destinationFor(caseType.name, property.name);
				result.push(
					propertyChoice(
						caseType,
						property,
						caseWrite,
						choiceVerdict(caseWrite),
						projectProse,
					),
				);
			}
		}
		if (writableTypes.length > 0) {
			result.push({
				id: "__new__",
				group: "New",
				label: "Save to new property…",
				detail: "Name a new piece of case information",
				searchText: "new create property information",
				kind: "new",
			});
		}
		return result;
	}, [
		choiceVerdict,
		clearVerdict,
		destinationFor,
		projectProse,
		writableTypes,
	]);
	const groups = useMemo<readonly CaseWriteChoiceGroup[]>(() => {
		const order: string[] = [];
		const byGroup = new Map<string, CaseWriteChoice[]>();
		for (const choice of choices) {
			if (!byGroup.has(choice.group)) order.push(choice.group);
			const group = byGroup.get(choice.group) ?? [];
			group.push(choice);
			byGroup.set(choice.group, group);
		}
		return order.map((value) => ({
			value,
			items: byGroup.get(value) ?? [],
		}));
	}, [choices]);
	const selectedId =
		current === undefined
			? "__clear__"
			: destinationId(current.caseType, current.property);
	const selected = choices.find((choice) => choice.id === selectedId) ?? null;

	const commit = useCallback(
		(next: AuthoredCaseWrite | undefined) => {
			const outcome = onChange(next as F["caseWrite" & keyof F]);
			setRejection(outcome.ok ? null : (outcome.messages[0] ?? null));
			return outcome.ok;
		},
		[onChange],
	);
	const beginCreate = useCallback(() => {
		const startingType =
			current !== undefined && writableTypeNames.includes(current.caseType)
				? current.caseType
				: (writableTypeNames[0] ?? "");
		setNewCaseType(startingType);
		setNewName("");
		setRejection(null);
		setCreating(true);
		setOpen(false);
		requestAnimationFrame(() => newNameRef.current?.focus());
	}, [current, writableTypeNames]);

	const newPropertyError = newName.length === 0 ? null : nameError(newName);
	const parsedNewName = authoredCasePropertyNameSchema.safeParse(newName);
	const newChoiceVerdict =
		parsedNewName.success && newCaseType !== ""
			? choiceVerdict(destinationFor(newCaseType, parsedNewName.data))
			: null;
	const newChoiceError =
		newChoiceVerdict !== null && !newChoiceVerdict.ok
			? newChoiceVerdict.reason
			: null;
	const canCreate =
		parsedNewName.success &&
		newCaseType !== "" &&
		newChoiceVerdict?.ok === true;

	const displayLabel =
		current === undefined
			? "Don't save to case data"
			: (selected?.label ?? humanizeId(current.property));
	const displayDetail =
		current === undefined
			? "Form answer only"
			: `#${current.caseType}/${current.property}`;

	return (
		<div data-field-id="caseWrite" className="space-y-2.5">
			<label htmlFor={triggerId} className={`${INSPECTOR_LABEL_CLS} block`}>
				{label}
			</label>

			<Combobox
				items={groups}
				value={selected}
				open={open}
				onOpenChange={(nextOpen) => {
					setOpen(nextOpen);
					if (!nextOpen) setQuery("");
				}}
				inputValue={query}
				onInputValueChange={(nextQuery, details) => {
					setQuery(details.reason === "item-press" ? "" : nextQuery);
				}}
				onValueChange={(choice: CaseWriteChoice | null) => {
					if (choice === null || choice.disabledReason !== undefined) return;
					if (choice.kind === "new") {
						beginCreate();
						return;
					}
					const landed = commit(
						choice.kind === "clear" ? undefined : choice.caseWrite,
					);
					if (landed) setOpen(false);
				}}
				autoHighlight
				itemToStringLabel={(choice: CaseWriteChoice) => choice.label}
				itemToStringValue={(choice: CaseWriteChoice) => choice.id}
				isItemEqualToValue={(choice, selectedChoice) =>
					choice.id === selectedChoice.id
				}
				filter={(choice: CaseWriteChoice, currentQuery) => {
					const normalized = currentQuery.trim().toLocaleLowerCase();
					return (
						normalized === "" ||
						`${choice.label} ${choice.detail} ${choice.searchText}`
							.toLocaleLowerCase()
							.includes(normalized)
					);
				}}
			>
				<ComboboxTrigger
					ref={(node: HTMLButtonElement | null) => {
						triggerRef.current = node;
						if (node !== null && autoFocus) {
							node.focus({ preventScroll: true });
						}
					}}
					id={triggerId}
					render={
						<Button type="button" variant="field" className="w-full min-w-0" />
					}
					aria-label={`${label}: ${displayLabel}, ${displayDetail}`}
				>
					<span className="flex min-w-0 flex-1 items-start gap-2">
						<Icon
							icon={current === undefined ? tablerCircleOff : tablerDatabase}
							width="16"
							height="16"
							className="mt-0.5 shrink-0 text-nova-violet-bright"
						/>
						<span className="min-w-0 flex-1">
							<span className="block break-words text-sm font-medium text-nova-text">
								{displayLabel}
							</span>
							{/* A `#case-type/property` ref is a data value, and the
							 * design system names it in the same breath as field ids
							 * and formulas: mono, not the UI sans. "Form answer only"
							 * is prose, so it stays in the sans. */}
							<span
								className={`mt-0.5 block break-all text-xs font-normal text-nova-text-muted${
									current === undefined ? "" : " font-mono"
								}`}
							>
								{displayDetail}
							</span>
						</span>
					</span>
				</ComboboxTrigger>
				<ComboboxContent
					align="start"
					aria-label="Choose where this answer is saved"
					className="w-80"
				>
					<header className="px-3 pb-2.5 pt-3">
						<h3 className="font-display tracking-tighter text-[15px] font-semibold text-nova-text">
							Choose case information
						</h3>
						<p className="mt-1 text-xs leading-relaxed text-nova-text-muted">
							{savesAttachment
								? "Saves a link to the attached file, not the file itself"
								: "The question name and saved case property are independent"}
						</p>
					</header>
					<div className="border-y border-white/[0.06] pb-2">
						<ComboboxInput
							aria-label="Search case information"
							placeholder="Search properties"
							showTrigger={false}
							showClear={query !== ""}
							clearLabel="Clear search"
							onClear={() => setQuery("")}
							startAdornment={
								<Icon
									icon={tablerSearch}
									width="15"
									height="15"
									className="text-nova-text-muted"
								/>
							}
							autoComplete="off"
							data-1p-ignore
							className="mx-2 mt-2 w-auto"
						/>
					</div>
					<ComboboxEmpty>
						<div>
							<p className="font-medium text-nova-text">
								No matching case information
							</p>
							<p className="mt-1 text-xs text-nova-text-muted">
								Try another name or create a new property
							</p>
						</div>
					</ComboboxEmpty>
					<ComboboxList>
						{(group: CaseWriteChoiceGroup) => (
							<ComboboxGroup key={group.value} items={group.items}>
								<ComboboxLabel>{group.value}</ComboboxLabel>
								<ComboboxCollection>
									{(choice: CaseWriteChoice) => (
										<ComboboxItem
											key={choice.id}
											value={choice}
											disabled={choice.disabledReason !== undefined}
											className="min-w-0 whitespace-normal"
										>
											<Icon
												icon={
													choice.kind === "clear"
														? tablerCircleOff
														: choice.kind === "new"
															? tablerPlus
															: tablerDatabase
												}
												width="16"
												height="16"
												className="shrink-0 text-nova-text-muted"
											/>
											<span className="min-w-0 flex-1 text-left">
												<span className="block break-words font-medium">
													{choice.label}
												</span>
												<span
													className={`mt-0.5 block break-words text-xs leading-relaxed text-nova-text-muted${
														choice.detailIsRef ? " font-mono" : ""
													}`}
												>
													{choice.detail}
												</span>
											</span>
										</ComboboxItem>
									)}
								</ComboboxCollection>
							</ComboboxGroup>
						)}
					</ComboboxList>
				</ComboboxContent>
			</Combobox>

			{context !== null && writableTypes.length === 0 && (
				<p className="text-[13px] leading-5 text-nova-text-muted">
					No case type is available here yet.
				</p>
			)}

			{savesAttachment && current !== undefined && (
				<div className="space-y-1.5">
					<label htmlFor={modeId} className={`${INSPECTOR_LABEL_CLS} block`}>
						What reaches the case
					</label>
					<Select
						items={CAPTURE_MODE_LABELS}
						value={currentMode}
						onValueChange={(next) => {
							if (next === null) return;
							commit(
								destinationFor(
									current.caseType,
									current.property,
									next as CaptureCaseWriteMode,
								),
							);
						}}
					>
						<SelectTrigger id={modeId}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Object.entries(CAPTURE_MODE_LABELS).map(([mode, label]) => (
								<SelectItem key={mode} value={mode}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="text-[13px] leading-5 text-nova-text-muted">
						{currentMode === "url"
							? "Nova fills this link in once the app reaches a CommCare project space, so it stays empty in the preview and in a download made before then."
							: "CommCare stores the file on the case. The project space needs the Multimedia Case Properties setting, which Dimagi is retiring, and nothing in the app can show a case attachment, so a link is the better choice unless you already rely on this."}
					</p>
				</div>
			)}

			{creating && (
				<div className="space-y-3 rounded-lg border border-white/[0.06] bg-nova-deep/35 p-3">
					<div>
						<label
							htmlFor={newTypeId}
							className={`${INSPECTOR_LABEL_CLS} mb-1.5 block`}
						>
							Case type
						</label>
						<Select
							value={newCaseType}
							onValueChange={(next) => {
								if (next !== null) setNewCaseType(next);
							}}
						>
							<SelectTrigger
								id={newTypeId}
								wrapValue
								className="min-h-11 w-full"
							>
								<SelectValue>{typeLabel(newCaseType)}</SelectValue>
							</SelectTrigger>
							<SelectContent align="start">
								<SelectGroup>
									<SelectLabel>Writable case types</SelectLabel>
									{writableTypes.map((caseType) => (
										<SelectItem key={caseType.name} value={caseType.name} wrap>
											{typeLabel(caseType.name)}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</div>
					<div>
						<label
							htmlFor={newNameId}
							className={`${INSPECTOR_LABEL_CLS} mb-1.5 block`}
						>
							Property name
						</label>
						<Input
							ref={newNameRef}
							id={newNameId}
							value={newName}
							onChange={(event) => setNewName(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && canCreate) {
									event.preventDefault();
									if (commit(destinationFor(newCaseType, parsedNewName.data))) {
										setCreating(false);
									}
								}
							}}
							aria-invalid={
								newPropertyError !== null || newChoiceError !== null
							}
							aria-describedby={`${newNameId}-help${
								newPropertyError !== null || newChoiceError !== null
									? ` ${newNameId}-error`
									: ""
							}`}
							placeholder="for example, preferred_language"
							autoComplete="off"
							data-1p-ignore
							className="min-h-11"
						/>
						<p
							id={`${newNameId}-help`}
							className="mt-1.5 text-xs leading-relaxed text-nova-text-muted"
						>
							Start with a letter; use letters, numbers, underscores, or hyphens
						</p>
						{(newPropertyError !== null || newChoiceError !== null) && (
							<p
								id={`${newNameId}-error`}
								role="alert"
								className="mt-1.5 text-xs leading-relaxed text-nova-rose"
							>
								{newPropertyError ?? newChoiceError}
							</p>
						)}
					</div>
					<div className="flex flex-wrap justify-end gap-2">
						<Button
							type="button"
							variant="ghost"
							className=""
							onClick={() => {
								setCreating(false);
								requestAnimationFrame(() => triggerRef.current?.focus());
							}}
						>
							Cancel
						</Button>
						<Button
							type="button"
							className=""
							disabled={!canCreate}
							onClick={() => {
								if (!parsedNewName.success) return;
								if (commit(destinationFor(newCaseType, parsedNewName.data))) {
									setCreating(false);
								}
							}}
						>
							Save to property
						</Button>
					</div>
				</div>
			)}

			<RejectionInline message={rejection} />
		</div>
	);
}
