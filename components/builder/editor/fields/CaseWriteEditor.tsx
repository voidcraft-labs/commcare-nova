/**
 * A question's "Saves to": one row per write of its answer.
 *
 * A question holds no destination. A form saves case data only through its
 * case operations, and what a question saves to is the view of the writes
 * that save its answer as it is (`lib/domain/caseWriteViews.ts`, read through
 * `useFieldCaseWrites`). So this editor lists that view, one row per write,
 * and every choice it offers is planned by the one "Saves to" planner
 * (`lib/doc/fieldCaseWriteMutations.ts::planFieldCaseWrite`): a row's choice
 * replaces that row's write, and with no row a choice adds the first.
 *
 * Each choice is checked on demand through the full mutation gate in a
 * worker (`useCaseWriteChoiceVerdicts`); an admitted verdict carries the
 * exact batch it judged, and that batch is what commits. A refused choice
 * stays in the menu, disabled with the planner's or the gate's sentence.
 *
 * A row on a change the planner does not write for a question (an update of
 * another case, a write through a case above) is read-only here and offers
 * Edit in case changes, which opens that change.
 *
 * The pure state of a row (what it reads, its guidance, its preload line)
 * is `caseWriteRowModel.ts`.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowRight from "@iconify-icons/tabler/arrow-right";
import tablerCircleOff from "@iconify-icons/tabler/circle-off";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerSearch from "@iconify-icons/tabler/search";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { operationSentence } from "@/components/builder/case-operations/operationSentence";
import { useOperationSentenceContext } from "@/components/builder/case-operations/useOperationSentenceContext";
import { INSPECTOR_LABEL_CLS } from "@/components/builder/inspector/inspectorChrome";
import { RejectionInline } from "@/components/builder/RejectionNotice";
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
import type { CaseWriteVerdictCandidate } from "@/lib/doc/caseWriteVerdictWorkerProtocol";
import type { FieldCaseWriteDestination } from "@/lib/doc/fieldCaseWriteMutations";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCaseOperation } from "@/lib/doc/hooks/useCaseOperationFacts";
import { useEffectiveCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useCaseWriteChoiceVerdicts } from "@/lib/doc/hooks/useCaseWriteChoices";
import { useFieldCaseWrites } from "@/lib/doc/hooks/useFieldCaseWrites";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import { useUserProperties } from "@/lib/doc/hooks/useUserCollections";
import type { Mutation } from "@/lib/doc/types";
import {
	authoredCasePropertyNameSchema,
	type CaseType,
	type Field,
	type FieldCaseWriteView,
	type FieldCaseWriteViewKey,
	type Form,
	getModuleCaseTypes,
	humanizeId,
	isCaptureField,
	type Module,
	USERCASE_CASE_TYPE,
} from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { propertyDisplayLabel } from "@/lib/domain/propertyDisplay";
import { useNavigate, useSelectedFormContext } from "@/lib/routing/hooks";
import { destinationRef } from "./caseWritePresentation";
import { type CaseWriteRowModel, caseWriteRowModel } from "./caseWriteRowModel";

const NO_DESTINATION_TEXT = "Doesn't save to a case";
const CHECK_UNAVAILABLE =
	"Nova couldn't check this destination yet. Try choosing it again.";
const AVAILABLE: CaseWriteChoiceVerdict = {
	ok: true,
	mutations: [],
	notes: [],
};

interface DestinationChoice {
	readonly id: string;
	readonly group: string;
	readonly label: string;
	readonly detail: string;
	/** True when `detail` is a `#case-type/property` ref rather than prose:
	 *  a ref is a data value and sets in mono, prose sets in the sans. */
	readonly detailIsRef?: boolean;
	readonly searchText: string;
	readonly kind: "clear" | "destination" | "new";
	readonly destination?: FieldCaseWriteDestination;
	readonly disabledReason?: string;
}

interface DestinationChoiceGroup {
	readonly value: string;
	readonly items: readonly DestinationChoice[];
}

type FormContext = { readonly module: Module; readonly form: Form };

function destinationId(caseType: string, property: string): string {
	return JSON.stringify([caseType, property]);
}

/** One choice's verdict key: where it saves, and the row it replaces. */
function candidateKey(
	destination: FieldCaseWriteDestination | null,
	replace: FieldCaseWriteViewKey | undefined,
): string {
	return JSON.stringify([destination, replace ?? null]);
}

function candidate(
	destination: FieldCaseWriteDestination | null,
	replace: FieldCaseWriteViewKey | undefined,
): CaseWriteVerdictCandidate {
	return {
		key: candidateKey(destination, replace),
		destination,
		...(replace !== undefined && { replace }),
	};
}

function typeLabel(caseType: string): string {
	return humanizeId(caseType) || caseType;
}

function nameError(value: string): string | null {
	const parsed = authoredCasePropertyNameSchema.safeParse(value);
	return parsed.success
		? null
		: (parsed.error.issues[0]?.message ?? "Choose a valid property name.");
}

/** A property's name as the author reads it, by case type. */
function usePropertyLabel(): (caseType: string, property: string) => string {
	const caseTypes = useEffectiveCaseTypes();
	const workerProperties = useUserProperties();
	const project = useProseProjection();
	return useCallback(
		(caseType: string, property: string) => {
			if (caseType === USERCASE_CASE_TYPE) {
				const worker = workerProperties.find(
					(candidate) => candidate.slug === property,
				);
				return worker?.label || worker?.slug || property;
			}
			const declared = caseTypes
				.find((candidate) => candidate.name === caseType)
				?.properties.find((candidate) => candidate.name === property);
			return declared === undefined
				? humanizeId(property) || property
				: propertyDisplayLabel(declared, project);
		},
		[caseTypes, workerProperties, project],
	);
}

export function CaseWriteEditor<F extends Field>(
	props: FieldEditorComponentProps<F, "uuid" & keyof F>,
) {
	const { field, label, autoFocus } = props;
	const views = useFieldCaseWrites(field.uuid);
	const context = useSelectedFormContext();
	return (
		<div data-field-id="caseWrite" className="space-y-2.5">
			<span className={`${INSPECTOR_LABEL_CLS} block`}>{label}</span>
			{views.length === 0 ? (
				<DestinationRow
					field={field}
					context={context}
					view={undefined}
					label={label}
					autoFocus={autoFocus}
				/>
			) : (
				views.map((view, index) => (
					<CaseWriteRow
						key={JSON.stringify([
							view.operationUuid,
							view.slot,
							view.property,
							view.via ?? null,
						])}
						field={field}
						context={context}
						view={view}
						label={label}
						autoFocus={autoFocus === true && index === 0}
					/>
				))
			)}
		</div>
	);
}

/** One write of the view: editable, or read-only on another change. */
function CaseWriteRow({
	field,
	context,
	view,
	label,
	autoFocus,
}: {
	readonly field: Field;
	readonly context: FormContext | null;
	readonly view: FieldCaseWriteView;
	readonly label: string;
	readonly autoFocus: boolean | undefined;
}) {
	const model = useRowModel(field, context, view);
	if (model?.readOnly === true) {
		return <ReadOnlyRow view={view} model={model} context={context} />;
	}
	return (
		<DestinationRow
			field={field}
			context={context}
			view={view}
			label={label}
			autoFocus={autoFocus}
		/>
	);
}

function useRowModel(
	field: Field,
	context: FormContext | null,
	view: FieldCaseWriteView | undefined,
): CaseWriteRowModel | undefined {
	const propertyLabel = usePropertyLabel();
	const sentenceContext = useOperationSentenceContext(context?.form.uuid);
	const operation = useCaseOperation(context?.form.uuid, view?.operationUuid);
	return useMemo(() => {
		if (view === undefined || context === null) return undefined;
		return caseWriteRowModel({
			view,
			field,
			form: context.form,
			module: context.module,
			propertyLabel,
			operationDescription: () =>
				operation === undefined
					? undefined
					: operationSentence(operation, sentenceContext).lead,
		});
	}, [view, context, field, propertyLabel, operation, sentenceContext]);
}

/** A write the question's planner does not own: named, and opened on the
 *  case changes screen. */
function ReadOnlyRow({
	view,
	model,
	context,
}: {
	readonly view: FieldCaseWriteView;
	readonly model: CaseWriteRowModel;
	readonly context: FormContext | null;
}) {
	const navigate = useNavigate();
	return (
		<div className="space-y-2 rounded-lg border border-white/[0.06] bg-nova-deep/35 p-3">
			<p className="flex items-start gap-2">
				<Icon
					icon={tablerDatabase}
					width="16"
					height="16"
					aria-hidden="true"
					className="mt-0.5 shrink-0 text-nova-violet-bright"
				/>
				<span className="min-w-0 flex-1">
					<span className="block break-words text-sm font-medium text-nova-text">
						{model.destination}
					</span>
					<span className="mt-0.5 block break-all font-mono text-xs text-nova-text-muted">
						{destinationRef(view.caseType, view.property)}
					</span>
				</span>
			</p>
			{context !== null && (
				<Button
					type="button"
					variant="ghost"
					onClick={() =>
						navigate.openFormOperations(
							context.module.uuid,
							context.form.uuid,
							view.operationUuid,
						)
					}
					className="w-full justify-between"
				>
					Edit in case changes
					<Icon icon={tablerArrowRight} width="15" height="15" />
				</Button>
			)}
		</div>
	);
}

/**
 * The destination menu for one row, or for a question with no row yet,
 * with the row's guidance, its preload line and its stop action.
 */
function DestinationRow({
	field,
	context,
	view,
	label,
	autoFocus,
}: {
	readonly field: Field;
	readonly context: FormContext | null;
	readonly view: FieldCaseWriteView | undefined;
	readonly label: string;
	readonly autoFocus: boolean | undefined;
}) {
	const projectProse = useProseProjection();
	const effectiveCaseTypes = useEffectiveCaseTypes();
	const workerProperties = useUserProperties();
	const model = useRowModel(field, context, view);
	const {
		inline: { commitMany },
	} = useBlueprintMutations();

	const triggerId = useId();
	const newNameId = useId();
	const newTypeId = useId();
	const guidanceId = useId();
	const preloadId = useId();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const newNameRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [creating, setCreating] = useState(false);
	const [newCaseType, setNewCaseType] = useState("");
	const [newName, setNewName] = useState("");
	const [checking, setChecking] = useState(false);
	const [rejection, setRejection] = useState<string | null>(null);
	const attemptRef = useRef(0);
	useEffect(
		() => () => {
			attemptRef.current += 1;
		},
		[],
	);

	const replace = model?.viewKey;
	const moduleCaseType = context?.module.caseType;
	const writableTypes = useMemo<readonly CaseType[]>(
		() =>
			getModuleCaseTypes(moduleCaseType, [...effectiveCaseTypes]).flatMap(
				(name) => {
					const caseType = effectiveCaseTypes.find(
						(candidate) => candidate.name === name,
					);
					return caseType === undefined ? [] : [caseType];
				},
			),
		[effectiveCaseTypes, moduleCaseType],
	);

	const verdictCandidates = useMemo<readonly CaseWriteVerdictCandidate[]>(
		() => [
			candidate(null, replace),
			...writableTypes.flatMap((caseType) =>
				caseType.properties.map((property) =>
					candidate(
						{ caseType: caseType.name, property: property.name },
						replace,
					),
				),
			),
			...workerProperties.map((property) =>
				candidate(
					{ caseType: USERCASE_CASE_TYPE, property: property.slug },
					replace,
				),
			),
		],
		[replace, workerProperties, writableTypes],
	);
	const { verdicts, evaluating, ensureVerdict } = useCaseWriteChoiceVerdicts(
		field,
		verdictCandidates,
		open || creating,
	);
	/* A verdict that has not arrived yet stays selectable; choosing a row
	 * awaits the exact verdict before anything commits. */
	const verdictOf = useCallback(
		(destination: FieldCaseWriteDestination | null) =>
			verdicts.get(candidateKey(destination, replace)) ?? AVAILABLE,
		[verdicts, replace],
	);

	const groups = useMemo<readonly DestinationChoiceGroup[]>(() => {
		const offered = (
			group: string,
			label: string,
			searchText: string,
			destination: FieldCaseWriteDestination,
		): DestinationChoice => {
			const verdict = verdictOf(destination);
			return {
				id: destinationId(destination.caseType, destination.property),
				group,
				label,
				detail: verdict.ok
					? destinationRef(destination.caseType, destination.property)
					: verdict.reason,
				detailIsRef: verdict.ok,
				searchText,
				kind: "destination",
				destination,
				...(!verdict.ok && { disabledReason: verdict.reason }),
			};
		};
		const result: DestinationChoiceGroup[] = [];
		const [ownType, ...childTypes] = writableTypes;
		if (ownType !== undefined) {
			result.push({
				value: "This form's case",
				items: ownType.properties.map((property) => {
					const label = propertyDisplayLabel(property, projectProse);
					return offered(
						"This form's case",
						label,
						`${ownType.name} ${property.name} ${label}`,
						{ caseType: ownType.name, property: property.name },
					);
				}),
			});
		}
		const childItems = childTypes.flatMap((caseType) =>
			caseType.properties.map((property) => {
				const label = `${typeLabel(caseType.name)} · ${propertyDisplayLabel(property, projectProse)}`;
				return offered(
					"New cases",
					label,
					`new ${caseType.name} ${property.name} ${label}`,
					{ caseType: caseType.name, property: property.name },
				);
			}),
		);
		if (childItems.length > 0)
			result.push({ value: "New cases", items: childItems });
		// The worker's own record: the destinations are exactly the worker
		// details declared under Worker information in App setup, so a missing
		// one is added there rather than invented here.
		if (workerProperties.length > 0) {
			result.push({
				value: "The worker's record",
				items: workerProperties.map((property) =>
					offered(
						"The worker's record",
						property.label || property.slug,
						`worker user ${property.slug} ${property.label}`,
						{ caseType: USERCASE_CASE_TYPE, property: property.slug },
					),
				),
			});
		}
		const clearVerdict = verdictOf(null);
		const more: DestinationChoice[] = [
			{
				id: "__clear__",
				group: "More choices",
				label: "Don't save to a case",
				detail: clearVerdict.ok
					? "Keep this answer only in the form"
					: clearVerdict.reason,
				searchText: "none clear don't save form only",
				kind: "clear",
				...(!clearVerdict.ok && { disabledReason: clearVerdict.reason }),
			},
		];
		if (writableTypes.length > 0) {
			more.push({
				id: "__new__",
				group: "More choices",
				label: "Save to new property",
				detail: "Name a new piece of case information",
				searchText: "new create property information",
				kind: "new",
			});
		}
		result.push({ value: "More choices", items: more });
		return result;
	}, [projectProse, verdictOf, workerProperties, writableTypes]);

	const selectedId =
		view === undefined
			? "__clear__"
			: destinationId(view.caseType, view.property);
	const selected =
		groups
			.flatMap((group) => group.items)
			.find((choice) => choice.id === selectedId) ?? null;

	const commit = useCallback(
		(mutations: readonly Mutation[]): boolean => {
			const outcome = commitMany([...mutations]);
			setRejection(outcome.ok ? null : (outcome.messages[0] ?? null));
			return outcome.ok;
		},
		[commitMany],
	);
	/** Await the exact verdict for one choice, then commit the batch it
	 *  judged. */
	const choose = useCallback(
		(destination: FieldCaseWriteDestination | null, onLanded?: () => void) => {
			const attempt = ++attemptRef.current;
			setChecking(true);
			void ensureVerdict(candidate(destination, replace)).then((verdict) => {
				if (attemptRef.current !== attempt) return;
				setChecking(false);
				if (verdict === undefined) {
					setRejection(CHECK_UNAVAILABLE);
					return;
				}
				if (!verdict.ok) {
					setRejection(verdict.reason);
					return;
				}
				if (commit(verdict.mutations)) onLanded?.();
			});
		},
		[commit, ensureVerdict, replace],
	);

	const newPropertyError = newName.length === 0 ? null : nameError(newName);
	const parsedNewName = authoredCasePropertyNameSchema.safeParse(newName);
	const canCreate = parsedNewName.success && newCaseType !== "" && !checking;
	const createProperty = () => {
		if (!parsedNewName.success || checking) return;
		choose({ caseType: newCaseType, property: parsedNewName.data }, () =>
			setCreating(false),
		);
	};
	const beginCreate = () => {
		const names = writableTypes.map((caseType) => caseType.name);
		setNewCaseType(
			view !== undefined && names.includes(view.caseType)
				? view.caseType
				: (names[0] ?? ""),
		);
		setNewName("");
		setChecking(false);
		setRejection(null);
		setCreating(true);
		setOpen(false);
		requestAnimationFrame(() => newNameRef.current?.focus());
	};

	const displayLabel = model?.destination ?? NO_DESTINATION_TEXT;
	const displayDetail =
		view === undefined
			? "Form answer only"
			: destinationRef(view.caseType, view.property);
	const guidance = model?.guidance;
	const describedBy = [
		...(guidance?.help === undefined ? [] : [guidanceId]),
		...(model?.preload === undefined ? [] : [preloadId]),
	];
	const savesFile = isCaptureField(field);

	return (
		<div className="space-y-2">
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
				onValueChange={(choice: DestinationChoice | null) => {
					if (choice === null || choice.disabledReason !== undefined) return;
					if (choice.kind === "new") {
						beginCreate();
						return;
					}
					if (choice.id === selectedId) {
						setOpen(false);
						return;
					}
					choose(
						choice.kind === "clear" ? null : (choice.destination ?? null),
						() => setOpen(false),
					);
				}}
				autoHighlight
				itemToStringLabel={(choice: DestinationChoice) => choice.label}
				itemToStringValue={(choice: DestinationChoice) => choice.id}
				isItemEqualToValue={(choice, selectedChoice) =>
					choice.id === selectedChoice.id
				}
				filter={(choice: DestinationChoice, currentQuery) => {
					const normalized = currentQuery.trim().toLocaleLowerCase();
					return (
						normalized === "" ||
						`${choice.label} ${choice.detail} ${choice.searchText}`
							.toLocaleLowerCase()
							.includes(normalized)
					);
				}}
				onItemHighlighted={(choice: DestinationChoice | undefined) => {
					if (choice === undefined || choice.kind === "new") return;
					void ensureVerdict(
						candidate(
							choice.kind === "clear" ? null : (choice.destination ?? null),
							replace,
						),
					);
				}}
			>
				<ComboboxTrigger
					ref={(node: HTMLButtonElement | null) => {
						triggerRef.current = node;
						if (node !== null && autoFocus) node.focus({ preventScroll: true });
					}}
					id={triggerId}
					render={
						<Button type="button" variant="field" className="w-full min-w-0" />
					}
					aria-label={`${label}: ${displayLabel}, ${displayDetail}`}
					aria-describedby={
						describedBy.length === 0 ? undefined : describedBy.join(" ")
					}
				>
					<span className="flex min-w-0 flex-1 items-start gap-2">
						<Icon
							icon={view === undefined ? tablerCircleOff : tablerDatabase}
							width="16"
							height="16"
							className="mt-0.5 shrink-0 text-nova-violet-bright"
						/>
						<span className="min-w-0 flex-1">
							<span className="block break-words text-sm font-medium text-nova-text">
								{displayLabel}
							</span>
							{/* A `#case-type/property` ref is a data value: mono. "Form
							 * answer only" is prose, so it stays in the sans. */}
							<span
								className={`mt-0.5 block break-all text-xs font-normal text-nova-text-muted${
									view === undefined ? "" : " font-mono"
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
							Choose where this answer is saved
						</h3>
						<p className="mt-1 text-xs leading-relaxed text-nova-text-muted">
							{savesFile
								? "Saves a link to the attached file"
								: "The question name and saved case property are independent"}
						</p>
						{evaluating && (
							<p
								role="status"
								className="mt-1 text-xs leading-relaxed text-nova-text-muted"
							>
								Checking availability
							</p>
						)}
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
						{(group: DestinationChoiceGroup) => (
							<ComboboxGroup key={group.value} items={group.items}>
								<ComboboxLabel>{group.value}</ComboboxLabel>
								<ComboboxCollection>
									{(choice: DestinationChoice) => (
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

			{guidance?.help !== undefined && (
				<p
					id={guidanceId}
					className={
						guidance.warning
							? "rounded-xl border border-nova-amber/25 bg-nova-amber/[0.05] p-2.5 text-[13px] leading-5 text-nova-text-secondary"
							: "text-[13px] leading-5 text-nova-text-muted"
					}
				>
					{guidance.help}
				</p>
			)}

			{model?.preload !== undefined && (
				<div className="space-y-1">
					<p
						id={preloadId}
						className="text-[13px] leading-5 text-nova-text-muted"
					>
						{model.preload.line}
					</p>
					<Button
						type="button"
						variant="ghost"
						onClick={() => {
							if (model.preload !== undefined)
								commit([model.preload.action.mutation]);
						}}
						className="-ml-2"
					>
						{model.preload.action.label}
					</Button>
				</div>
			)}

			{view?.link === true && (
				<p className="text-[13px] leading-5 text-nova-text-muted">
					{guidance?.writesEverySelectedCase
						? "Nova fills this link in once the app reaches a CommCare project space. A download made before that cannot fill it."
						: "Nova fills this link in once the app reaches a CommCare project space, so it stays empty in the preview and in a download made before then."}
				</p>
			)}

			{context !== null &&
				writableTypes.length === 0 &&
				workerProperties.length === 0 && (
					<p className="text-[13px] leading-5 text-nova-text-muted">
						No case type is available here yet.
					</p>
				)}

			{view !== undefined && (
				<Button
					type="button"
					variant="ghost"
					disabled={checking}
					onClick={() => choose(null)}
					className="-ml-2"
				>
					Stop saving this answer
				</Button>
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
							disabled={checking}
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
									<SelectLabel>Case types this form can save to</SelectLabel>
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
							disabled={checking}
							onChange={(event) => setNewName(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && canCreate) {
									event.preventDefault();
									createProperty();
								}
							}}
							aria-invalid={newPropertyError !== null}
							aria-describedby={`${newNameId}-help${
								newPropertyError !== null ? ` ${newNameId}-error` : ""
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
						{newPropertyError !== null && (
							<p
								id={`${newNameId}-error`}
								role="alert"
								className="mt-1.5 text-xs leading-relaxed text-nova-rose"
							>
								{newPropertyError}
							</p>
						)}
					</div>
					<div className="flex flex-wrap justify-end gap-2">
						<Button
							type="button"
							variant="ghost"
							onClick={() => {
								attemptRef.current += 1;
								setChecking(false);
								setCreating(false);
								requestAnimationFrame(() => triggerRef.current?.focus());
							}}
						>
							Cancel
						</Button>
						<Button
							type="button"
							disabled={!canCreate}
							onClick={createProperty}
						>
							{checking ? "Checking property" : "Save to property"}
						</Button>
					</div>
				</div>
			)}

			<RejectionInline message={rejection} />
		</div>
	);
}
