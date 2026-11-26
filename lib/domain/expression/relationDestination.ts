import type { CaseType } from "../blueprint";
import { declaredCaseRelations } from "../caseRelations";
import type { RelationPath } from "./types";

export type RelationResolutionCode =
	| "relation-origin"
	| "relation-path"
	| "relation-destination"
	| "relation-ambiguous";
export type RelationDestination =
	| { readonly ok: true; readonly caseType: string }
	| {
			readonly ok: false;
			readonly code: RelationResolutionCode;
			readonly message: string;
	  };

function refused(
	code: RelationResolutionCode,
	message: string,
): RelationDestination {
	return { ok: false, code, message };
}

function selectDestination(
	types: readonly CaseType[],
	candidates: ReadonlySet<string>,
	requested: string | undefined,
	identifier: string,
	origin: string,
	direction: "ancestor" | "subcase" | "any-relation",
): RelationDestination {
	if (requested !== undefined && !types.some((type) => type.name === requested))
		return refused(
			"relation-destination",
			`Unknown case type '${requested}' on link '${identifier}'.`,
		);
	const qualifier = direction === "ancestor" ? "throughCaseType" : "ofCaseType";
	if (candidates.size === 0) {
		// Existing documents can qualify an otherwise unknown custom index.
		if (identifier !== "parent" && requested !== undefined)
			return { ok: true, caseType: requested };
		if (direction === "ancestor" && identifier === "parent")
			return refused(
				"relation-path",
				`Case type '${origin}' has no parent_type or other declared parent link.`,
			);
		return refused(
			"relation-destination",
			`No case type declares the '${identifier}' link on this ${direction} walk from '${origin}'. A custom link can name its ${qualifier}.`,
		);
	}
	if (requested !== undefined && !candidates.has(requested)) {
		if (direction === "ancestor")
			return refused(
				"relation-path",
				`The ${qualifier} '${requested}' does not match the destinations of '${origin}' through '${identifier}'.`,
			);
		if (direction === "subcase")
			return refused(
				"relation-destination",
				`Case type '${requested}' is not a subcase of '${origin}' through '${identifier}'.`,
			);
		return refused(
			"relation-destination",
			`Case type '${requested}' is not related to '${origin}' through '${identifier}'.`,
		);
	}
	if (requested !== undefined) return { ok: true, caseType: requested };
	if (candidates.size !== 1)
		return refused(
			"relation-ambiguous",
			`The '${identifier}' walk from '${origin}' reaches multiple case types (${[...candidates].sort().join(", ")}). A typed calculation can name its ${qualifier}.`,
		);
	const [caseType] = candidates;
	return types.some((type) => type.name === caseType)
		? { ok: true, caseType }
		: refused(
				"relation-destination",
				`The link's destination case type '${caseType}' is not declared.`,
			);
}

/** The single scope a typed calculation requires. Native property columns
 * use the whole destination set and follow the saved case ID without a filter. */
export function resolveRelationDestination(
	via: RelationPath | undefined,
	originCaseType: string | undefined,
	caseTypes: readonly CaseType[],
): RelationDestination {
	if (originCaseType === undefined)
		return refused(
			"relation-origin",
			"A relation walk needs an originating case type.",
		);
	if (via === undefined || via.kind === "self")
		return { ok: true, caseType: originCaseType };
	let current = originCaseType;
	let origin = caseTypes.find((type) => type.name === current);
	if (origin === undefined)
		return refused(
			"relation-path",
			`Unknown originating case type '${current}' on relation walk.`,
		);
	if (via.kind === "ancestor") {
		for (const step of via.via) {
			const candidates = new Set(
				declaredCaseRelations(origin)
					.filter((edge) => edge.identifier === step.identifier)
					.map((edge) => edge.targetType),
			);
			const result = selectDestination(
				caseTypes,
				candidates,
				step.throughCaseType,
				step.identifier,
				current,
				via.kind,
			);
			if (!result.ok) return result;
			current = result.caseType;
			const next = caseTypes.find((type) => type.name === current);
			if (next === undefined)
				return refused(
					"relation-destination",
					`Unknown case type '${current}' on relation walk.`,
				);
			origin = next;
		}
		return { ok: true, caseType: current };
	}
	const candidates = new Set(
		caseTypes
			.filter((type) =>
				declaredCaseRelations(type).some(
					(edge) =>
						edge.identifier === via.identifier &&
						edge.targetType === originCaseType,
				),
			)
			.map((type) => type.name),
	);
	if (via.kind === "any-relation")
		for (const edge of declaredCaseRelations(origin))
			if (edge.identifier === via.identifier) candidates.add(edge.targetType);
	return selectDestination(
		caseTypes,
		candidates,
		via.ofCaseType,
		via.identifier,
		current,
		via.kind,
	);
}
