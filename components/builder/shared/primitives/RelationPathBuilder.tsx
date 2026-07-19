// components/builder/shared/primitives/RelationPathBuilder.tsx
//
// Lossless editor for every RelationPath shape. A path is never normalized on
// render: multi-step ancestor walks, per-step case-type qualifiers, qualified
// child walks, direction-agnostic walks, and explicit self paths all stay
// structurally intact until the author edits the corresponding control.
//
// The editor deliberately uses a vertical, full-width layout. Relation paths
// can appear several predicate levels deep, where a horizontal row of compact
// controls becomes unreadable and eventually overflows. Each ancestor hop gets
// its own lightweight step surface instead.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerTrash from "@iconify-icons/tabler/trash";
import { type ReactNode, useId, useRef, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import { Button } from "@/components/shadcn/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import type { CaseType } from "@/lib/domain";
import { humanizeId } from "@/lib/domain/idSlug";
import {
	ancestorPath,
	anyRelationPath,
	type RelationPath,
	type RelationStep,
	relationStep,
	selfPath,
	subcasePath,
	XML_ELEMENT_NAME_PATTERN,
} from "@/lib/domain/predicate";
import {
	type ExpressionChangeAdmission,
	usePredicateEditContext,
} from "../editorContext";
import { removeAndRestoreFocus } from "../focusAfterRemoval";

interface RelationPathBuilderProps {
	readonly value: RelationPath;
	readonly onChange: (next: RelationPath) => void;
	readonly invalid?: boolean;
	/**
	 * Whether this slot may explicitly stay on the current case. Property refs
	 * and count expressions allow it; exists / missing do not, because a
	 * self-relation is an invalid quantifier. A saved self path still renders
	 * losslessly when false, but it cannot be selected again after leaving it.
	 */
	readonly allowSelf?: boolean;
	readonly admitChange?: (next: RelationPath) => ExpressionChangeAdmission;
}

type RelationKind = RelationPath["kind"];

const DEFAULT_IDENTIFIER = "parent";
const NO_CASE_TYPE = "__nova_no_case_type__";

const KIND_OPTIONS: readonly {
	readonly value: RelationKind;
	readonly label: string;
	readonly description: string;
}[] = [
	{
		value: "self",
		label: "This case",
		description: "Use information on the current case",
	},
	{
		value: "ancestor",
		label: "Parent or ancestor",
		description: "Follow one or more connections upward",
	},
	{
		value: "subcase",
		label: "Child case",
		description: "Follow a connection to a child case",
	},
	{
		value: "any-relation",
		label: "Any related case",
		description: "Follow the connection in either direction",
	},
];

function isRelationKind(value: string): value is RelationKind {
	return KIND_OPTIONS.some((option) => option.value === value);
}

function kindLabel(kind: RelationKind): string {
	return KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

type RelationCaseType = Pick<CaseType, "name" | "parent_type">;

function caseTypeLabel(name: string): string {
	return humanizeId(name);
}

function directChildCaseTypes(
	originCaseType: string,
	caseTypes: readonly RelationCaseType[],
): RelationCaseType[] {
	return caseTypes.filter(
		(caseType) => caseType.parent_type === originCaseType,
	);
}

function anyRelatedCaseTypes(
	originCaseType: string,
	caseTypes: readonly RelationCaseType[],
): RelationCaseType[] {
	const parent = declaredParentCaseType(originCaseType, caseTypes);
	return [
		...(parent === undefined ? [] : [parent]),
		...directChildCaseTypes(originCaseType, caseTypes),
	].filter(
		(candidate, index, all) =>
			all.findIndex((other) => other.name === candidate.name) === index,
	);
}

function availableCaseTypesForSingleRelation(
	kind: "subcase" | "any-relation",
	identifier: string,
	originCaseType: string,
	caseTypes: readonly RelationCaseType[],
): RelationCaseType[] {
	// `parent` is the only relationship name represented in the case-type
	// graph. A custom index may target any declared type, including the same
	// type, so the author must choose explicitly instead of receiving a false
	// graph-derived default.
	if (identifier !== DEFAULT_IDENTIFIER) return [...caseTypes];
	return kind === "subcase"
		? directChildCaseTypes(originCaseType, caseTypes)
		: anyRelatedCaseTypes(originCaseType, caseTypes);
}

function declaredParentCaseType(
	originCaseType: string,
	caseTypes: readonly RelationCaseType[],
): RelationCaseType | undefined {
	const origin = caseTypes.find((caseType) => caseType.name === originCaseType);
	if (origin?.parent_type === undefined) return undefined;
	return caseTypes.find((caseType) => caseType.name === origin.parent_type);
}

function relationKindIsAvailable(
	kind: RelationKind,
	caseTypes: readonly RelationCaseType[],
	allowSelf: boolean,
): boolean {
	switch (kind) {
		case "self":
			return allowSelf;
		case "ancestor":
		case "subcase":
		case "any-relation":
			// The graph only describes the canonical `parent` index. Saved custom
			// indexes may reach any declared case type (including a graph leaf), so
			// direction choices stay available whenever there is a type to choose.
			return caseTypes.length > 0;
	}
}

function relationKindHasAutomaticPath(
	kind: Exclude<RelationKind, "self">,
	originCaseType: string,
	caseTypes: readonly RelationCaseType[],
): boolean {
	switch (kind) {
		case "ancestor":
			return declaredParentCaseType(originCaseType, caseTypes) !== undefined;
		case "subcase":
			return directChildCaseTypes(originCaseType, caseTypes).length > 0;
		case "any-relation":
			return anyRelatedCaseTypes(originCaseType, caseTypes).length > 0;
	}
}

function customRelationPath(
	kind: Exclude<RelationKind, "self">,
	identifier: string,
	destinationCaseType: string,
): RelationPath {
	switch (kind) {
		case "ancestor":
			return ancestorPath(relationStep(identifier, destinationCaseType));
		case "subcase":
			return subcasePath(identifier, destinationCaseType);
		case "any-relation":
			return anyRelationPath(identifier, destinationCaseType);
	}
}

function unavailableKindDescription(
	kind: RelationKind,
	originCaseType: string,
): string {
	const originLabel = caseTypeLabel(originCaseType);
	switch (kind) {
		case "self":
			return "This condition must look at a related case";
		case "ancestor":
			return `${originLabel} doesn't have an available parent case`;
		case "subcase":
			return `${originLabel} doesn't have an available child case`;
		case "any-relation":
			return `${originLabel} doesn't have an available related case`;
	}
}

/** Preserve the fields shared by the two downward-looking variants. A kind
 * switch is an explicit structural edit, but switching child <-> either-way
 * need not discard the relationship or optional destination qualifier. */
function changeKind(
	value: RelationPath,
	nextKind: RelationKind,
	originCaseType: string,
	caseTypes: readonly RelationCaseType[],
): RelationPath {
	if (value.kind === nextKind) return value;

	if (nextKind === "self") return selfPath();

	const savedIdentifier =
		value.kind === "self"
			? DEFAULT_IDENTIFIER
			: value.kind === "ancestor"
				? value.via[0].identifier
				: value.identifier;
	const identifier = XML_ELEMENT_NAME_PATTERN.test(savedIdentifier)
		? savedIdentifier
		: DEFAULT_IDENTIFIER;
	const children = directChildCaseTypes(originCaseType, caseTypes);
	const anyRelated = anyRelatedCaseTypes(originCaseType, caseTypes);
	const savedChildType =
		value.kind === "subcase" || value.kind === "any-relation"
			? value.ofCaseType
			: undefined;
	const childType =
		savedChildType !== undefined &&
		children.some((caseType) => caseType.name === savedChildType)
			? savedChildType
			: children[0]?.name;

	switch (nextKind) {
		case "ancestor":
			return ancestorPath(relationStep(identifier));
		case "subcase":
			return subcasePath(identifier, childType);
		case "any-relation":
			return anyRelationPath(
				identifier,
				savedChildType !== undefined &&
					anyRelated.some((caseType) => caseType.name === savedChildType)
					? savedChildType
					: anyRelated[0]?.name,
			);
	}
}

/** Whether changing direction would discard path structure the destination
 * shape cannot represent. Child → either-way is lossless. Either-way → child
 * is lossless only when the selected destination really is a child; an
 * ancestor target needs the existing replacement confirmation. */
function relationChangeLosesStructure(
	value: RelationPath,
	nextKind: RelationKind,
	originCaseType: string,
	caseTypes: readonly RelationCaseType[],
): boolean {
	if (value.kind === nextKind || value.kind === "self") return false;
	if (nextKind === "self") return true;
	if (value.kind === "subcase" && nextKind === "any-relation") {
		return false;
	}
	if (value.kind === "any-relation" && nextKind === "subcase") {
		const related = anyRelatedCaseTypes(originCaseType, caseTypes);
		const selected =
			value.ofCaseType ?? (related.length === 1 ? related[0]?.name : undefined);
		return !directChildCaseTypes(originCaseType, caseTypes).some(
			(candidate) => candidate.name === selected,
		);
	}
	if (value.kind === "ancestor") {
		return value.via.length > 1 || value.via[0].throughCaseType !== undefined;
	}
	return value.ofCaseType !== undefined;
}

interface RelationReplacementCopy {
	readonly title: string;
	readonly description: string;
}

function relationReplacementCopy(
	value: RelationPath,
	nextKind: RelationKind,
): RelationReplacementCopy {
	if (nextKind === "self") {
		if (value.kind === "ancestor" && value.via.length > 1) {
			return {
				title: "Use information from this case?",
				description: `${value.via.length} parent connections will be removed. You can undo this change.`,
			};
		}
		return {
			title: "Use information from this case?",
			description:
				"The current case connection will be removed. You can undo this change.",
		};
	}
	const target =
		nextKind === "any-relation"
			? "any related case"
			: `a ${kindLabel(nextKind).toLocaleLowerCase()}`;
	if (value.kind === "ancestor" && value.via.length > 1) {
		return {
			title: `Look at ${target} instead?`,
			description:
				"Connections after the first will be removed. You can undo this change.",
		};
	}
	return {
		title: `Look at ${target} instead?`,
		description:
			"The current destination will be replaced. You can undo this change.",
	};
}

function withAncestorStep(
	path: Extract<RelationPath, { kind: "ancestor" }>,
	index: number,
	nextStep: RelationStep,
): Extract<RelationPath, { kind: "ancestor" }> {
	const steps = path.via.map((step, stepIndex) =>
		stepIndex === index ? nextStep : step,
	) as [RelationStep, ...RelationStep[]];
	return ancestorPath(steps[0], ...steps.slice(1));
}

function withoutAncestorStep(
	path: Extract<RelationPath, { kind: "ancestor" }>,
	index: number,
	originCaseType: string,
	caseTypes: readonly RelationCaseType[],
): Extract<RelationPath, { kind: "ancestor" }> | undefined {
	const steps = path.via.filter((_, stepIndex) => stepIndex !== index) as [
		RelationStep,
		...RelationStep[],
	];
	return rebuildValidAncestorPath(steps, originCaseType, caseTypes);
}

function ancestorRemovalConsequence(
	path: Extract<RelationPath, { kind: "ancestor" }>,
	removedIndex: number,
	nextPath: Extract<RelationPath, { kind: "ancestor" }>,
): string | null {
	const survivingSteps = path.via.filter((_, index) => index !== removedIndex);
	const changes = survivingSteps.flatMap((step, index) => {
		const nextStep = nextPath.via[index];
		if (
			step.throughCaseType === undefined ||
			step.throughCaseType === nextStep.throughCaseType
		) {
			return [];
		}
		return [
			{
				from: caseTypeLabel(step.throughCaseType),
				to:
					nextStep.throughCaseType === undefined
						? "automatic case type"
						: caseTypeLabel(nextStep.throughCaseType),
			},
		];
	});

	if (changes.length === 0) return null;
	if (changes.length === 1) {
		return `A remaining connection will lead to ${changes[0].to} instead of ${changes[0].from}`;
	}
	return `The destinations of ${changes.length} later connections will change to keep the connection valid`;
}

interface AncestorStepContext {
	readonly originCaseType: string;
	readonly parentCaseType: string | undefined;
	readonly qualifierIsValid: boolean;
}

function ancestorStepContexts(
	steps: readonly RelationStep[],
	originCaseType: string,
	caseTypes: readonly RelationCaseType[],
): readonly AncestorStepContext[] {
	const caseTypesByName = new Map(
		caseTypes.map((caseType) => [caseType.name, caseType]),
	);
	let currentCaseType: string | undefined = originCaseType;
	return steps.map((step) => {
		const origin = currentCaseType ?? "";
		if (step.identifier !== DEFAULT_IDENTIFIER) {
			const explicitDestination = caseTypesByName.has(
				step.throughCaseType ?? "",
			)
				? step.throughCaseType
				: undefined;
			currentCaseType = explicitDestination;
			return {
				originCaseType: origin,
				parentCaseType: explicitDestination,
				qualifierIsValid: explicitDestination !== undefined,
			};
		}
		const parentName =
			currentCaseType === undefined
				? undefined
				: caseTypesByName.get(currentCaseType)?.parent_type;
		const parentCaseType =
			parentName !== undefined && caseTypesByName.has(parentName)
				? parentName
				: undefined;
		currentCaseType = parentCaseType;
		return {
			originCaseType: origin,
			parentCaseType,
			qualifierIsValid:
				step.throughCaseType === undefined ||
				step.throughCaseType === parentCaseType,
		};
	});
}

/** Rebind explicit case-type hints after a structural edit. A hint describes
 * the destination at its POSITION in the walk, so removing an earlier step
 * changes the only valid value for every following hint. Relationship names
 * remain byte-for-byte intact; only the now-stale hints are repaired. */
function rebuildValidAncestorPath(
	steps: readonly [RelationStep, ...RelationStep[]],
	originCaseType: string,
	caseTypes: readonly RelationCaseType[],
): Extract<RelationPath, { kind: "ancestor" }> | undefined {
	const contexts = ancestorStepContexts(steps, originCaseType, caseTypes);
	if (
		contexts.some((context) => context.parentCaseType === undefined) ||
		steps.some((step) => !XML_ELEMENT_NAME_PATTERN.test(step.identifier))
	) {
		return undefined;
	}
	const rebound = steps.map((step, index) =>
		step.throughCaseType === undefined
			? relationStep(step.identifier)
			: relationStep(step.identifier, contexts[index].parentCaseType),
	) as [RelationStep, ...RelationStep[]];
	return ancestorPath(rebound[0], ...rebound.slice(1));
}

/**
 * Full-width RelationPath editor. Rendering is side-effect free; only direct
 * interaction emits a new path. Every same-kind edit changes one field and
 * preserves the rest of the source structure verbatim.
 */
export function RelationPathBuilder({
	value,
	onChange,
	invalid = false,
	allowSelf = true,
	admitChange,
}: RelationPathBuilderProps) {
	const ctx = usePredicateEditContext();
	const id = useId();
	const kindTriggerRef = useRef<HTMLButtonElement>(null);
	const [pendingKindChange, setPendingKindChange] = useState<{
		readonly source: RelationPath;
		readonly target: RelationKind;
	} | null>(null);
	const [pendingCustomKindChange, setPendingCustomKindChange] = useState<{
		readonly source: RelationPath;
		readonly target: Exclude<RelationKind, "self">;
		readonly identifier: string;
		readonly destinationCaseType?: string;
	} | null>(null);
	const [blockedReason, setBlockedReason] = useState<string | null>(null);
	const commitChange = (next: RelationPath) => {
		const verdict = admitChange?.(next) ?? { admitted: true as const };
		if (!verdict.admitted) {
			setBlockedReason(verdict.reason);
			return;
		}
		setBlockedReason(null);
		onChange(next);
	};
	const currentKind = KIND_OPTIONS.find(
		(option) => option.value === value.kind,
	);
	const relationKinds = KIND_OPTIONS.map((option) => {
		const structurallyAvailable = relationKindIsAvailable(
			option.value,
			ctx.caseTypes,
			allowSelf,
		);
		const hasAutomaticCandidate =
			option.value === "self" ||
			relationKindHasAutomaticPath(
				option.value,
				ctx.currentCaseType,
				ctx.caseTypes,
			);
		const candidate = hasAutomaticCandidate
			? changeKind(value, option.value, ctx.currentCaseType, ctx.caseTypes)
			: undefined;
		const admission =
			option.value === value.kind || candidate === undefined
				? ({ admitted: true } as const)
				: (admitChange?.(candidate) ?? { admitted: true as const });
		const available =
			option.value === value.kind ||
			(structurallyAvailable && admission.admitted);
		return {
			...option,
			available,
			description: !structurallyAvailable
				? unavailableKindDescription(option.value, ctx.currentCaseType)
				: !admission.admitted
					? admission.reason
					: available
						? option.value !== "self" &&
							!relationKindHasAutomaticPath(
								option.value,
								ctx.currentCaseType,
								ctx.caseTypes,
							)
							? "Choose a saved connection and the case type it reaches"
							: option.description
						: unavailableKindDescription(option.value, ctx.currentCaseType),
		};
	});
	const customIdentifier = pendingCustomKindChange?.identifier.trim() ?? "";
	const customIdentifierIsValid =
		XML_ELEMENT_NAME_PATTERN.test(customIdentifier) &&
		customIdentifier !== DEFAULT_IDENTIFIER;
	const customCandidate =
		pendingCustomKindChange !== null &&
		pendingCustomKindChange.destinationCaseType !== undefined &&
		customIdentifierIsValid
			? customRelationPath(
					pendingCustomKindChange.target,
					customIdentifier,
					pendingCustomKindChange.destinationCaseType,
				)
			: undefined;
	const customAdmission =
		customCandidate === undefined
			? ({ admitted: true } as const)
			: (admitChange?.(customCandidate) ?? { admitted: true as const });
	const pendingKindChangeCopy =
		pendingKindChange === null
			? null
			: relationReplacementCopy(
					pendingKindChange.source,
					pendingKindChange.target,
				);

	return (
		<div className="min-w-0 space-y-3">
			<Field>
				<FieldLabel htmlFor={`${id}-kind`}>Where to look</FieldLabel>
				<Select
					value={value.kind}
					onValueChange={(next) => {
						if (next === null || !isRelationKind(next)) return;
						if (!relationKindIsAvailable(next, ctx.caseTypes, allowSelf)) {
							return;
						}
						if (
							next !== "self" &&
							!relationKindHasAutomaticPath(
								next,
								ctx.currentCaseType,
								ctx.caseTypes,
							)
						) {
							setPendingCustomKindChange({
								source: value,
								target: next,
								identifier: "",
							});
							return;
						}
						if (
							relationChangeLosesStructure(
								value,
								next,
								ctx.currentCaseType,
								ctx.caseTypes,
							)
						) {
							setPendingKindChange({ source: value, target: next });
							return;
						}
						commitChange(
							changeKind(value, next, ctx.currentCaseType, ctx.caseTypes),
						);
					}}
				>
					<SelectTrigger
						ref={kindTriggerRef}
						id={`${id}-kind`}
						aria-label="Where to look"
						aria-invalid={invalid}
						className="h-11 w-full"
					>
						<SelectValue>{kindLabel(value.kind)}</SelectValue>
					</SelectTrigger>
					<SelectContent align="start">
						{relationKinds.map((option) => (
							<SelectItem
								key={option.value}
								value={option.value}
								disabled={!option.available}
								className="items-start py-2.5"
							>
								<span className="min-w-0">
									<span className="block">{option.label}</span>
									<span className="block text-xs font-normal text-nova-text-muted">
										{option.description}
									</span>
								</span>
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{currentKind !== undefined ? (
					<FieldDescription>{currentKind.description}</FieldDescription>
				) : null}
				{value.kind === "self" && !allowSelf ? (
					<p className="text-sm text-nova-rose">
						This condition must look at a related case. Choose another place to
						look
					</p>
				) : null}
				{blockedReason !== null ? (
					<p role="alert" className="text-sm leading-relaxed text-nova-rose">
						{blockedReason}
					</p>
				) : null}
			</Field>

			{value.kind === "ancestor" ? (
				<AncestorSteps
					id={id}
					value={value}
					onChange={commitChange}
					caseTypes={ctx.caseTypes}
					originCaseType={ctx.currentCaseType}
					invalid={invalid}
					fallbackFocus={() => kindTriggerRef.current}
					admitChange={admitChange}
				/>
			) : null}

			{value.kind === "subcase" || value.kind === "any-relation" ? (
				<SingleRelationship
					id={id}
					value={value}
					onChange={commitChange}
					caseTypes={ctx.caseTypes}
					originCaseType={ctx.currentCaseType}
					invalid={invalid}
					admitChange={admitChange}
				/>
			) : null}

			<AlertDialog
				open={pendingKindChange !== null}
				onOpenChange={(open) => {
					if (open) return;
					setPendingKindChange(null);
				}}
			>
				<AlertDialogContent finalFocus={kindTriggerRef} className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle className="font-display">
							{pendingKindChangeCopy?.title ?? "Change where this value looks?"}
						</AlertDialogTitle>
						<AlertDialogDescription className="text-left">
							{pendingKindChangeCopy?.description ??
								"The current connection will be replaced. You can undo this change."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								const pending = pendingKindChange;
								setPendingKindChange(null);
								if (pending === null || pending.source !== value) return;
								commitChange(
									changeKind(
										pending.source,
										pending.target,
										ctx.currentCaseType,
										ctx.caseTypes,
									),
								);
							}}
						>
							Replace connection
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<Dialog
				open={pendingCustomKindChange !== null}
				onOpenChange={(open) => {
					if (open) return;
					setPendingCustomKindChange(null);
				}}
			>
				<DialogContent finalFocus={kindTriggerRef} className="text-left">
					<DialogHeader>
						<DialogTitle className="font-display">
							Use a saved connection
						</DialogTitle>
						<DialogDescription className="text-left">
							Nova can’t choose a connection automatically. Choose the saved
							connection and the case type it reaches.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 py-1">
						<Field>
							<FieldLabel htmlFor={`${id}-custom-identifier`}>
								Connection name
							</FieldLabel>
							<Input
								id={`${id}-custom-identifier`}
								value={pendingCustomKindChange?.identifier ?? ""}
								onChange={(event) =>
									setPendingCustomKindChange((pending) =>
										pending === null
											? null
											: { ...pending, identifier: event.target.value },
									)
								}
								autoComplete="off"
								data-1p-ignore
								aria-invalid={
									customIdentifier.length > 0 && !customIdentifierIsValid
								}
							/>
							<FieldDescription>
								Use the name already stored for this relationship, such as
								guardian or host
							</FieldDescription>
							{customIdentifier.length > 0 && !customIdentifierIsValid ? (
								<p role="alert" className="text-sm text-nova-rose">
									Use a custom saved name with letters, numbers, or underscores
								</p>
							) : null}
						</Field>

						<Field>
							<FieldLabel htmlFor={`${id}-custom-destination`}>
								Related case type
							</FieldLabel>
							<Select
								value={
									pendingCustomKindChange?.destinationCaseType ?? NO_CASE_TYPE
								}
								onValueChange={(next) =>
									setPendingCustomKindChange((pending) =>
										pending === null
											? null
											: {
													...pending,
													destinationCaseType:
														next === null || next === NO_CASE_TYPE
															? undefined
															: next,
												},
									)
								}
							>
								<SelectTrigger
									id={`${id}-custom-destination`}
									aria-label="Related case type"
									className="h-11 w-full"
								>
									<SelectValue>
										{pendingCustomKindChange?.destinationCaseType === undefined
											? "Choose a case type"
											: caseTypeLabel(
													pendingCustomKindChange.destinationCaseType,
												)}
									</SelectValue>
								</SelectTrigger>
								<SelectContent align="start">
									<SelectItem value={NO_CASE_TYPE} disabled>
										Choose a case type
									</SelectItem>
									{ctx.caseTypes.map((caseType) => {
										const candidateAdmission =
											pendingCustomKindChange === null ||
											!customIdentifierIsValid
												? ({ admitted: true } as const)
												: (admitChange?.(
														customRelationPath(
															pendingCustomKindChange.target,
															customIdentifier,
															caseType.name,
														),
													) ?? { admitted: true as const });
										return (
											<SelectItem
												key={caseType.name}
												value={caseType.name}
												disabled={!candidateAdmission.admitted}
												wrap
											>
												<span className="min-w-0">
													<span className="block">
														{caseTypeLabel(caseType.name)}
													</span>
													{!candidateAdmission.admitted ? (
														<span className="block text-xs font-normal text-nova-text-muted">
															{candidateAdmission.reason}
														</span>
													) : null}
												</span>
											</SelectItem>
										);
									})}
								</SelectContent>
							</Select>
						</Field>
					</div>
					{customAdmission.admitted === false ? (
						<p role="alert" className="text-sm leading-relaxed text-nova-rose">
							{customAdmission.reason}
						</p>
					) : null}
					<DialogFooter>
						<DialogClose render={<Button variant="outline" />}>
							Cancel
						</DialogClose>
						<Button
							disabled={
								!customIdentifierIsValid ||
								pendingCustomKindChange?.destinationCaseType === undefined ||
								!customAdmission.admitted
							}
							onClick={() => {
								const pending = pendingCustomKindChange;
								if (
									pending === null ||
									pending.source !== value ||
									pending.destinationCaseType === undefined ||
									!customIdentifierIsValid
								) {
									return;
								}
								setPendingCustomKindChange(null);
								commitChange(
									customRelationPath(
										pending.target,
										customIdentifier,
										pending.destinationCaseType,
									),
								);
							}}
						>
							Use connection
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function AncestorSteps({
	id,
	value,
	onChange,
	caseTypes,
	originCaseType,
	invalid,
	fallbackFocus,
	admitChange,
}: {
	readonly id: string;
	readonly value: Extract<RelationPath, { kind: "ancestor" }>;
	readonly onChange: (next: RelationPath) => void;
	readonly caseTypes: readonly RelationCaseType[];
	readonly originCaseType: string;
	readonly invalid: boolean;
	readonly fallbackFocus: () => HTMLElement | null;
	readonly admitChange?: (next: RelationPath) => ExpressionChangeAdmission;
}) {
	const [pendingRemoval, setPendingRemoval] = useState<{
		readonly nextPath: Extract<RelationPath, { kind: "ancestor" }>;
		readonly trigger: HTMLElement;
		readonly consequence: string;
	} | null>(null);
	const contexts = ancestorStepContexts(value.via, originCaseType, caseTypes);
	const pathIsValid =
		contexts.every(
			(context) =>
				context.parentCaseType !== undefined && context.qualifierIsValid,
		) &&
		value.via.every((step) => XML_ELEMENT_NAME_PATTERN.test(step.identifier));
	const finalCaseType = contexts.at(-1)?.parentCaseType;
	const nextParent =
		pathIsValid && finalCaseType !== undefined
			? declaredParentCaseType(finalCaseType, caseTypes)
			: undefined;
	const addParentPath =
		nextParent === undefined
			? undefined
			: ancestorPath(
					value.via[0],
					...value.via.slice(1),
					relationStep(DEFAULT_IDENTIFIER),
				);
	const addParentAdmission =
		addParentPath === undefined
			? ({ admitted: true } as const)
			: (admitChange?.(addParentPath) ?? { admitted: true as const });
	const pendingRemovalAdmission =
		pendingRemoval === null
			? ({ admitted: true } as const)
			: (admitChange?.(pendingRemoval.nextPath) ?? { admitted: true as const });
	const removeStep = (
		trigger: HTMLElement,
		nextPath: Extract<RelationPath, { kind: "ancestor" }>,
		index: number,
	) => {
		const consequence = ancestorRemovalConsequence(value, index, nextPath);
		if (consequence !== null) {
			setPendingRemoval({ nextPath, trigger, consequence });
			return;
		}
		removeAndRestoreFocus(trigger, () => onChange(nextPath), {
			preferredSelector: "[data-removal-primary-focus]",
			fallback: fallbackFocus,
		});
	};

	return (
		<div className="min-w-0 space-y-2">
			{value.via.map((step, index) => {
				const context = contexts[index];
				const removablePath =
					value.via.length > 1
						? withoutAncestorStep(value, index, originCaseType, caseTypes)
						: undefined;
				const originLabel =
					context.originCaseType === ""
						? "Unavailable case"
						: caseTypeLabel(context.originCaseType);
				const destinationLabel =
					context.parentCaseType === undefined
						? "Unavailable parent"
						: caseTypeLabel(context.parentCaseType);
				const removalAdmission =
					removablePath === undefined
						? ({ admitted: true } as const)
						: (admitChange?.(removablePath) ?? { admitted: true as const });
				return (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: ordered relation steps have no identity beyond their position, and relationship names may repeat
						key={index}
						className="min-w-0 space-y-3 rounded-lg border border-white/[0.06] bg-nova-deep/30 p-3"
						data-removal-focus-row
					>
						<div className="flex min-h-8 items-center justify-between gap-3">
							<p className="text-sm font-medium text-nova-text">
								{originLabel} to {destinationLabel}
							</p>
							{removablePath !== undefined ? (
								<Button
									type="button"
									variant="ghost"
									size="xl"
									onClick={(event) =>
										removeStep(event.currentTarget, removablePath, index)
									}
									disabled={!removalAdmission.admitted}
									aria-label={`Remove connection from ${originLabel} to ${destinationLabel}`}
									data-removal-action
									className="min-h-11 text-nova-text-muted not-disabled:hover:text-nova-rose"
								>
									<Icon icon={tablerTrash} />
									Remove
								</Button>
							) : null}
						</div>
						{!removalAdmission.admitted ? (
							<p className="text-[12px] leading-relaxed text-nova-text-muted">
								{removalAdmission.reason}
							</p>
						) : null}

						{step.identifier !== DEFAULT_IDENTIFIER ||
						!context.qualifierIsValid ||
						context.parentCaseType === undefined ? (
							<OptionalCaseTypeSelect
								id={`${id}-case-type-${index}`}
								label="Related case type"
								value={step.throughCaseType}
								caseTypes={
									step.identifier === DEFAULT_IDENTIFIER
										? context.parentCaseType === undefined
											? []
											: [context.parentCaseType]
										: caseTypes.map((caseType) => caseType.name)
								}
								allowAutomatic={
									step.identifier === DEFAULT_IDENTIFIER &&
									context.parentCaseType !== undefined
								}
								automaticLabel={
									context.parentCaseType === undefined
										? "Use the parent case type"
										: `Use ${caseTypeLabel(context.parentCaseType)}`
								}
								emptyMessage={`No parent case type is connected to ${originLabel}`}
								onChange={(caseType) =>
									onChange(
										withAncestorStep(
											value,
											index,
											relationStep(step.identifier, caseType),
										),
									)
								}
								admitChange={(caseType) =>
									admitChange?.(
										withAncestorStep(
											value,
											index,
											relationStep(step.identifier, caseType),
										),
									) ?? { admitted: true }
								}
								invalid={invalid || !context.qualifierIsValid}
							/>
						) : null}

						<RelationshipSettings
							needsRepair={!XML_ELEMENT_NAME_PATTERN.test(step.identifier)}
						>
							<RelationshipNameField
								key={step.identifier}
								id={`${id}-identifier-${index}`}
								value={step.identifier}
								onCommit={(identifier) => {
									const graphParent = declaredParentCaseType(
										context.originCaseType,
										caseTypes,
									)?.name;
									const destination =
										identifier === DEFAULT_IDENTIFIER
											? graphParent
											: (step.throughCaseType ?? context.parentCaseType);
									if (destination === undefined) return;
									onChange(
										withAncestorStep(
											value,
											index,
											relationStep(identifier, destination),
										),
									);
								}}
								admitCommit={(identifier) => {
									const graphParent = declaredParentCaseType(
										context.originCaseType,
										caseTypes,
									)?.name;
									const destination =
										identifier === DEFAULT_IDENTIFIER
											? graphParent
											: (step.throughCaseType ?? context.parentCaseType);
									return destination === undefined
										? { admitted: true }
										: (admitChange?.(
												withAncestorStep(
													value,
													index,
													relationStep(identifier, destination),
												),
											) ?? { admitted: true });
								}}
							/>
						</RelationshipSettings>
					</div>
				);
			})}

			{addParentPath !== undefined ? (
				<Button
					type="button"
					variant="outline"
					size="xl"
					onClick={() => onChange(addParentPath)}
					disabled={!addParentAdmission.admitted}
					className="w-full"
					data-removal-focus-fallback
				>
					<Icon icon={tablerPlus} />
					Add another parent
				</Button>
			) : null}
			{!addParentAdmission.admitted ? (
				<p className="text-[12px] leading-relaxed text-nova-text-muted">
					{addParentAdmission.reason}
				</p>
			) : null}

			<AlertDialog
				open={pendingRemoval !== null}
				onOpenChange={(open) => {
					if (open) return;
					const trigger = pendingRemoval?.trigger;
					setPendingRemoval(null);
					queueMicrotask(() => trigger?.isConnected && trigger.focus());
				}}
			>
				<AlertDialogContent className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle className="font-display">
							Remove this connection?
						</AlertDialogTitle>
						<AlertDialogDescription className="text-left">
							{pendingRemoval?.consequence ??
								"A remaining connection will reach a different case type"}
							. The remaining connections will update automatically. You can
							undo this change.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={!pendingRemovalAdmission.admitted}
							onClick={() => {
								const pending = pendingRemoval;
								setPendingRemoval(null);
								if (pending === null) return;
								removeAndRestoreFocus(
									pending.trigger,
									() => onChange(pending.nextPath),
									{
										preferredSelector: "[data-removal-primary-focus]",
										fallback: fallbackFocus,
									},
								);
							}}
						>
							Remove connection
						</AlertDialogAction>
					</AlertDialogFooter>
					{!pendingRemovalAdmission.admitted ? (
						<p className="text-sm leading-relaxed text-nova-rose">
							{pendingRemovalAdmission.reason}
						</p>
					) : null}
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

function SingleRelationship({
	id,
	value,
	onChange,
	caseTypes,
	originCaseType,
	invalid,
	admitChange,
}: {
	readonly id: string;
	readonly value: Extract<RelationPath, { kind: "subcase" | "any-relation" }>;
	readonly onChange: (next: RelationPath) => void;
	readonly caseTypes: readonly RelationCaseType[];
	readonly originCaseType: string;
	readonly invalid: boolean;
	readonly admitChange?: (next: RelationPath) => ExpressionChangeAdmission;
}) {
	const build = (identifier: string, caseType?: string): RelationPath =>
		value.kind === "subcase"
			? subcasePath(identifier, caseType)
			: anyRelationPath(identifier, caseType);
	const availableCaseTypes = availableCaseTypesForSingleRelation(
		value.kind,
		value.identifier,
		originCaseType,
		caseTypes,
	).map((caseType) => caseType.name);
	const originLabel = caseTypeLabel(originCaseType);
	const canChooseAutomatically =
		value.identifier === DEFAULT_IDENTIFIER && availableCaseTypes.length === 1;
	const savedCaseTypeIsUnavailable =
		value.ofCaseType !== undefined &&
		!availableCaseTypes.includes(value.ofCaseType);
	const showCaseTypeChoice =
		!canChooseAutomatically || savedCaseTypeIsUnavailable;
	const resolvedCaseType =
		value.ofCaseType !== undefined &&
		availableCaseTypes.includes(value.ofCaseType)
			? value.ofCaseType
			: availableCaseTypes.length === 1
				? availableCaseTypes[0]
				: undefined;
	const relationWithIdentifier = (
		identifier: string,
	): RelationPath | undefined => {
		const nextAvailable = availableCaseTypesForSingleRelation(
			value.kind,
			identifier,
			originCaseType,
			caseTypes,
		).map((caseType) => caseType.name);
		const destination =
			value.ofCaseType !== undefined && nextAvailable.includes(value.ofCaseType)
				? value.ofCaseType
				: resolvedCaseType !== undefined &&
						nextAvailable.includes(resolvedCaseType)
					? resolvedCaseType
					: nextAvailable.length === 1
						? nextAvailable[0]
						: undefined;
		return destination === undefined
			? undefined
			: build(identifier, destination);
	};

	return (
		<div className="min-w-0 space-y-3 rounded-lg border border-white/[0.06] bg-nova-deep/30 p-3">
			{!showCaseTypeChoice && resolvedCaseType !== undefined ? (
				<p className="text-sm font-medium text-nova-text">
					Looking at {caseTypeLabel(resolvedCaseType)}
				</p>
			) : null}
			{showCaseTypeChoice ? (
				<OptionalCaseTypeSelect
					id={`${id}-case-type`}
					label={
						value.kind === "subcase" ? "Child case type" : "Related case type"
					}
					value={value.ofCaseType}
					caseTypes={availableCaseTypes}
					allowAutomatic={canChooseAutomatically}
					automaticLabel={
						resolvedCaseType === undefined
							? "Use the available case type"
							: `Use ${caseTypeLabel(resolvedCaseType)}`
					}
					emptyMessage={
						value.kind === "subcase"
							? `No child case type is connected to ${originLabel}`
							: `No related case type is connected to ${originLabel}`
					}
					onChange={(caseType) => onChange(build(value.identifier, caseType))}
					admitChange={(caseType) =>
						admitChange?.(build(value.identifier, caseType)) ?? {
							admitted: true,
						}
					}
					invalid={invalid}
				/>
			) : null}

			<RelationshipSettings
				needsRepair={!XML_ELEMENT_NAME_PATTERN.test(value.identifier)}
			>
				<RelationshipNameField
					key={value.identifier}
					id={`${id}-identifier`}
					value={value.identifier}
					onCommit={(identifier) => {
						const next = relationWithIdentifier(identifier);
						if (next !== undefined) onChange(next);
					}}
					admitCommit={(identifier) => {
						const next = relationWithIdentifier(identifier);
						return next === undefined
							? { admitted: true }
							: (admitChange?.(next) ?? { admitted: true });
					}}
				/>
			</RelationshipSettings>
		</div>
	);
}

/** Storage-level relationship identifiers are rarely part of the author's
 * decision. Keep imported/default values intact, but let the ordinary path
 * editor lead with direction and case type. A malformed saved identifier
 * opens this repair surface automatically and cannot be hidden. */
function RelationshipSettings({
	needsRepair,
	children,
}: {
	readonly needsRepair: boolean;
	readonly children: ReactNode;
}) {
	const [opened, setOpened] = useState(false);
	const open = opened || needsRepair;

	return (
		<Collapsible
			open={open}
			onOpenChange={(nextOpen) => {
				if (!needsRepair) setOpened(nextOpen);
			}}
		>
			<CollapsibleTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="xl"
						className="group w-full justify-start gap-2 px-0 text-left not-disabled:hover:bg-transparent"
					/>
				}
			>
				<Icon
					icon={tablerChevronRight}
					className="size-4 shrink-0 text-nova-text-muted transition-transform group-data-[panel-open]:rotate-90"
				/>
				<span className="text-sm font-medium text-nova-text-secondary">
					More settings
				</span>
				{needsRepair ? (
					<span className="ml-auto text-xs text-nova-rose">
						Needs attention
					</span>
				) : null}
			</CollapsibleTrigger>
			<CollapsibleContent className="pt-2">{children}</CollapsibleContent>
		</Collapsible>
	);
}

function OptionalCaseTypeSelect({
	id,
	label,
	value,
	caseTypes,
	allowAutomatic,
	automaticLabel,
	emptyMessage,
	onChange,
	admitChange,
	invalid,
}: {
	readonly id: string;
	readonly label: string;
	readonly value: string | undefined;
	readonly caseTypes: readonly string[];
	readonly allowAutomatic: boolean;
	readonly automaticLabel: string;
	readonly emptyMessage: string;
	readonly onChange: (next: string | undefined) => void;
	readonly admitChange?: (
		next: string | undefined,
	) => ExpressionChangeAdmission;
	readonly invalid: boolean;
}) {
	const savedValueIsUnavailable =
		value !== undefined && !caseTypes.includes(value);
	const needsChoice = value === undefined && !allowAutomatic;
	const localInvalid = savedValueIsUnavailable || needsChoice;
	const triggerText =
		value === undefined
			? allowAutomatic
				? automaticLabel
				: "Choose a case type"
			: savedValueIsUnavailable
				? `${caseTypeLabel(value)} is unavailable`
				: caseTypeLabel(value);
	const guidance =
		caseTypes.length === 0
			? emptyMessage
			: savedValueIsUnavailable
				? "This saved case type isn't connected here. Choose an available case type"
				: needsChoice
					? "Choose the case type this connection should use"
					: undefined;
	const admissionFor = (next: string | undefined): ExpressionChangeAdmission =>
		next === value
			? { admitted: true }
			: (admitChange?.(next) ?? { admitted: true });
	const automaticAdmission = admissionFor(undefined);

	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Select
				value={value ?? NO_CASE_TYPE}
				onValueChange={(next) => {
					const candidate =
						next === null || next === NO_CASE_TYPE ? undefined : next;
					if (admissionFor(candidate).admitted) onChange(candidate);
				}}
			>
				<SelectTrigger
					id={id}
					aria-label={label}
					aria-invalid={invalid || localInvalid}
					disabled={caseTypes.length === 0}
					className="h-11 w-full"
				>
					<SelectValue>{triggerText}</SelectValue>
				</SelectTrigger>
				<SelectContent align="start">
					{allowAutomatic ? (
						<SelectItem
							value={NO_CASE_TYPE}
							disabled={!automaticAdmission.admitted}
							wrap
						>
							<span className="min-w-0">
								<span className="block">{automaticLabel}</span>
								{!automaticAdmission.admitted ? (
									<span className="block text-xs font-normal text-nova-text-muted">
										{automaticAdmission.reason}
									</span>
								) : null}
							</span>
						</SelectItem>
					) : value === undefined ? (
						<SelectItem value={NO_CASE_TYPE} disabled>
							Choose a case type
						</SelectItem>
					) : null}
					{savedValueIsUnavailable ? (
						<SelectItem value={value} disabled wrap>
							{caseTypeLabel(value)} · Unavailable
						</SelectItem>
					) : null}
					{caseTypes.map((caseType) => {
						const admission = admissionFor(caseType);
						return (
							<SelectItem
								key={caseType}
								value={caseType}
								disabled={!admission.admitted}
								wrap
							>
								<span className="min-w-0">
									<span className="block">{caseTypeLabel(caseType)}</span>
									{!admission.admitted ? (
										<span className="block text-xs font-normal text-nova-text-muted">
											{admission.reason}
										</span>
									) : null}
								</span>
							</SelectItem>
						);
					})}
				</SelectContent>
			</Select>
			{guidance !== undefined ? (
				<p className="text-sm text-nova-rose">{guidance}</p>
			) : null}
		</Field>
	);
}

function RelationshipNameField({
	id,
	value,
	onCommit,
	admitCommit,
}: {
	readonly id: string;
	readonly value: string;
	readonly onCommit: (next: string) => void;
	readonly admitCommit?: (next: string) => ExpressionChangeAdmission;
}) {
	const [draft, setDraft] = useState(value);
	const skipNextBlurCommit = useRef(false);
	const normalizedDraft = draft.trim();
	const isValid = XML_ELEMENT_NAME_PATTERN.test(normalizedDraft);
	const admission =
		!isValid || normalizedDraft === value
			? ({ admitted: true } as const)
			: (admitCommit?.(normalizedDraft) ?? { admitted: true as const });
	const guidanceId = `${id}-guidance`;
	const errorId = `${id}-error`;
	const commit = () => {
		if (!isValid || !admission.admitted) return false;
		if (normalizedDraft === value) {
			setDraft(value);
			return false;
		}
		setDraft(normalizedDraft);
		onCommit(normalizedDraft);
		return true;
	};

	return (
		<Field>
			<FieldLabel htmlFor={id}>Connection name</FieldLabel>
			<Input
				id={id}
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => {
					if (skipNextBlurCommit.current) {
						skipNextBlurCommit.current = false;
						return;
					}
					commit();
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						skipNextBlurCommit.current = true;
						commit();
						event.currentTarget.blur();
					} else if (event.key === "Escape") {
						event.preventDefault();
						skipNextBlurCommit.current = true;
						setDraft(value);
						event.currentTarget.blur();
					}
				}}
				autoComplete="off"
				data-1p-ignore
				data-removal-primary-focus
				aria-invalid={!isValid || !admission.admitted}
				aria-describedby={
					isValid && admission.admitted
						? guidanceId
						: `${guidanceId} ${errorId}`
				}
				className="h-11"
			/>
			<FieldDescription id={guidanceId}>
				Use the saved name that distinguishes this connection, such as parent or
				host
			</FieldDescription>
			{!isValid ? (
				<p id={errorId} role="alert" className="text-sm text-nova-rose">
					Start with a letter or underscore, then use only letters, numbers, and
					underscores
				</p>
			) : !admission.admitted ? (
				<p id={errorId} role="alert" className="text-sm text-nova-rose">
					{admission.reason}
				</p>
			) : null}
		</Field>
	);
}
