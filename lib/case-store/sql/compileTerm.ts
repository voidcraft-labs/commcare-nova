// lib/case-store/sql/compileTerm.ts
//
// Compile a `Term` to a Kysely expression. The predicate and
// expression compilers consume the result as the leaf of every
// operator they emit — `eq(left, right)` reduces to
// `compileTerm(left) = compileTerm(right)`, `match(prop, value)`
// reduces to a `pg_trgm` operator over `compileTerm(prop)`.
//
// Arms: `prop` (typed JSONB read with cast, or scalar-column read
// for `RESERVED_SCALAR_COLUMNS`), `literal` (delegates to
// `compileLiteral`), `input` / `session-user` / `session-context`
// (parameter-bound from `ctx.bindings`; missing bindings throw
// rather than emit `NULL`).
//
// ## Non-self via reads as scalar subqueries
//
// When `prop` carries a non-self `via`, the compiler builds the
// relation-path leaf and emits a correlated scalar subquery:
// `(select cast(<leaf>.properties ->> 'name' as <type>) from
// <leaf> where <leaf>.anchor_case_id = <anchor>.case_id limit 1)`.
// `LIMIT 1` keeps the result scalar — the AST authoring surface
// for term-level non-self vias targets 1-to-1 walks (parent /
// host); a many-to-one walk returns the first matching row.
//
// ## Tenant scoping
//
// The term compiler does NOT emit a tenant filter; the outer-query
// layer (predicate compiler, case-list query) owns it.
// `compileRelationPath` enforces it on every joined `cases` row.
// `appId` / `ownerId` are on the context so the field shape stays
// uniform for forwarding into `compileRelationPath`.
//
// `AliasableExpression<unknown>` is the public return type so
// `.as(alias)` works at every consumer site (tests call
// `.as("v")` to wrap as a select column; the wider compilers
// consume via `eb(...)` / `where(...)` / `selectFrom(...)`).

import type { AliasableExpression, Kysely } from "kysely";
import { expressionBuilder } from "kysely";
import type { CasePropertyDataType, CaseType } from "@/lib/domain";
import {
	compilerBugMessage,
	typeCheckerBypassMessage,
	unhandledKindMessage,
} from "@/lib/domain/predicate/errors";
import type { RelationPath, Term } from "@/lib/domain/predicate/types";
import { compileLiteral } from "./compileLiteral";
import { compileRelationPath } from "./compileRelationPath";
import type { Database } from "./database";
import {
	JSONB_READ_OPERATOR_FOR_DATA_TYPE,
	POSTGRES_CAST_FOR_DATA_TYPE,
	RESERVED_SCALAR_COLUMNS,
} from "./dataTypeTokens";

// ---------------------------------------------------------------
// Public types
// ---------------------------------------------------------------

/**
 * The pg-driver-bindable scalar shapes runtime bindings admit.
 * `Date` is included because session surfaces sometimes materialize
 * `appversion` / `deviceid`-style values as native `Date` objects.
 * Objects / arrays are NOT admitted — the wire target is a single
 * scalar; structured payloads indicate a layer-violation upstream.
 */
export type TermBindingValue = string | number | boolean | Date | null;

/**
 * Runtime bindings for the three non-property `Term` arms. Split
 * by AST arm (not collapsed into one keyed map) because a
 * `sessionUser` ref must not silently resolve from the search-input
 * map — the wire targets resolve those fields from different
 * instances on `commcaresession`.
 *
 * Missing bindings throw at compile time rather than emit `NULL`
 * — runtime bindings are required-by-position; the wider compiler
 * must thread runtime values before calling the term compiler.
 */
export interface TermBindings {
	/** Search-input values keyed by input name. */
	searchInputs?: ReadonlyMap<string, TermBindingValue>;

	/**
	 * Open-namespace user-data fields. Read from the session's
	 * Better Auth user `additionalFields` (or the compatible CCHQ
	 * custom-user-data map for HQ-imported sessions).
	 */
	sessionUser?: ReadonlyMap<string, TermBindingValue>;

	/**
	 * Closed-namespace context fields (`userid` / `username` /
	 * `deviceid` / `appversion` per `SESSION_CONTEXT_FIELDS`).
	 */
	sessionContext?: ReadonlyMap<string, TermBindingValue>;
}

/**
 * Compile context shared across the term / predicate / expression
 * / relation-path stack. The term compiler reads its own subset
 * and forwards the rest unchanged into downstream calls.
 */
export interface TermCompileContext {
	db: Kysely<Database>;
	/** First half of the `(app_id, owner_id)` tenant pair — forwarded to `compileRelationPath`. */
	appId: string;
	/** Second half. `null` admits HQ-imported cases pre-assignment. */
	ownerId: string | null;
	/** The outer query's alias for `cases`. Property reads emit `<anchorAlias>.<col>`. */
	anchorAlias: string;
	/**
	 * Relation-walk nesting depth. Forwarded to `compileRelationPath`
	 * so leaf subqueries pick unique aliases (`rp_leaf_<depth>`)
	 * that don't shadow outer-scope leaves — see
	 * `lib/case-store/sql/CLAUDE.md` § "depth-thread".
	 */
	relationPathDepth?: number;
	/**
	 * Schema lookup for `data_type` → cast mapping. A missing case
	 * type or undeclared property is a type-checker bypass — the
	 * term compiler throws rather than emit ambiguous SQL.
	 */
	caseTypeSchemas: ReadonlyMap<string, CaseType>;
	bindings: TermBindings;
}

/**
 * Module-scoped expression builder. With `TB = keyof Database` the
 * builder accepts column references through any of the case-store
 * tables. Runtime alias prefixes (`<anchorAlias>.case_id`,
 * `<leafAlias>.properties`) flow through the type-erased helpers
 * below — TS can't enumerate the alias accumulation but the
 * runtime values are always table aliases for the same tables.
 */
const eb = expressionBuilder<Database, keyof Database>();

/** Compile a `Term` to a Kysely expression. */
export function compileTerm(
	term: Term,
	ctx: TermCompileContext,
): AliasableExpression<unknown> {
	switch (term.kind) {
		case "prop":
			return compilePropertyRef(term, ctx);
		case "literal":
			return compileLiteral(term);
		case "input":
			return compileBoundRef(
				term.name,
				ctx.bindings.searchInputs,
				`search input '${term.name}'`,
			);
		case "session-user":
			return compileBoundRef(
				term.field,
				ctx.bindings.sessionUser,
				`session user field '${term.field}'`,
			);
		case "session-context":
			return compileBoundRef(
				term.field,
				ctx.bindings.sessionContext,
				`session context field '${term.field}'`,
			);
		default: {
			const _exhaustive: never = term;
			throw new Error(
				unhandledKindMessage({
					where: "compileTerm",
					family: "Term",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"prop",
						"literal",
						"input",
						"session-user",
						"session-context",
					],
				}),
			);
		}
	}
}

/**
 * Compile a `prop` term. Three branches: (1) reserved scalar
 * columns read directly off the alias; (2) self / no `via` reads
 * JSONB off `<anchorAlias>.properties`; (3) non-self `via` builds
 * a relation-path leaf and emits a correlated scalar subquery.
 *
 * For non-self via, the property's `data_type` resolves on the
 * destination case type (NOT `term.caseType`, which is the
 * originating scope per the AST contract on
 * `propertyRefSchema.caseType`).
 */
function compilePropertyRef(
	term: Extract<Term, { kind: "prop" }>,
	ctx: TermCompileContext,
): AliasableExpression<unknown> {
	const { caseType, property, via } = term;
	const isSelfVia = via === undefined || via.kind === "self";

	if (isSelfVia) {
		return compileSelfViaPropertyRef({
			anchorAlias: ctx.anchorAlias,
			caseType,
			property,
			schemas: ctx.caseTypeSchemas,
		});
	}

	// Non-self via: the destination case type is where the
	// property's `data_type` (and so the cast / read operator)
	// lives.
	return compileNonSelfViaPropertyRef({
		via,
		anchorAlias: ctx.anchorAlias,
		caseType,
		property,
		ctx,
	});
}

/**
 * Self-via read: JSONB or scalar-column off the anchor row.
 * Splitting from the non-self path keeps each call site's intent
 * clear and lets the non-self helper reuse the column-emission
 * logic inside the scalar-subquery body.
 */
function compileSelfViaPropertyRef(args: {
	anchorAlias: string;
	caseType: string;
	property: string;
	schemas: ReadonlyMap<string, CaseType>;
}): AliasableExpression<unknown> {
	const { anchorAlias, caseType, property, schemas } = args;
	if (RESERVED_SCALAR_COLUMNS.has(property)) {
		return scalarColumnRef(anchorAlias, property);
	}
	const dataType = lookupDataType(caseType, property, schemas);
	return jsonbColumnRead({ sourceAlias: anchorAlias, property, dataType });
}

/**
 * Non-self via read as a correlated scalar subquery over the
 * relation-path leaf. The depth on the surrounding context
 * forwards unchanged so a nested term-level walk doesn't shadow an
 * outer leaf with the same alias name.
 */
function compileNonSelfViaPropertyRef(args: {
	via: RelationPath;
	anchorAlias: string;
	caseType: string;
	property: string;
	ctx: TermCompileContext;
}): AliasableExpression<unknown> {
	const { via, anchorAlias, caseType, property, ctx } = args;

	const lookupCaseType = resolveDestinationCaseType(
		via,
		caseType,
		ctx.caseTypeSchemas,
	);

	const compiledPath = compileRelationPath(via, {
		db: ctx.db,
		appId: ctx.appId,
		ownerId: ctx.ownerId,
		anchorAlias,
		relationPathDepth: ctx.relationPathDepth ?? 0,
	});
	if (compiledPath.kind !== "joined") {
		throw new Error(
			compilerBugMessage({
				where: "compileTerm.compileNonSelfViaPropertyRef",
				invariant:
					"a non-`self` `RelationPath` produced a `self` compiled result",
				detail:
					"The upstream `isSelfVia` branch in `compilePropertyRef` is supposed to route every `self` walk away from this helper before it reaches `compileRelationPath`. Reaching this throw means `compileRelationPath` returned the degenerate `self` marker for a `RelationPath` whose `kind` is not `self` — a contract violation between the two helpers.",
			}),
		);
	}

	const leafAlias = compiledPath.leafAlias;
	const innerRead = RESERVED_SCALAR_COLUMNS.has(property)
		? scalarColumnRef(leafAlias, property)
		: jsonbColumnRead({
				sourceAlias: leafAlias,
				property,
				dataType: lookupDataType(lookupCaseType, property, ctx.caseTypeSchemas),
			});

	// `LIMIT 1` keeps the subquery scalar — the term compiler's
	// contract is "value-bearing expression". Without it, a
	// multi-row leaf would surface as "more than one row returned
	// by a subquery used as an expression" at runtime.
	//
	// Type-erased via `DynamicCorrelatedQuery` because TS can't
	// enumerate the runtime leaf alias through the typed builder.
	// The alias is `RELATION_PATH_LEAF_ALIAS` at depth 0 and
	// `_<N>`-suffixed at nestings; each `<alias>.<column>` resolves
	// at runtime against the leaf row's actual columns.
	const leafSubquery = compiledPath.buildLeafSubquery();
	const innerQuery = ctx.db.selectFrom(
		leafSubquery as unknown as never,
	) as unknown as DynamicCorrelatedQuery;
	const correlated = innerQuery
		.whereRef(`${leafAlias}.anchor_case_id`, "=", `${anchorAlias}.case_id`)
		.select(innerRead.as("v"))
		.limit(1);
	return correlated as unknown as AliasableExpression<unknown>;
}

/**
 * JSONB property read with per-`data_type` cast + read operator.
 * Shape: `eb.cast<T>(eb(<properties-ref>, <readOp>, <key>),
 * <cast>)`. Read operator (`->>` / `->`) and cast both come from
 * closed-enum lookups so the typed builder's accepted-literal
 * surfaces are satisfied.
 */
function jsonbColumnRead(args: {
	sourceAlias: string;
	property: string;
	dataType: CasePropertyDataType;
}): AliasableExpression<unknown> {
	const { sourceAlias, property, dataType } = args;
	const cast = POSTGRES_CAST_FOR_DATA_TYPE[dataType];
	const readOperator = JSONB_READ_OPERATOR_FOR_DATA_TYPE[dataType];
	const propertiesRef = `${sourceAlias}.properties` as const;
	// Type-erased: the runtime alias prefix can't be enumerated
	// against `Database` statically, but every concrete site names
	// a `cases`-shaped row at the alias position.
	const jsonRead = (eb as DynamicExprBuilder)(
		propertiesRef,
		readOperator,
		property,
	);
	return eb.cast(jsonRead, cast);
}

/**
 * Reserved scalar column reference. Type-erased for the same
 * reason as `jsonbColumnRead`'s prefix — runtime alias.
 */
function scalarColumnRef(
	alias: string,
	column: string,
): AliasableExpression<unknown> {
	return (eb as DynamicExprBuilder).ref(`${alias}.${column}`);
}

/**
 * Resolve the destination case-type name a `RelationPath` reaches.
 * Mirrors `checkRelationPath` in
 * `lib/domain/predicate/typeChecker.ts:1080-1232`.
 *
 * Ancestor walks chain `parent_type` hops; subcase / any-relation
 * find the case type whose `parent_type` matches the origin
 * (`ofCaseType` qualifier disambiguates when multiple). `self` is
 * handled upstream — reaching that arm here is a contract
 * violation between callers and this helper.
 */
function resolveDestinationCaseType(
	via: RelationPath,
	originCaseType: string,
	schemas: ReadonlyMap<string, CaseType>,
): string {
	switch (via.kind) {
		case "self":
			throw new Error(
				compilerBugMessage({
					where: "compileTerm.resolveDestinationCaseType",
					invariant: "a `self` `RelationPath` reached the destination resolver",
					detail:
						"`self` walks have no destination distinct from the originating scope, so callers branch on `kind === 'self'` upstream and use `originCaseType` directly. Reaching this throw means the upstream branch was skipped — the resolver was called with a `self` input it cannot resolve.",
				}),
			);

		case "ancestor": {
			let current = originCaseType;
			for (let i = 0; i < via.via.length; i++) {
				const step = via.via[i];
				const ct = schemas.get(current);
				if (ct === undefined) {
					throw new Error(
						typeCheckerBypassMessage({
							where: "compileTerm.resolveDestinationCaseType",
							summary: `ancestor walk references unknown case type \`${current}\` at hop ${i}`,
							expected:
								"a case type registered in the schema set passed to the compiler",
							received: `\`${current}\``,
							hint: "verify the case type exists in `case_type_schemas` for this app, or correct the AST so the walk reads through declared case types only.",
						}),
					);
				}
				if (!ct.parent_type) {
					throw new Error(
						typeCheckerBypassMessage({
							where: "compileTerm.resolveDestinationCaseType",
							summary: `ancestor walk reached case type \`${current}\` at hop ${i}, but \`${current}\` declares no \`parent_type\``,
							expected: `\`${current}.parent_type\` set to the case type one hop up the ancestor chain`,
							received: `\`${current}.parent_type\` is unset (the chain dead-ends here)`,
							hint: `add a \`parent_type\` to case type \`${current}\` to make the walk well-formed, or shorten the ancestor chain so it terminates at \`${current}\`.`,
						}),
					);
				}
				if (
					step.throughCaseType !== undefined &&
					step.throughCaseType !== ct.parent_type
				) {
					throw new Error(
						typeCheckerBypassMessage({
							where: "compileTerm.resolveDestinationCaseType",
							summary: `\`throughCaseType\` qualifier on ancestor step ${i} disagrees with \`${current}.parent_type\``,
							expected: `\`throughCaseType: '${ct.parent_type}'\` (the declared \`parent_type\` of \`${current}\`)`,
							received: `\`throughCaseType: '${step.throughCaseType}'\``,
							hint: "remove the qualifier (the chain is unambiguous without it) or correct it to match the declared `parent_type`.",
						}),
					);
				}
				current = ct.parent_type;
			}
			return current;
		}

		case "subcase":
		case "any-relation": {
			if (via.ofCaseType !== undefined) {
				return via.ofCaseType;
			}
			// No qualifier: ambiguous and zero-candidate cases are
			// type-checker bypasses — the SQL compiler can't
			// disambiguate.
			const candidates: string[] = [];
			for (const ct of schemas.values()) {
				if (ct.parent_type === originCaseType) {
					candidates.push(ct.name);
				}
			}
			if (candidates.length === 1) {
				return candidates[0];
			}
			throw new Error(
				typeCheckerBypassMessage({
					where: "compileTerm.resolveDestinationCaseType",
					summary:
						candidates.length === 0
							? `\`${via.kind}\` walk from origin \`${originCaseType}\` has no destination — no case type declares \`parent_type: '${originCaseType}'\``
							: `\`${via.kind}\` walk from origin \`${originCaseType}\` is ambiguous — \`ofCaseType\` is required to disambiguate the destination`,
					expected:
						candidates.length === 0
							? `at least one case type whose \`parent_type\` is \`${originCaseType}\`, or an explicit \`ofCaseType\` qualifier on the walk`
							: `an explicit \`ofCaseType\` qualifier naming one of the candidate case types`,
					received:
						candidates.length === 0
							? `no case type declares \`parent_type: '${originCaseType}'\``
							: `${candidates.length} candidate case types: ${candidates.map((c) => `\`${c}\``).join(", ")}`,
					hint:
						candidates.length === 0
							? `add a child case type whose \`parent_type\` is \`${originCaseType}\`, or replace the walk with a different \`RelationPath\` shape.`
							: "set `ofCaseType` on the walk to select the intended destination case type.",
				}),
			);
		}

		default: {
			const _exhaustive: never = via;
			throw new Error(
				unhandledKindMessage({
					where: "compileTerm.resolveDestinationCaseType",
					family: "RelationPath",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: ["self", "ancestor", "subcase", "any-relation"],
				}),
			);
		}
	}
}

/**
 * Resolve the declared `data_type`. Absent `data_type` defaults to
 * `text` (matching `jsonSchema.ts:144-148`) so the cast mapping
 * stays consistent across both consumers. Missing case types or
 * undeclared properties are type-checker bypasses.
 */
function lookupDataType(
	caseType: string,
	property: string,
	schemas: ReadonlyMap<string, CaseType>,
): CasePropertyDataType {
	const ct = schemas.get(caseType);
	if (ct === undefined) {
		throw new Error(
			typeCheckerBypassMessage({
				where: "compileTerm.lookupDataType",
				summary: `no schema registered for case type \`${caseType}\``,
				expected: "a `CaseType` entry in the schema map for this case type",
				received: `\`${caseType}\` is not present in the schema map`,
				hint: `register \`${caseType}\` in \`case_type_schemas\` for this app, or correct the AST to read from a declared case type.`,
			}),
		);
	}
	const propDef = ct.properties.find((p) => p.name === property);
	if (propDef === undefined) {
		throw new Error(
			typeCheckerBypassMessage({
				where: "compileTerm.lookupDataType",
				summary: `property \`${property}\` is not declared on case type \`${caseType}\``,
				expected: `\`${property}\` listed in \`case_type_schemas[appId, '${caseType}'].properties\``,
				received: `case type \`${caseType}\` declares: ${
					ct.properties.length === 0
						? "no properties"
						: ct.properties.map((p) => `\`${p.name}\``).join(", ")
				}`,
				hint: `add \`${property}\` to the case type's property list, or correct the AST to read a declared property.`,
			}),
		);
	}
	return propDef.data_type ?? "text";
}

/**
 * Resolve a runtime-binding term. Shared across `input` /
 * `session-user` / `session-context` because all three share the
 * "key, map, missing-key throw" structural shape — `descriptor`
 * passes the per-arm field name into the failure message.
 *
 * Missing bindings throw rather than fall back to `NULL` —
 * silently emitting `NULL` would flip the predicate's truth value.
 */
function compileBoundRef(
	key: string,
	bindings: ReadonlyMap<string, TermBindingValue> | undefined,
	descriptor: string,
): AliasableExpression<unknown> {
	if (bindings === undefined || !bindings.has(key)) {
		// Caller-setup error voiced as direct "what to fix" — the
		// caller is the only audience. These arms can't be
		// type-checked into existence at the term layer; the
		// binding map is the runtime-resolution surface.
		throw new Error(
			[
				`\`compileTerm\` — missing binding for ${descriptor}.`,
				``,
				`The AST references a runtime value (\`${key}\`) the wider pipeline did not`,
				`thread through \`ctx.bindings\` before calling \`compileTerm\`. Runtime-`,
				`binding terms (\`input\` / \`session-user\` / \`session-context\`) resolve from`,
				`the bindings map at compile time; an absent key cannot fall back to \`NULL\``,
				`without silently changing the predicate's truth value.`,
				``,
				`Hint: populate \`ctx.bindings.searchInputs\` / \`ctx.bindings.sessionUser\` /`,
				`\`ctx.bindings.sessionContext\` with the runtime values for every key the AST`,
				`references before calling the term compiler.`,
			].join("\n"),
		);
	}
	return eb.val(bindings.get(key));
}

// Type-erased local views because Kysely's typed builder can't
// enumerate runtime-derived alias / column strings against
// `Database`'s static column set. Each surfaces only the methods
// the call site uses; the concrete builder drives runtime
// dispatch.

/** Binary-op + column-ref shape over a runtime `${alias}.${column}` string. */
type DynamicExprBuilder = {
	(left: string, op: string, right: unknown): AliasableExpression<unknown>;
	ref: (reference: string) => AliasableExpression<unknown>;
};

/** Correlated scalar subquery shape for `compileNonSelfViaPropertyRef`. */
interface DynamicCorrelatedQuery {
	whereRef: (left: string, op: string, right: string) => DynamicCorrelatedQuery;
	select: (selection: AliasedExpressionLike) => DynamicCorrelatedQuery;
	limit: (n: number) => DynamicCorrelatedQuery;
}

/** Marker shape for the typed builder's `select(...)` AliasedExpression. */
type AliasedExpressionLike = {
	readonly expression: unknown;
};
