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

export type RelationKind = RelationPath["kind"];

export const DEFAULT_IDENTIFIER = "parent";
export const NO_CASE_TYPE = "__nova_no_case_type__";

export const KIND_OPTIONS: readonly {
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

export function isRelationKind(value: string): value is RelationKind {
	return KIND_OPTIONS.some((option) => option.value === value);
}

export function kindLabel(kind: RelationKind): string {
	return KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

export type RelationCaseType = Pick<CaseType, "name" | "parent_type">;

export function caseTypeLabel(name: string): string {
	return humanizeId(name);
}

export function directChildCaseTypes(
	originCaseType: string,
	caseTypes: readonly RelationCaseType[],
): RelationCaseType[] {
	return caseTypes.filter(
		(caseType) => caseType.parent_type === originCaseType,
	);
}

export function anyRelatedCaseTypes(
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

export function availableCaseTypesForSingleRelation(
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

export function declaredParentCaseType(
	originCaseType: string,
	caseTypes: readonly RelationCaseType[],
): RelationCaseType | undefined {
	const origin = caseTypes.find((caseType) => caseType.name === originCaseType);
	if (origin?.parent_type === undefined) return undefined;
	return caseTypes.find((caseType) => caseType.name === origin.parent_type);
}

export function relationKindIsAvailable(
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

export function relationKindHasAutomaticPath(
	kind: Exclude<RelationKind, "self">,
	originCaseType: string,
	caseTypes: readonly RelationCaseType[],
	current?: RelationPath,
): boolean {
	if (
		(kind === "subcase" || kind === "any-relation") &&
		(current?.kind === "subcase" || current?.kind === "any-relation") &&
		current.identifier !== DEFAULT_IDENTIFIER &&
		caseTypes.some((candidate) => candidate.name === current.ofCaseType)
	)
		return true;
	switch (kind) {
		case "ancestor":
			return declaredParentCaseType(originCaseType, caseTypes) !== undefined;
		case "subcase":
			return directChildCaseTypes(originCaseType, caseTypes).length > 0;
		case "any-relation":
			return anyRelatedCaseTypes(originCaseType, caseTypes).length > 0;
	}
}

export function customRelationPath(
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

export function unavailableKindDescription(
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
export function changeKind(
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
	const children = availableCaseTypesForSingleRelation(
		"subcase",
		identifier,
		originCaseType,
		caseTypes,
	);
	const anyRelated = availableCaseTypesForSingleRelation(
		"any-relation",
		identifier,
		originCaseType,
		caseTypes,
	);
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
export function relationChangeLosesStructure(
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
		const related = availableCaseTypesForSingleRelation(
			"any-relation",
			value.identifier,
			originCaseType,
			caseTypes,
		);
		const selected =
			value.ofCaseType ?? (related.length === 1 ? related[0]?.name : undefined);
		return !availableCaseTypesForSingleRelation(
			"subcase",
			value.identifier,
			originCaseType,
			caseTypes,
		).some((candidate) => candidate.name === selected);
	}
	if (value.kind === "ancestor") {
		return value.via.length > 1 || value.via[0].throughCaseType !== undefined;
	}
	return value.ofCaseType !== undefined;
}

export interface RelationReplacementCopy {
	readonly title: string;
	readonly description: string;
}

export function relationReplacementCopy(
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

export function withAncestorStep(
	path: Extract<RelationPath, { kind: "ancestor" }>,
	index: number,
	nextStep: RelationStep,
): Extract<RelationPath, { kind: "ancestor" }> {
	const steps = path.via.map((step, stepIndex) =>
		stepIndex === index ? nextStep : step,
	) as [RelationStep, ...RelationStep[]];
	return ancestorPath(steps[0], ...steps.slice(1));
}

export function withoutAncestorStep(
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

export function ancestorRemovalConsequence(
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

export interface AncestorStepContext {
	readonly originCaseType: string;
	readonly parentCaseType: string | undefined;
	readonly qualifierIsValid: boolean;
}

export function ancestorStepContexts(
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
export function rebuildValidAncestorPath(
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
