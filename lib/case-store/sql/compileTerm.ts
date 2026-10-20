// lib/case-store/sql/compileTerm.ts
//
// Compile a `Term` to a Kysely expression. The predicate and
// expression compilers consume the result as the leaf of every
// operator they emit — `eq(left, right)` reduces to
// `compileTerm(left) = compileTerm(right)`, `match(prop, value)`
// reduces to a `pg_trgm` operator over `compileTerm(prop)`.
//
// Arms: `prop` (typed JSONB read with cast, or scalar-column read
// for `RESERVED_SCALAR_COLUMN_BY_PROPERTY`), `literal` (delegates to
// `compileLiteral`), `input` / `session-user` / `session-context`
// (parameter-bound from `ctx.bindings`; missing bindings throw
// rather than emit `NULL`), and the chosen case's `session-datum`
// (its id bound from `ctx.bindings.chosenCaseIds`).
//
// ## Non-self via reads as scalar subqueries
//
// When a scalar-expression `prop` carries a non-self `via`, the compiler builds the
// relation-path leaf and emits a correlated scalar subquery:
// `(select cast(<leaf>.properties ->> 'name' as <type>) from
// <leaf> where <leaf>.anchor_case_id = <anchor>.case_id limit 1)`.
// `LIMIT 1` keeps the result scalar. `compilePredicate` first normalizes every
// relational scalar leaf to an explicit one-row `exists` scope and then
// defensively rejects surviving non-self properties, so predicate compilation
// never reaches this arbitrary-row fallback. The path remains available to
// standalone expression compilation, whose scalar contract predates predicate
// relation-scope normalization.
//
// ## Tenant scoping
//
// The term compiler does NOT emit a tenant filter; the outer-query
// layer (predicate compiler, case-list query) owns it.
// `compileRelationPath` enforces it on every joined `cases` row.
// `appId` / `projectId` are on the context so the field shape stays
// uniform for forwarding into `compileRelationPath`.
//
// `AliasableExpression<unknown>` is the public return type so
// `.as(alias)` works at every consumer site (tests call
// `.as("v")` to wrap as a select column; the wider compilers
// consume via `eb(...)` / `where(...)` / `selectFrom(...)`).

import type { AliasableExpression, Kysely } from "kysely";
import { expressionBuilder, sql } from "kysely";
import {
	ancestorLevels,
	type CasePropertyDataType,
	type CaseType,
	type LookupColumnId,
	type LookupTableId,
	levelOwnsCases,
	type OrganizationLevel,
	USERCASE_CASE_TYPE,
	type Uuid,
} from "@/lib/domain";
import {
	type RecordQueryContext,
	recordQueryContext,
	type SearchInputDecl,
} from "@/lib/domain/expression/context";
import {
	compilerBugMessage,
	typeCheckerBypassMessage,
	unhandledKindMessage,
} from "@/lib/domain/expression/errors";
import { canonicalizeRelationPath } from "@/lib/domain/expression/normalizeRelationEvaluationScopes";
import {
	type CaseReading,
	readingCaseMetadataType,
} from "@/lib/domain/expression/temporalType";
import type { RelationPath, Term } from "@/lib/domain/expression/types";
import { compileLiteral } from "./compileLiteral";
import {
	compileLookupColumnTerm,
	type LookupRowScope,
	type LookupTableSchemas,
} from "./compileLookup";
import {
	compileRelationPath,
	relationPathContextFrom,
} from "./compileRelationPath";
import type { Database } from "./database";
import {
	JSONB_READ_OPERATOR_FOR_DATA_TYPE,
	NAIVE_TEMPORAL_TEXT_PATTERN,
	POSTGRES_CAST_FOR_DATA_TYPE,
	RESERVED_SCALAR_COLUMN_BY_PROPERTY,
	type ReservedScalarColumn,
	STORED_INSTANT_TEXT_PATTERN,
} from "./dataTypeTokens";
import { javaLocalTimestamp } from "./javaZone";
import { resolveViewerTimeZone } from "./viewerTimeZone";

// ---------------------------------------------------------------
// Public types
// ---------------------------------------------------------------

/**
 * The pg-driver-bindable scalar shapes ordinary runtime bindings admit.
 * `Date` is included because session surfaces sometimes materialize
 * `appversion` / `deviceid`-style values as native `Date` objects.
 * Objects / arrays are NOT admitted — the wire target is a single
 * scalar; structured payloads indicate a layer-violation upstream.
 */
export type TermBindingValue = string | number | boolean | Date | null;

/**
 * A live form answer. Multi-select is the one structured form value: Nova
 * carries it as a JSON string array while CommCare's XForm node carries the
 * equivalent space-token wire string. Keeping this widening on `formFields`
 * (rather than every session/input binding) preserves the scalar contract of
 * those namespaces.
 */
export type FormFieldBindingValue = TermBindingValue | readonly string[];

type RuntimeBindingValue = TermBindingValue | FormFieldBindingValue;

/**
 * Runtime bindings for the four non-property, non-literal `Term` arms. Split
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
	/** Search-input values keyed by immutable authored identity. */
	searchInputs?: ReadonlyMap<Uuid, TermBindingValue>;

	/**
	 * Open-namespace user-data fields. Read from the session's
	 * Better Auth user `additionalFields` (or the compatible CCHQ
	 * custom-user-data map for HQ-imported sessions).
	 */
	sessionUser?: ReadonlyMap<string, TermBindingValue>;

	/**
	 * Current wire slug for each custom worker-information property identity.
	 * Custom references resolve here only at the execution boundary so a rename
	 * never rewrites authored expressions.
	 */
	userPropertySlugs?: ReadonlyMap<string, string>;

	/**
	 * Device-compatible fallback for an absent open-namespace user-data field.
	 * Preview supplies the empty string because CommCare exposes a missing
	 * worker-data field as blank; compiler callers that omit this keep the
	 * fail-closed missing-binding error.
	 */
	sessionUserFallback?: TermBindingValue;

	/**
	 * Closed-namespace context fields (`userid` / `username` /
	 * `deviceid` / `appversion` per `SESSION_CONTEXT_FIELDS`).
	 */
	sessionContext?: ReadonlyMap<string, TermBindingValue>;

	/** Form-local values keyed by stable field UUID (submission contexts only). */
	formFields?: ReadonlyMap<string, FormFieldBindingValue>;

	/** Case ids created earlier in the same submission, keyed by operation UUID. */
	operationIds?: ReadonlyMap<string, TermBindingValue>;

	/** Resolved identity submitting this atomic form envelope. */
	actingUserId?: TermBindingValue;
	/**
	 * The worker's current position as `here()` reads it: a CommCare location
	 * handler's text, supplied by a runtime that owns location access.
	 * Preview binds Formplayer's two values (`lat lon`); a device's handler
	 * gives four (`lat lon altitude accuracy`), which the compiler reads the
	 * same way. `null` or absent is no fix yet, which both runtimes read as
	 * `''`. Always bound as one text parameter.
	 */
	viewerLocation?: string | null;

	/**
	 * The viewer's IANA timezone (`Intl.DateTimeFormat().resolvedOptions()
	 * .timeZone`), supplied by the preview client. `today` takes the local
	 * calendar date and `format-date` renders
	 * wall-clock tokens in this zone — the device formats in ITS local
	 * zone, and in Preview the author's browser stands in for the device.
	 * Absent (non-preview compile sites, older callers) falls back to UTC,
	 * which is at least deterministic where the unpinned session zone was
	 * not. Validated at the compile site, never trusted raw.
	 */
	viewerTimeZone?: string;

	/**
	 * The case chosen in each menu the list's entry passes through, keyed by
	 * that menu's module UUID: the id a `selected-case` datum reads in a browse
	 * list's case list filter (`chosen-case('<menu>')`), and the row its
	 * properties read from (`chosen-case-property('<menu>', '<property>')`).
	 * Preview carries it as plain JSON from its menu case map. Each id is bound
	 * as one text parameter. A CSQL slot never reads it: the fold has already
	 * replaced the chosen case by the values Core gives.
	 */
	chosenCaseIds?: Readonly<Record<string, string>>;
}

/**
 * Compile context shared across the term / predicate / expression
 * / relation-path stack. The term compiler reads its own subset
 * and forwards the rest unchanged into downstream calls.
 */
export interface TermCompileContext {
	/**
	 * What the anchor row stands for (`CaseReading`): it decides the class
	 * `date_opened` and `last_modified` read in, whether `closed_on` is
	 * readable, and how a number becomes a date. Every compile site names it.
	 */
	reading: CaseReading;
	db: Kysely<Database>;
	/** First half of the `(app_id, project_id)` tenant pair — forwarded to `compileRelationPath`. */
	appId: string;
	/** Second half — the bound Project (tenant). Non-null; forwarded to `compileRelationPath`. */
	projectId: string;
	/** The outer query's alias for `cases`. Property reads emit `<anchorAlias>.<col>`. */
	anchorAlias: string;
	/**
	 * Restrict every walked `cases` row to one worker's restore — forwarded to
	 * `compileRelationPath` through `relationPathContextFrom`. Absent means the
	 * whole tenant. See `RelationPathCompileContext.restrictToRestoreScope`.
	 */
	restrictToRestoreScope?: <QB>(qb: QB, casesAlias: string) => QB;
	/** Case type represented by `anchorAlias`. Relation-path qualifiers are
	 * canonicalized from this scope before SQL compilation so same-identifier
	 * edges to another case type cannot enter the row set. */
	currentCaseType?: string;
	/**
	 * Relation-walk nesting depth. Forwarded to `compileRelationPath`
	 * so leaf subqueries pick unique aliases (`rp_leaf_<depth>`) that
	 * don't shadow outer-scope leaves. Counter starts at 0 at the
	 * outermost compile site and increments on every recursion into
	 * a relation-walk leaf's inner predicate; without it, an inner
	 * subquery's `rp_leaf` alias shadows the outer leaf and the
	 * correlation predicate collapses into self-equality on the
	 * inner row.
	 */
	relationPathDepth?: number;
	/**
	 * Schema lookup for `data_type` → cast mapping. A missing case
	 * type or undeclared property is a type-checker bypass — the
	 * term compiler throws rather than emit ambiguous SQL.
	 */
	caseTypeSchemas: ReadonlyMap<string, CaseType>;
	/** Declared types survive binding values such as the form answer "10". */
	formFieldTypes?: ReadonlyMap<Uuid, CasePropertyDataType | undefined>;
	knownInputs?: readonly SearchInputDecl[];
	/** App organization hierarchy for owner-only location terms. */
	organizationLevels?: Readonly<Record<string, OrganizationLevel>>;
	/**
	 * The ids of the places the worker's `locations` fixture holds: the ones
	 * the entry opened with, or the worker's footprint read at submission
	 * (`lib/preview/engine/workerLocationFixture.ts`). A device resolves an
	 * owner moved to a place among these alone, so an owner-to-place hop
	 * compiled without them is a caller bug, and an empty list resolves no
	 * owner.
	 */
	workerPlaceIds?: readonly string[];
	/**
	 * Rows-free lookup-table definitions (table id → column id →
	 * declared data type) for the lookup-table carriers. Optional —
	 * compile sites whose slots the validator keeps carrier-free omit
	 * it, and a carrier reaching such a site throws a missing-context
	 * invariant instead of guessing a cast.
	 */
	lookupTableSchemas?: LookupTableSchemas;
	/**
	 * The enclosing `table-lookup`'s row scope. Set by
	 * `compileTableLookup` around its `where` compilation only —
	 * `table-column` terms are legal nowhere else.
	 */
	lookupRowScope?: LookupRowScope;
	bindings: TermBindings;
}

/** SQL has typed runtime bindings and row schemas, without an authored slot. */
export function recordQueryContextFor(
	ctx: TermCompileContext,
): RecordQueryContext {
	return recordQueryContext({
		caseTypes: [...ctx.caseTypeSchemas.values()],
		currentCaseType: ctx.currentCaseType,
		lookupTables: new Map(
			[...(ctx.lookupTableSchemas ?? [])].map(([tableId, columns]) => [
				tableId as LookupTableId,
				new Map(
					[...columns].map(([columnId, dataType]) => [
						columnId as LookupColumnId,
						dataType,
					]),
				),
			]),
		),
		lookupTableId: ctx.lookupRowScope?.tableId as LookupTableId | undefined,
		formFieldTypes: ctx.formFieldTypes,
		knownInputs: ctx.knownInputs,
		organizationLevels: ctx.organizationLevels,
		userPropertySlugs: new Map(
			[...(ctx.bindings.userPropertySlugs ?? [])].map(([uuid, slug]) => [
				uuid as Uuid,
				slug,
			]),
		),
		operationIds: new Set(
			[...(ctx.bindings.operationIds?.keys() ?? [])].map(
				(uuid) => uuid as Uuid,
			),
		),
	});
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
		case "case-type":
			return eb.val(term.caseType);
		case "case-row-type":
			return (eb as DynamicExprBuilder).ref(`${ctx.anchorAlias}.case_type`);
		case "choice":
			throw new Error(
				compilerBugMessage({
					where: "compileTerm",
					invariant: "a `choice` term reached a server record query unresolved",
					detail:
						"The operation program builder resolves each `choice` to the text literal the XForm prints, from the committed document, before the program reaches the store; no other Postgres slot admits a static-select read.",
				}),
			);
		case "session-datum":
			return eb.cast(eb.val(chosenCaseId(term, ctx)), "text");
		case "form-node":
		case "case-index":
		case "repeat-row":
		case "location-level":
		case "location-field":
		case "form-case":
			throw new Error(
				compilerBugMessage({
					where: "compileTerm",
					invariant: `a \`${term.kind}\` term reached a server record query`,
					detail:
						"The profiles with a Postgres target (case-list filter, calculated columns, sort keys, Search predicates, operations, excluded owners) keep this read out; it is evaluated only on a device or in Preview's form runtime.",
				}),
			);
		case "prop":
			return compilePropertyRef(term, ctx);
		case "literal":
			return compileLiteral(term);
		case "input":
			return compileBoundRef(
				term.searchInputUuid,
				ctx.bindings.searchInputs,
				`search input '${term.searchInputUuid}'`,
			);
		case "session-user":
			if (term.source === "worker-record")
				return compileWorkerProperty(term.field, ctx);
			return compileBoundRef(
				term.field,
				ctx.bindings.sessionUser,
				`session user field '${term.field}'`,
				ctx.bindings.sessionUserFallback,
			);
		case "session-user-property": {
			const slug = ctx.bindings.userPropertySlugs?.get(term.userPropertyUuid);
			if (slug === undefined) {
				throw new Error(
					compilerBugMessage({
						where: "compileTerm",
						invariant: `the worker property identity '${term.userPropertyUuid}' has no bound slug`,
						detail:
							"Every compile site that admits a worker property threads `TermBindings.userPropertySlugs` from the committed document.",
					}),
				);
			}
			if (term.source === "worker-record")
				return compileWorkerProperty(slug, ctx);
			return compileBoundRef(
				slug,
				ctx.bindings.sessionUser,
				`session user field '${slug}'`,
				ctx.bindings.sessionUserFallback,
			);
		}
		case "session-context":
			return compileBoundRef(
				term.field,
				ctx.bindings.sessionContext,
				`session context field '${term.field}'`,
				"",
			);
		case "field":
			if (
				term.role !== undefined ||
				term.spelling !== undefined ||
				term.filters !== undefined
			)
				throw new Error(
					compilerBugMessage({
						where: "compileTerm",
						invariant:
							"a form path with a role, spelling or filters reached a server query",
						detail:
							"Only a plain field read, bound to its answer through `TermBindings.formFields`, reaches an operation program.",
					}),
				);
			return compileBoundRef(
				term.uuid,
				ctx.bindings.formFields,
				`form field '${term.uuid}'`,
			);
		case "table-column":
			return compileLookupColumnTerm(term, ctx);
		case "fixed-location":
			// Preview's location fixture and app row store share this UUID.
			return eb.val(term.locationUuid);
		case "owner-location-at-level": {
			if (ctx.currentCaseType === undefined) {
				throw new Error(
					compilerBugMessage({
						where: "compileTerm",
						invariant: "an owner-to-place hop compiled without a selected case",
					}),
				);
			}
			const levels = ctx.organizationLevels;
			const destination = levels?.[term.levelUuid];
			const source =
				destination === undefined || levels === undefined
					? undefined
					: ancestorLevels(destination, levels).find(levelOwnsCases);
			if (destination === undefined || source === undefined) {
				throw new Error(
					compilerBugMessage({
						where: "compileTerm",
						invariant: `organization level '${term.levelUuid}' has no resolvable case-owning ancestor`,
					}),
				);
			}
			const places = ctx.workerPlaceIds;
			if (places === undefined) {
				throw new Error(
					compilerBugMessage({
						where: "compileTerm",
						invariant:
							"an owner-to-place hop compiled without the worker's places",
						detail:
							"A device picks the destination from the worker's own `locations` fixture, so the caller passes `workerPlaceIds`.",
					}),
				);
			}
			// Same flat-lineage lookup as the device fixture, expressed through
			// Kysely's typed recursive-query builder. Seed every live destination
			// together with its parent, then carry the destination id while walking
			// upward. The recursive CTE cannot reference the destination alias from
			// the later scalar SELECT; keeping both rows in the seed makes that SQL
			// scope explicit while the current case remains a valid outer reference.
			// At most one row matches, so `limit(1)` needs no order: organization
			// admission keeps one live destination below each owning place
			// (`commitIntegrity.ts::assertReverseHopTargetsUnambiguous`), so the
			// device's first match in fixture order is the only one.
			return ctx.db
				.withRecursive(
					"location_lineage(destination_id, id, parent_id, level_uuid)",
					(db) =>
						db
							.selectFrom("app_locations as destination")
							.innerJoin(
								"app_locations as lineage_parent",
								"lineage_parent.id",
								"destination.parent_id",
							)
							.select([
								"destination.id as destination_id",
								"lineage_parent.id",
								"lineage_parent.parent_id",
								"lineage_parent.level_uuid",
							])
							.where("destination.app_id", "=", ctx.appId)
							.where("destination.archived_at", "is", null)
							.where("destination.level_uuid", "=", destination.uuid)
							// The destination is a place of the worker's fixture; its
							// lineage is read from the whole tree, as HQ writes each
							// place's `<level>_id` attributes.
							.where(
								places.length === 0
									? sql<boolean>`false`
									: (eb) => eb("destination.id", "in", [...places]),
							)
							.where("lineage_parent.app_id", "=", ctx.appId)
							.unionAll(
								db
									.selectFrom("app_locations as lineage_parent")
									.innerJoin(
										"location_lineage",
										"lineage_parent.id",
										"location_lineage.parent_id",
									)
									.select([
										"location_lineage.destination_id",
										"lineage_parent.id",
										"lineage_parent.parent_id",
										"lineage_parent.level_uuid",
									])
									.where("lineage_parent.app_id", "=", ctx.appId),
							),
				)
				.selectFrom("location_lineage")
				.select("location_lineage.destination_id")
				.where("location_lineage.level_uuid", "=", source.uuid)
				.where((db) =>
					db(
						db.cast("location_lineage.id", "text"),
						"=",
						db.ref(`${ctx.anchorAlias}.owner_id` as never),
					),
				)
				.limit(1);
		}
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
						"session-user-property",
						"session-context",
						"field",
						"table-column",
					],
				}),
			);
		}
	}
}

/**
 * The id of the case chosen in a menu, from `TermBindings.chosenCaseIds`. The
 * checker admits only a `selected-case` datum supplied before the module's
 * case list step, so any other datum, or one the read does not carry, is an
 * invariant.
 */
function chosenCaseId(
	term: Extract<Term, { kind: "session-datum" }>,
	ctx: TermCompileContext,
): string {
	const id = chosenCaseBinding(term, ctx);
	if (id !== undefined) return id;
	throw new Error(
		compilerBugMessage({
			where: "compileTerm.chosenCaseId",
			invariant:
				term.datum.kind === "selected-case"
					? `the read carries no chosen case for menu '${term.datum.module}'`
					: `a \`${term.datum.kind}\` datum reached a server record query`,
			detail:
				"A browse list's filter reads only a case chosen in a menu before its case list step, and Preview carries that choice as `TermBindings.chosenCaseIds`; a CSQL slot's fold has already replaced the chosen case.",
		}),
	);
}

function chosenCaseBinding(
	term: Extract<Term, { kind: "session-datum" }>,
	ctx: TermCompileContext,
): string | undefined {
	const { datum } = term;
	const ids = ctx.bindings.chosenCaseIds;
	if (datum.kind !== "selected-case" || ids === undefined) return undefined;
	return Object.hasOwn(ids, datum.module) ? ids[datum.module] : undefined;
}

/**
 * One property of the case chosen in a menu: a read of that case's row, the
 * shape the worker-record read takes. The row is the Project's case of the
 * menu's case type whose `case_id` is the bound chosen id, not held, inside
 * the restore scope when the read has one, and the property reads under the
 * slot's reading as the anchor's would. An id that names no such row reads no
 * row, so the property is absent (`NULL`), which the two-valued comparisons
 * read as a device reads an absent node.
 */
export function compileChosenCaseProperty(
	read: {
		readonly datum: Extract<Term, { kind: "session-datum" }>;
		readonly caseType: string;
		readonly property: string;
	},
	ctx: TermCompileContext,
): AliasableExpression<unknown> {
	const { caseType, property } = read;
	const caseId = eb.cast<string>(eb.val(chosenCaseId(read.datum, ctx)), "text");
	const reserved = reservedColumnFor(property, ctx);
	const value =
		reserved !== undefined
			? scalarColumnRef(CHOSEN_CASE_ALIAS, reserved.column)
			: jsonbColumnRead({
					sourceAlias: CHOSEN_CASE_ALIAS,
					property,
					dataType: lookupDataType(caseType, property, ctx.caseTypeSchemas),
				});
	let query = ctx.db
		.selectFrom(`cases as ${CHOSEN_CASE_ALIAS}`)
		.where(`${CHOSEN_CASE_ALIAS}.app_id`, "=", ctx.appId)
		.where(`${CHOSEN_CASE_ALIAS}.project_id`, "=", ctx.projectId)
		.where(`${CHOSEN_CASE_ALIAS}.case_type`, "=", caseType)
		.where((builder) =>
			builder(builder.ref(`${CHOSEN_CASE_ALIAS}.case_id`), "=", caseId),
		)
		.where(({ not, exists, selectFrom }) =>
			not(
				exists(
					selectFrom("parked_case_values as chosen_case_held")
						.select("chosen_case_held.id")
						.whereRef(
							"chosen_case_held.case_id",
							"=",
							`${CHOSEN_CASE_ALIAS}.case_id`,
						)
						.where("chosen_case_held.dismissed_at", "is", null),
				),
			),
		)
		.select(compileReadingDate(value, property, ctx).as("value"))
		.limit(1);
	if (ctx.restrictToRestoreScope !== undefined)
		query = ctx.restrictToRestoreScope(query, CHOSEN_CASE_ALIAS);
	return query as unknown as AliasableExpression<unknown>;
}

/** The chosen case's row is uncorrelated with the anchor, so every read of it
 *  can share one alias. */
const CHOSEN_CASE_ALIAS = "chosen_case";

/** Worker-record reads use the same tenant and held-row boundary as case reads. */
function compileWorkerProperty(
	field: string,
	ctx: TermCompileContext,
): AliasableExpression<unknown> {
	const userId = eb.cast<string>(
		compileBoundValue(
			ctx.bindings.sessionContext?.get("userid") ?? ctx.bindings.actingUserId,
			"the current worker id",
		),
		"text",
	);
	let query = ctx.db
		.selectFrom("cases as worker_case")
		.where("worker_case.app_id", "=", ctx.appId)
		.where("worker_case.project_id", "=", ctx.projectId)
		.where("worker_case.case_type", "=", USERCASE_CASE_TYPE)
		.where((builder) =>
			builder(
				builder.ref("worker_case.properties", "->>").key("hq_user_id"),
				"=",
				userId,
			),
		)
		.where(({ not, exists, selectFrom }) =>
			not(
				exists(
					selectFrom("parked_case_values as worker_held")
						.select("worker_held.id")
						.whereRef("worker_held.case_id", "=", "worker_case.case_id")
						.where("worker_held.dismissed_at", "is", null),
				),
			),
		)
		.select((builder) => {
			const scalar = RESERVED_SCALAR_COLUMN_BY_PROPERTY.get(field);
			const value: AliasableExpression<unknown> =
				scalar === undefined
					? builder.ref("worker_case.properties", "->>").key(field)
					: eb.cast(scalarColumnRef("worker_case", scalar.column), "text");
			return value.as("value");
		})
		.limit(1);
	if (ctx.restrictToRestoreScope !== undefined)
		query = ctx.restrictToRestoreScope(query, "worker_case");
	return eb.fn("coalesce", [query, eb.val("")]);
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
	const { property, via } = term;
	const caseType = term.caseType ?? ctx.currentCaseType;
	if (caseType === undefined)
		throw new Error(
			compilerBugMessage({
				where: "compileTerm.compilePropertyRef",
				invariant: "a server property read compiled without its record type",
			}),
		);
	const isSelfVia = via === undefined || via.kind === "self";

	const value = isSelfVia
		? compileSelfViaPropertyRef({
				anchorAlias: ctx.anchorAlias,
				caseType,
				property,
				ctx,
			})
		: compileNonSelfViaPropertyRef({
				via,
				anchorAlias: ctx.anchorAlias,
				caseType,
				property,
				ctx,
			});
	return compileReadingDate(value, property, ctx);
}

/**
 * The reading's class for a system date, applied outside the scalar subquery
 * so parent reads take it too:
 *
 * - `casedb`: both `date_opened` and `last_modified` are the viewer's
 *   calendar date of the stored instant, as Core's casedb holds `DateData`
 *   (`CaseInstanceTreeElement` builds both from the case's `Date` fields),
 *   read as `java.util.TimeZone` reads the zone (`javaLocalTimestamp`).
 * - `results`: `date_opened` is the UTC calendar date of `opened_on`, the
 *   text HQ's results instance carries (`json_format_date`); `last_modified`
 *   stays its instant.
 * - `search`: both stay instants, as HQ's `_create_system_datetime_query`
 *   compares them.
 */
function compileReadingDate(
	value: AliasableExpression<unknown>,
	property: string,
	ctx: TermCompileContext,
): AliasableExpression<unknown> {
	if (!isCalendarPropertyUnder(ctx.reading, property)) return value;
	if (ctx.reading !== "casedb")
		return eb.cast(eb.fn<Date>("timezone", [eb.val("UTC"), value]), "date");
	return eb.cast(
		javaLocalTimestamp(
			resolveViewerTimeZone(ctx.bindings.viewerTimeZone),
			value,
		),
		"date",
	);
}

/** Whether a reading holds this standard property as a calendar date. */
function isCalendarPropertyUnder(
	reading: CaseReading,
	property: string,
): boolean {
	return readingCaseMetadataType(property, reading) === "date";
}

/**
 * The scalar column a standard property reads under the context's reading.
 * `closed_on` is a column only HQ's search reads (part of its indexed
 * metadata, `corehq/apps/case_search/const.py::INDEXED_METADATA_BY_KEY`);
 * neither casedb nor a results row carries it, so the checker keeps it out of
 * every other reading.
 */
export function reservedColumnFor(
	property: string,
	ctx: TermCompileContext,
): ReservedScalarColumn | undefined {
	if (property === "closed_on") {
		if (ctx.reading !== "search")
			throw new Error(
				compilerBugMessage({
					where: "compileTerm.reservedColumnFor",
					invariant: `\`closed_on\` reached the \`${ctx.reading}\` reading`,
					detail:
						"Only HQ's search reads `closed_on`; the checker's search-only standard table refuses it in every slot a device evaluates.",
				}),
			);
		return CLOSED_ON_COLUMN;
	}
	return RESERVED_SCALAR_COLUMN_BY_PROPERTY.get(property);
}

const CLOSED_ON_COLUMN: ReservedScalarColumn = {
	column: "closed_on",
	blankable: false,
};

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
	ctx: TermCompileContext;
	read?: PropertyRead;
}): AliasableExpression<unknown> {
	const { anchorAlias, caseType, property, ctx, read = "typed" } = args;
	const reserved = reservedColumnFor(property, ctx);
	if (reserved !== undefined) {
		return reservedColumnRead(anchorAlias, reserved, property, read);
	}
	const dataType = lookupDataType(caseType, property, ctx.caseTypeSchemas);
	return jsonbColumnRead({
		sourceAlias: anchorAlias,
		property,
		dataType,
		read,
	});
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
	read?: PropertyRead;
}): AliasableExpression<unknown> {
	const { via, anchorAlias, caseType, property, ctx, read = "typed" } = args;
	const canonical = canonicalizeRelationPath(via, {
		caseTypes: [...ctx.caseTypeSchemas.values()],
		currentCaseType: ctx.currentCaseType ?? caseType,
	});

	const lookupCaseType =
		canonical.destinationCaseType ??
		resolveDestinationCaseType(
			canonical.via,
			ctx.currentCaseType ?? caseType,
			ctx.caseTypeSchemas,
		);

	const compiledPath = compileRelationPath(
		canonical.via,
		relationPathContextFrom(ctx, { anchorAlias }),
	);
	if (compiledPath.kind !== "joined") {
		throw new Error(
			compilerBugMessage({
				where: "compileTerm.compileNonSelfViaPropertyRef",
				invariant:
					"a non-`self` `RelationPath` produced a `self` compiled result",
				detail:
					"The upstream `isSelfVia` branch in `compilePropertyRef` is supposed to route every `self` walk away from this helper before it reaches `compileRelationPath`. Reaching this throw means `compileRelationPath` returned the degenerate `self` marker for a `RelationPath` whose `kind` is not `self`, a contract violation between the two helpers.",
			}),
		);
	}

	const leafAlias = compiledPath.leafAlias;
	const leafReserved = reservedColumnFor(property, ctx);
	const innerRead =
		leafReserved !== undefined
			? reservedColumnRead(leafAlias, leafReserved, property, read)
			: jsonbColumnRead({
					sourceAlias: leafAlias,
					property,
					dataType: lookupDataType(
						lookupCaseType,
						property,
						ctx.caseTypeSchemas,
					),
					read,
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
 * Shape: `eb.cast<T>(eb.ref(<properties-ref>, <readOp>).key(<key>),
 * <cast>)`. Read operator (`->>` / `->`) and cast both come from
 * closed-enum lookups so the typed builder's accepted-literal
 * surfaces are satisfied.
 *
 * Kysely 0.29 moved `->` / `->>` off the `eb(lhs, op, rhs)` binary form
 * (they're JSON operators now, reached via `ref(col, op).key(...)`). The
 * key serializes inline as `properties->>'<key>'` — matching the inlined
 * key in the expression-index DDL (`computeDesiredIndexSet` uses
 * `sql.lit`), so the read and the index it targets stay byte-aligned.
 * Property names are validated identifiers, so inlining can't inject.
 */
function jsonbColumnRead(args: {
	sourceAlias: string;
	property: string;
	dataType: CasePropertyDataType;
	read?: PropertyRead;
}): AliasableExpression<unknown> {
	const { sourceAlias, property, dataType, read = "typed" } = args;
	const propertiesRef = `${sourceAlias}.properties` as const;
	if (read === "stored-text")
		return storedJsonbText(propertiesRef, property, dataType);
	const cast = POSTGRES_CAST_FOR_DATA_TYPE[dataType];
	const readOperator = JSONB_READ_OPERATOR_FOR_DATA_TYPE[dataType];
	// Type-erased: the runtime alias prefix can't be enumerated
	// against `Database` statically, but every concrete site names
	// a `cases`-shaped row at the alias position.
	const jsonRead = (eb as DynamicExprBuilder)
		.ref(propertiesRef, readOperator)
		.key(property);
	if (dataType === "datetime") return compileStoredInstant(jsonRead);
	return eb.cast(jsonRead, cast);
}

/**
 * A stored datetime property's text as an instant, or `NULL` where the text
 * names none. The text names an instant only in the shape a writer stores
 * (`yyyy-MM-ddTHH:mm:ss`, any fraction, then `Z`, `±HH`, `±HH:MM` or no
 * offset) and where Postgres reads it (`pg_input_is_valid`, so an impossible
 * calendar date is no instant rather than a failed query). A value with an
 * offset is that instant; a naive one is UTC, as HQ reads it
 * (`corehq/form_processor/utils/xform.py::adjust_datetimes` writes every
 * received date and time as `…Z`), never the session `TimeZone`.
 *
 * No `btrim`: a padded or otherwise malformed value is no instant, so the
 * two-valued comparison rule gives the device lowering's NaN answers
 * (an ordering and `=` false, `!=` true). The nested `CASE` keeps every cast
 * behind its guard.
 */
function compileStoredInstant(
	text: AliasableExpression<unknown>,
): AliasableExpression<unknown> {
	const readable = eb.and([
		eb(text, "~", eb.val(STORED_INSTANT_TEXT_PATTERN)),
		eb.fn<boolean>("pg_input_is_valid", [text, eb.val("timestamptz")]),
	]);
	const instant = eb
		.case()
		.when(eb(text, "~", eb.val(NAIVE_TEMPORAL_TEXT_PATTERN)))
		.then(eb.fn<Date>("timezone", [eb.val("UTC"), eb.cast(text, "timestamp")]))
		.else(eb.cast(text, "timestamptz"))
		.end();
	return eb
		.case()
		.when(readable)
		.then(instant)
		.else(eb.cast(eb.val(null), "timestamptz"))
		.end();
}

/**
 * How a property read compiles: `typed`, cast to its data type for the
 * comparisons and orderings that read it as one, or `stored-text`, the text
 * the case holds, exactly as stored, for the reads HQ answers with exact text
 * terms (`compileStoredText`).
 */
type PropertyRead = "typed" | "stored-text";

/**
 * A JSONB property's stored text: `->>`, uncast, so `'5'` stays `'5'` and
 * `'5.0'` is not it. A multi-select's stored JSONB array reads as its
 * choices joined by single spaces, the text a device stores for one (and a
 * scalar string under that key, from a row written before the property was a
 * multi-select, reads as itself).
 */
function storedJsonbText(
	propertiesRef: string,
	property: string,
	dataType: CasePropertyDataType,
): AliasableExpression<unknown> {
	const text = (eb as DynamicExprBuilder)
		.ref(propertiesRef, "->>")
		.key(property);
	if (dataType !== "multi_select") return text;
	const json = (eb as DynamicExprBuilder)
		.ref(propertiesRef, "->")
		.key(property);
	return eb
		.case()
		.when(eb(eb.fn("jsonb_typeof", [json]), "=", eb.val("array")))
		.then(
			sql<string>`(select string_agg(choice, ' ' order by ordinality) from jsonb_array_elements_text(${json}) with ordinality as listed(choice, ordinality))`,
		)
		.else(text)
		.end();
}

/** A reserved column as the read asks for it. Only a text column has stored
 * text; a timestamp column never reaches a `stored-text` read. */
function reservedColumnRead(
	alias: string,
	reserved: ReservedScalarColumn,
	property: string,
	read: PropertyRead,
): AliasableExpression<unknown> {
	if (read === "stored-text" && !reserved.blankable)
		throw new Error(
			compilerBugMessage({
				where: "compileTerm.reservedColumnRead",
				invariant: `the system date \`${property}\` reached a stored-text read`,
				detail:
					"Only a list of values reads a property's stored text, and CSQL representability refuses a list opposite a system date (`representability.ts::admitsValueList`).",
			}),
		);
	return scalarColumnRef(alias, reserved.column);
}

/**
 * The text a case holds for a property, or for its case type, exactly as
 * stored, `NULL` where it holds none: what HQ's search compares a list of
 * values with. HQ answers `p = unwrap-list(…)` with exact `terms` on the
 * property's text (`corehq/apps/es/case_search.py::exact_case_property_text_query`,
 * `corehq/apps/es/filters.py::term`) and a system property's with `terms` on
 * its field (`corehq/apps/case_search/xpath_functions/comparison.py::_create_system_query`),
 * so no item is read as a number, date or time first. A relation read is the
 * same correlated scalar subquery a typed read takes.
 */
export function compileStoredText(
	term: Extract<Term, { kind: "prop" | "case-row-type" }>,
	ctx: TermCompileContext,
): AliasableExpression<unknown> {
	if (term.kind === "case-row-type")
		return scalarColumnRef(ctx.anchorAlias, "case_type");
	const { property, via } = term;
	const caseType = term.caseType ?? ctx.currentCaseType;
	if (caseType === undefined)
		throw new Error(
			compilerBugMessage({
				where: "compileTerm.compileStoredText",
				invariant: "a server property read compiled without its record type",
			}),
		);
	return via === undefined || via.kind === "self"
		? compileSelfViaPropertyRef({
				anchorAlias: ctx.anchorAlias,
				caseType,
				property,
				ctx,
				read: "stored-text",
			})
		: compileNonSelfViaPropertyRef({
				via,
				anchorAlias: ctx.anchorAlias,
				caseType,
				property,
				ctx,
				read: "stored-text",
			});
}

/**
 * The data type of the property a stored-text read reads, `undefined` for
 * the case type and a reserved column, which hold text. A relation read's
 * property is its destination case type's.
 */
export function storedTextDataType(
	term: Extract<Term, { kind: "prop" | "case-row-type" }>,
	ctx: TermCompileContext,
): CasePropertyDataType | undefined {
	if (term.kind === "case-row-type") return undefined;
	const { property, via } = term;
	if (reservedColumnFor(property, ctx) !== undefined) return undefined;
	const caseType = term.caseType ?? ctx.currentCaseType;
	if (caseType === undefined) return undefined;
	if (via === undefined || via.kind === "self")
		return lookupDataType(caseType, property, ctx.caseTypeSchemas);
	const canonical = canonicalizeRelationPath(via, {
		caseTypes: [...ctx.caseTypeSchemas.values()],
		currentCaseType: ctx.currentCaseType ?? caseType,
	});
	const destination =
		canonical.destinationCaseType ??
		resolveDestinationCaseType(
			canonical.via,
			ctx.currentCaseType ?? caseType,
			ctx.caseTypeSchemas,
		);
	return lookupDataType(destination, property, ctx.caseTypeSchemas);
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
 * Mirrors `lib/domain/expression/typeChecker.ts::checkRelationPath`.
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
						"`self` walks have no destination distinct from the originating scope, so callers branch on `kind === 'self'` upstream and use `originCaseType` directly. Reaching this throw means the upstream branch was skipped, the resolver was called with a `self` input it cannot resolve.",
				}),
			);

		case "ancestor": {
			let current = originCaseType;
			for (let i = 0; i < via.via.length; i++) {
				const step = via.via[i];
				if (step.identifier !== "parent") {
					if (step.throughCaseType === undefined) {
						throw new Error(
							typeCheckerBypassMessage({
								where: "compileTerm.resolveDestinationCaseType",
								summary: `custom ancestor index \`${step.identifier}\` has no declared destination at hop ${i}`,
								expected:
									"an explicit `throughCaseType` on every custom ancestor step",
								received: "`throughCaseType` is unset",
								hint: "set `throughCaseType` to the declared case type reached through this saved index name.",
							}),
						);
					}
					if (!schemas.has(step.throughCaseType)) {
						throw new Error(
							typeCheckerBypassMessage({
								where: "compileTerm.resolveDestinationCaseType",
								summary: `custom ancestor index \`${step.identifier}\` names unknown destination \`${step.throughCaseType}\` at hop ${i}`,
								expected: "a case type registered in the compiler schema set",
								received: `\`${step.throughCaseType}\``,
								hint: "declare the destination case type or correct `throughCaseType`.",
							}),
						);
					}
					current = step.throughCaseType;
					continue;
				}
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
				if (!schemas.has(via.ofCaseType)) {
					throw new Error(
						typeCheckerBypassMessage({
							where: "compileTerm.resolveDestinationCaseType",
							summary: `\`${via.kind}\` walk names unknown destination \`${via.ofCaseType}\``,
							expected: "a case type registered in the compiler schema set",
							received: `\`${via.ofCaseType}\``,
							hint: "declare the destination case type or correct `ofCaseType`.",
						}),
					);
				}
				return via.ofCaseType;
			}
			if (via.identifier !== "parent") {
				throw new Error(
					typeCheckerBypassMessage({
						where: "compileTerm.resolveDestinationCaseType",
						summary: `custom \`${via.kind}\` index \`${via.identifier}\` has no declared destination`,
						expected: "an explicit `ofCaseType` on a custom relation",
						received: "`ofCaseType` is unset",
						hint: "set `ofCaseType` to the declared case type reached through this saved index name.",
					}),
				);
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
			if (via.kind === "any-relation") {
				const parent = schemas.get(originCaseType)?.parent_type;
				if (parent !== undefined && !candidates.includes(parent)) {
					candidates.unshift(parent);
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
							? `\`${via.kind}\` walk from origin \`${originCaseType}\` has no destination, no case type declares \`parent_type: '${originCaseType}'\``
							: `\`${via.kind}\` walk from origin \`${originCaseType}\` is ambiguous: \`ofCaseType\` is required to disambiguate the destination`,
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
 * `text` (matching `lib/domain/expression/jsonSchema.ts`'s default)
 * so the cast mapping stays consistent across both consumers.
 * Missing case types or undeclared properties are type-checker
 * bypasses.
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
export function compileBoundRef<Key extends string>(
	key: Key,
	bindings: ReadonlyMap<Key, RuntimeBindingValue> | undefined,
	descriptor: string,
	missingFallback?: RuntimeBindingValue,
): AliasableExpression<unknown> {
	if (bindings === undefined || !bindings.has(key)) {
		if (missingFallback !== undefined) return eb.val(missingFallback);
		// Caller-setup error voiced as direct "what to fix" — the
		// caller is the only audience. These arms can't be
		// type-checked into existence at the term layer; the
		// binding map is the runtime-resolution surface.
		throw new Error(
			[
				`\`compileTerm\`. Missing binding for ${descriptor}.`,
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
	const value = bindings.get(key);
	if (Array.isArray(value)) {
		// node-postgres binds a JavaScript array as a Postgres array. Case data
		// stores multi-select as a JSONB array, so serialize and cast explicitly;
		// relying on an implicit text[] -> jsonb cast fails at execution time.
		return eb.cast(eb.val(JSON.stringify(value)), "jsonb");
	}
	return eb.val(value);
}

/**
 * The value a term the read binds holds (`input`, a session field, a form
 * field), decided before the query runs. `undefined` for every term Postgres
 * reads per row, and for a bound term whose binding is missing, which
 * `compileTerm` then refuses.
 * A comparison decides a blank one in JavaScript (the absence check) rather
 * than in SQL, so a positive comparison keeps its expression index.
 */
export function boundComparandValue(
	term: Term,
	ctx: TermCompileContext,
): { readonly value: FormFieldBindingValue } | undefined {
	const bound = <Key extends string>(
		key: Key,
		bindings: ReadonlyMap<Key, RuntimeBindingValue> | undefined,
		missingFallback?: RuntimeBindingValue,
	) => {
		if (bindings?.has(key)) return { value: bindings.get(key) ?? null };
		return missingFallback === undefined
			? undefined
			: { value: missingFallback };
	};
	switch (term.kind) {
		case "input":
			return bound(term.searchInputUuid, ctx.bindings.searchInputs);
		case "session-user":
			if (term.source === "worker-record") return undefined;
			return bound(
				term.field,
				ctx.bindings.sessionUser,
				ctx.bindings.sessionUserFallback,
			);
		case "session-user-property": {
			if (term.source === "worker-record") return undefined;
			const slug = ctx.bindings.userPropertySlugs?.get(term.userPropertyUuid);
			if (slug === undefined) return undefined;
			return bound(
				slug,
				ctx.bindings.sessionUser,
				ctx.bindings.sessionUserFallback,
			);
		}
		case "session-context":
			return bound(term.field, ctx.bindings.sessionContext, "");
		case "session-datum": {
			const id = chosenCaseBinding(term, ctx);
			return id === undefined ? undefined : { value: id };
		}
		case "field":
			if (
				term.role !== undefined ||
				term.spelling !== undefined ||
				term.filters !== undefined
			)
				return undefined;
			return bound(term.uuid, ctx.bindings.formFields);
		default:
			return undefined;
	}
}

/** Whether a decided comparand is blank as a device reads it: `''`, an
 *  absent value, or a multi-select answer holding no choice. */
export function isBlankComparand(value: FormFieldBindingValue): boolean {
	if (value === null || value === "") return true;
	return Array.isArray(value) && value.length === 0;
}

/** Resolve one required runtime binding that is singular rather than keyed. */
export function compileBoundValue(
	value: TermBindingValue | undefined,
	descriptor: string,
): AliasableExpression<unknown> {
	if (value === undefined) {
		throw new Error(
			compilerBugMessage({
				where: "compileExpression",
				invariant: `the binding for ${descriptor} is missing`,
				detail:
					"Thread the server-resolved value through `ctx.bindings` before compiling this operation expression.",
			}),
		);
	}
	return eb.val(value);
}

// Type-erased local views because Kysely's typed builder can't
// enumerate runtime-derived alias / column strings against
// `Database`'s static column set. Each surfaces only the methods
// the call site uses; the concrete builder drives runtime
// dispatch.

/** Binary-op + column-ref shape over a runtime `${alias}.${column}` string. */
type DynamicExprBuilder = {
	(left: string, op: string, right: unknown): AliasableExpression<unknown>;
	ref: {
		(reference: string): AliasableExpression<unknown>;
		(
			reference: string,
			op: "->" | "->>",
		): { key: (key: string) => AliasableExpression<unknown> };
	};
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
