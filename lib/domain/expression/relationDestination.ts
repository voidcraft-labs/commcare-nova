import type { CaseType } from "../blueprint";
import { unhandledKindMessage } from "./errors";
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
type RelationFailure = {
	readonly path: readonly (string | number)[];
	readonly code: RelationResolutionCode;
	readonly message: string;
};

/** Resolve the domain relationship without emitting text or inventing an origin. */
export function resolveRelationDestination(
	via: RelationPath | undefined,
	originCaseType: string | undefined,
	caseTypes: readonly CaseType[],
): RelationDestination {
	if (originCaseType === undefined)
		return {
			ok: false,
			code: "relation-origin",
			message: "A relation walk needs an originating case type.",
		};
	if (via === undefined || via.kind === "self")
		return { ok: true, caseType: originCaseType };
	const errors: RelationFailure[] = [];
	const destination = walkRelationDestination(
		via,
		originCaseType,
		caseTypes,
		errors,
		[],
	);
	if (destination !== undefined) return { ok: true, caseType: destination };
	const error = errors[0];
	if (error === undefined)
		throw new Error(
			"The relation walk returned neither a destination nor a refusal.",
		);
	return { ok: false, code: error.code, message: error.message };
}

function walkRelationDestination(
	relationPath: RelationPath,
	originCaseType: string,
	caseTypes: readonly CaseType[],
	errors: RelationFailure[],
	path: readonly (string | number)[],
): string | undefined {
	switch (relationPath.kind) {
		case "self":
			// Upstream callers short-circuit `self` before recursing:
			// `checkRelationalQuantifier` rejects `via.kind === "self"`
			// at the operator boundary; `resolveTermType`'s `prop` arm and
			// `checkExpression`'s count arm route self through the
			// originating-scope branch. The arm is retained here for `RelationPath`
			// discriminated-union exhaustiveness; the uniform top-level
			// rejection of `exists(via: self)` is defensible because
			// the shape (`exists(self, w)` reduces to `w(currentScope)`)
			// is degenerate at every position, not only the top one —
			// collapsing degenerate shapes is the reductions module's
			// concern, not the type-checker's.
			throw new Error(
				[
					"`checkRelationPath`: `self` reached the relation-path checker, but every caller short-circuits `self` upstream.",
					"",
					"`self` walks have no destination distinct from the originating scope, so",
					"the relation-path-bearing arms (`exists(self)` / `missing(self)` /",
					"`count(self)` / `prop(via: self)`) are rejected or handled directly at",
					"the operator-level checker before recursing into `checkRelationPath`. Reaching",
					"this throw means a new caller bypassed that short-circuit, either fix",
					"the caller, or document why `self` should now be a recursive case here.",
				].join("\n"),
			);

		case "ancestor": {
			// Walk the parent_type chain hop-by-hop. Each hop's origin
			// is the previous hop's destination; the first hop's origin
			// is the function's `originCaseType` argument. The i==0
			// lookup can fail when the caller passed an originating case
			// type the schema doesn't declare (e.g., a `prop` term with
			// a typo'd `caseType`); subsequent hops fail when the
			// previously-resolved destination type is missing from the
			// schema, which the blueprint validator should prevent but
			// the type checker still guards.
			let current = originCaseType;
			for (let i = 0; i < relationPath.via.length; i++) {
				const step = relationPath.via[i];
				if (step.identifier !== "parent") {
					if (step.throughCaseType === undefined) {
						errors.push({
							path,
							code: "relation-destination",
							message: `Custom relation '${step.identifier}' requires throughCaseType because Nova has no case-type metadata for that index.`,
						});
						return undefined;
					}
					if (!caseTypes.some((c) => c.name === step.throughCaseType)) {
						errors.push({
							path,
							code: "relation-destination",
							message: `Unknown case type '${step.throughCaseType}' on custom relation '${step.identifier}'.`,
						});
						return undefined;
					}
					current = step.throughCaseType;
					continue;
				}
				const ct = caseTypes.find((c) => c.name === current);
				if (!ct) {
					errors.push({
						path,
						code: "relation-path",
						message:
							i === 0
								? `Unknown originating case type '${current}' on relation walk.`
								: `Unknown case type '${current}' at ancestor hop ${i}.`,
					});
					return undefined;
				}
				if (!ct.parent_type) {
					errors.push({
						path,
						code: "relation-path",
						message: `Ancestor walk failed: case type '${current}' has no parent_type.`,
					});
					return undefined;
				}
				if (
					step.throughCaseType !== undefined &&
					step.throughCaseType !== ct.parent_type
				) {
					errors.push({
						path,
						code: "relation-path",
						message: `throughCaseType '${step.throughCaseType}' on ancestor step does not match the actual parent_type '${ct.parent_type}' of '${current}'.`,
					});
					return undefined;
				}
				current = ct.parent_type;
			}
			// Confirm the final destination exists in the case-type
			// table. Catches the dangling-parent case where a case type
			// names a `parent_type` that doesn't exist as a sibling
			// `CaseType` record.
			if (!caseTypes.some((c) => c.name === current)) {
				errors.push({
					path,
					code: "relation-destination",
					message: `Ancestor walk's destination case type '${current}' is not declared.`,
				});
				return undefined;
			}
			return current;
		}

		case "subcase": {
			if (relationPath.identifier !== "parent") {
				if (relationPath.ofCaseType === undefined) {
					errors.push({
						path,
						code: "relation-destination",
						message: `Custom relation '${relationPath.identifier}' requires ofCaseType because Nova has no case-type metadata for that index.`,
					});
					return undefined;
				}
				if (!caseTypes.some((c) => c.name === relationPath.ofCaseType)) {
					errors.push({
						path,
						code: "relation-destination",
						message: `Unknown case type '${relationPath.ofCaseType}' on custom relation '${relationPath.identifier}'.`,
					});
					return undefined;
				}
				return relationPath.ofCaseType;
			}
			// Find case types whose `parent_type` matches the origin.
			const candidates = caseTypes.filter(
				(c) => c.parent_type === originCaseType,
			);
			if (relationPath.ofCaseType !== undefined) {
				// `ofCaseType` validates against `caseTypes` directly:
				// it must name a declared case type (otherwise the
				// destination scope is unknowable) and that case type
				// must in fact be a subcase of the origin. The two
				// arms produce distinct stable codes so presentation
				// layers can route the user-facing fix correctly.
				const named = caseTypes.find((c) => c.name === relationPath.ofCaseType);
				if (!named) {
					errors.push({
						path,
						code: "relation-destination",
						message: `Unknown case type '${relationPath.ofCaseType}' on '${relationPath.kind}' walk.`,
					});
					return undefined;
				}
				if (named.parent_type !== originCaseType) {
					errors.push({
						path,
						code: "relation-destination",
						message: `Case type '${relationPath.ofCaseType}' is not a subcase of '${originCaseType}' (its parent_type is '${named.parent_type ?? "<none>"}').`,
					});
					return undefined;
				}
				return relationPath.ofCaseType;
			}
			// No qualifier — accept the unique candidate, reject the
			// ambiguous case. The zero-candidate case is its own
			// failure mode (no case type names the origin as a
			// parent), distinct from the ambiguous case.
			if (candidates.length === 0) {
				errors.push({
					path,
					code: "relation-destination",
					message: `'${relationPath.kind}' walk failed: no case type declares '${originCaseType}' as its parent_type.`,
				});
				return undefined;
			}
			if (candidates.length > 1) {
				errors.push({
					path,
					code: "relation-ambiguous",
					message: `'${relationPath.kind}' walk is ambiguous: multiple case types (${candidates.map((c) => `'${c.name}'`).join(", ")}) declare '${originCaseType}' as their parent_type. Add 'ofCaseType' to disambiguate.`,
				});
				return undefined;
			}
			return candidates[0].name;
		}

		case "any-relation": {
			if (relationPath.identifier !== "parent") {
				if (relationPath.ofCaseType === undefined) {
					errors.push({
						path,
						code: "relation-destination",
						message: `Custom relation '${relationPath.identifier}' requires ofCaseType because Nova has no case-type metadata for that index.`,
					});
					return undefined;
				}
				if (!caseTypes.some((c) => c.name === relationPath.ofCaseType)) {
					errors.push({
						path,
						code: "relation-destination",
						message: `Unknown case type '${relationPath.ofCaseType}' on custom relation '${relationPath.identifier}'.`,
					});
					return undefined;
				}
				return relationPath.ofCaseType;
			}
			const origin = caseTypes.find((c) => c.name === originCaseType);
			if (origin === undefined) {
				errors.push({
					path,
					code: "relation-path",
					message: `Unknown originating case type '${originCaseType}' on relation walk.`,
				});
				return undefined;
			}
			const candidateNames = new Set<string>();
			if (origin.parent_type !== undefined) {
				candidateNames.add(origin.parent_type);
			}
			for (const candidate of caseTypes) {
				if (candidate.parent_type === originCaseType) {
					candidateNames.add(candidate.name);
				}
			}

			if (relationPath.ofCaseType !== undefined) {
				const named = caseTypes.find((c) => c.name === relationPath.ofCaseType);
				if (named === undefined) {
					errors.push({
						path,
						code: "relation-destination",
						message: `Unknown case type '${relationPath.ofCaseType}' on 'any-relation' walk.`,
					});
					return undefined;
				}
				if (!candidateNames.has(named.name)) {
					errors.push({
						path,
						code: "relation-destination",
						message: `Case type '${named.name}' is neither a parent nor a child of '${originCaseType}'.`,
					});
					return undefined;
				}
				return named.name;
			}

			const candidates = [...candidateNames];
			if (candidates.length === 0) {
				errors.push({
					path,
					code: "relation-destination",
					message: `'any-relation' walk failed: case type '${originCaseType}' has no parent or child case type.`,
				});
				return undefined;
			}
			if (candidates.length > 1) {
				errors.push({
					path,
					code: "relation-ambiguous",
					message: `'any-relation' walk is ambiguous: '${originCaseType}' is related to multiple case types (${candidates.map((name) => `'${name}'`).join(", ")}). Add 'ofCaseType' to disambiguate.`,
				});
				return undefined;
			}
			return candidates[0];
		}

		default: {
			// Exhaustiveness assertion — adding a `RelationPath` kind
			// without a parallel arm here is a compile-time error.
			const _exhaustive: never = relationPath;
			throw new Error(
				unhandledKindMessage({
					where: "checkRelationPath",
					family: "RelationPath",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: ["self", "ancestor", "subcase", "any-relation"],
				}),
			);
		}
	}
}
