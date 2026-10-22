import type { OrganizationLevel } from "@/lib/domain";
import { resolveCommCareDatePattern } from "@/lib/domain/dateFormats";
import {
	isMatchAll,
	term as termExpression,
} from "@/lib/domain/expression/builders";
import { choiceValue } from "@/lib/domain/expression/choiceValue";
import {
	activeRowScope,
	type ExpressionContext,
	pushRowScope,
} from "@/lib/domain/expression/context";
import { distanceToMeters } from "@/lib/domain/expression/distance";
import {
	comparisonOperands,
	comparisonPlan,
	type InstantComparisonKind,
	type InstantOperand,
	type InstantOperandMemo,
	instantOperand,
} from "@/lib/domain/expression/instantOperand";
import {
	canonicalizeRelationPath,
	normalizeRelationEvaluationScopes,
} from "@/lib/domain/expression/normalizeRelationEvaluationScopes";
import { simplifyForEmission } from "@/lib/domain/expression/simplify";
import {
	expressionRowScope,
	scalarDataType,
	typeOf,
} from "@/lib/domain/expression/typeChecker";
import {
	type DatumRef,
	type Expression,
	type ItextUnit,
	isExpression,
	isRelationPath,
	type PropertyRef,
	type RelationPath,
	type Term,
} from "@/lib/domain/expression/types";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import type { Uuid } from "@/lib/domain/uuid";
import type { LookupWireNaming } from "../../lookup/naming";
import { GEOPOINT_PROPERTY_PATTERN } from "../../predicate/geopoint";
import { matchModeRunsOnDevice } from "../../predicate/matchModes";
import { USERCASE_CASE_SELECTOR } from "../../usercaseWire";
import type { FormNodeProjection } from "../formNodeProjection";
import { w } from "./builders";
import { formReadToWire } from "./formReads";
import { normalizeGeopoint, validGeopointCenter } from "./geopoint";
import {
	locationsInstance,
	lookupInstance,
	searchInputInstance,
	selectedCasesInstance,
	sessionInstance,
} from "./instances";
import {
	datetimeCoerceValue,
	type InstantEmission,
	instantOperandWire,
} from "./instant";
import {
	buildAncestorJoinNodeset,
	buildSubcaseJoinNodeset,
	caseById,
	caseNodes,
	casePropertyStep,
	DEFAULT_INSTANCE_ROOT,
	descendOnDeviceCaseAnchor,
	type InstanceRoot,
	immediateRelationPresence,
	type OnDeviceCaseAnchor,
	onDeviceAnchorCaseId,
	ROOT_ON_DEVICE_CASE_ANCHOR,
} from "./rowScope";
import type { WireComparison, WireExpr, WirePath, WireStep } from "./tree";

export type SearchInputInstanceId = `search-input:${string}`;
export type WireTarget =
	| "xform"
	| "suite"
	| "hq-json"
	| "csql-runtime"
	| "preview";

export interface WireTermBindings {
	/** Concrete Preview answers and generated case-operation nodes outside the authored graph. */
	readonly formFields?: ReadonlyMap<Uuid, WireExpr>;
	readonly formCaseProperty?: (caseType: string, property: string) => WireExpr;
	readonly operationIds?: ReadonlyMap<Uuid, WireExpr>;
	readonly rootCaseIdWireExpr?: WireExpr;
	readonly caseProperty?: (
		property: PropertyRef,
		root: InstanceRoot,
		scope: "root" | "related",
	) => WireExpr | undefined;
	readonly emitSelfProperty?: (property: PropertyRef) => WireExpr;
	readonly userPropertySlugs?: ReadonlyMap<Uuid, string>;
	/** Preview can supply its existing identity fallback when no restored worker
	 * record exists. Returning undefined preserves the native record selector. */
	readonly workerProperty?: (property: string) => WireExpr | undefined;
	readonly searchInputNames?: ReadonlyMap<Uuid, string>;
	readonly searchInputInstanceId?: SearchInputInstanceId;
	readonly datumId?: (datum: DatumRef) => string | undefined;
	readonly itextId?: (unit: ItextUnit) => string | undefined;
	readonly locationPropertySlugs?: ReadonlyMap<Uuid, string>;
	readonly organizationLevels?: Readonly<Record<string, OrganizationLevel>>;
	readonly lookup?: {
		readonly naming: LookupWireNaming;
		readonly instanceScope: "xform" | "suite";
		readonly rowScope?: {
			readonly tableId: LookupTableId;
			readonly caseAnchor: OnDeviceCaseAnchor;
		};
	};
}
export interface WireBuildContext {
	readonly target: WireTarget;
	readonly types: ExpressionContext;
	readonly form?: FormNodeProjection;
	readonly root?: InstanceRoot;
	readonly anchor?: OnDeviceCaseAnchor;
	readonly bindings?: WireTermBindings;
	readonly overrides?: ReadonlyMap<Expression, WireExpr>;
}
type Context = WireBuildContext & {
	readonly root: InstanceRoot;
	readonly anchor: OnDeviceCaseAnchor;
	readonly bindings: WireTermBindings;
	/** Inside an operand of a comparison by day (a casedb system date against
	 * a day-aligned operand): a `datetime-coerce` there is Core's `date()`. It
	 * reaches only the operand's own branches, never their conditions. */
	readonly dayComparison?: true;
	/** The operands this lowering has classified, per typing context, so an
	 * expression met again (a `switch` subject, a side `in` or `between`
	 * shares) is classified once. */
	readonly instants: WeakMap<ExpressionContext, InstantOperandMemo>;
};
const comparison: Record<
	"eq" | "neq" | "lt" | "lte" | "gt" | "gte",
	WireComparison
> = { eq: "=", neq: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" };
/** Lower admitted domain expressions once. Serializers own every lexical choice. */
export function toWire(expr: Expression, ctx: WireBuildContext): WireExpr {
	const bindings = ctx.bindings ?? {};
	const context: Context = {
		...ctx,
		instants: new WeakMap(),
		root: ctx.root ?? caseRow(ctx.types)?.root ?? DEFAULT_INSTANCE_ROOT,
		anchor: ctx.anchor ?? ROOT_ON_DEVICE_CASE_ANCHOR,
		bindings: {
			...bindings,
			userPropertySlugs:
				bindings.userPropertySlugs ?? ctx.types.facts.userPropertySlugs,
			searchInputNames:
				bindings.searchInputNames ??
				new Map(
					ctx.types.profile.searchInputs.map((input) => [
						input.uuid,
						input.name,
					]),
				),
			organizationLevels:
				bindings.organizationLevels ?? ctx.types.facts.organizationLevels,
			locationPropertySlugs:
				bindings.locationPropertySlugs ??
				new Map(
					[...ctx.types.facts.locationProperties].map(([uuid, property]) => [
						uuid,
						property.slug,
					]),
				),
		},
	};
	const overrides =
		ctx.overrides === undefined ? undefined : new Map(ctx.overrides);
	const normalized = normalizeRelationEvaluationScopes(
		expr,
		relationScope(context),
		overrides === undefined
			? undefined
			: (original, replacement) => {
					const override = overrides.get(original);
					if (override !== undefined) overrides.set(replacement, override);
				},
	);
	return emitExpression(normalized, { ...context, overrides });
}
/** The classification memo of the context `ctx` types in. */
function instantMemo(ctx: Context): InstantOperandMemo {
	let memo = ctx.instants.get(ctx.types);
	if (memo === undefined) {
		memo = new WeakMap();
		ctx.instants.set(ctx.types, memo);
	}
	return memo;
}

/** Legacy table lookups explicitly capture their one containing case row.
 * Other lexical rows never reach past the active frame. */
function caseRow(types: ExpressionContext) {
	const row = activeRowScope(types);
	return row?.kind === "case"
		? row
		: row?.kind === "table"
			? row.capturedCase
			: undefined;
}
function relationScope(ctx: Context) {
	const row = caseRow(ctx.types);
	return {
		caseTypes: ctx.types.facts.caseTypes,
		...(row?.caseType === undefined ? {} : { currentCaseType: row.caseType }),
	};
}

export function wireLiteral(value: string | number | boolean | null): WireExpr {
	return typeof value === "number"
		? w.num(value)
		: w.str(value === null ? "" : String(value));
}
export function clearLookupRowScope(
	bindings: WireTermBindings,
): WireTermBindings {
	return bindings.lookup?.rowScope === undefined
		? bindings
		: {
				...bindings,
				lookup: {
					naming: bindings.lookup.naming,
					instanceScope: bindings.lookup.instanceScope,
				},
			};
}
function origin(ctx: Context): WireExpr | undefined {
	const row = ctx.bindings.lookup?.rowScope;
	return row === undefined
		? ctx.anchor.kind === "root"
			? ctx.bindings.rootCaseIdWireExpr
			: undefined
		: onDeviceAnchorCaseId(
				row.caseAnchor,
				ctx.root,
				ctx.bindings.rootCaseIdWireExpr,
			);
}
function filterPath(path: WirePath, filter: WireExpr): WirePath {
	const last = path.steps.at(-1);
	if (last === undefined)
		throw new Error("A filtered wire path needs a final step.");
	return w.path(path.root, [
		...path.steps.slice(0, -1),
		{ ...last, predicates: [...last.predicates, filter] },
	]);
}
function related(
	via: RelationPath,
	ctx: Context,
): { via: RelationPath; context: Context } {
	const relation = canonicalizeRelationPath(via, relationScope(ctx));
	return {
		via: relation.via,
		context: {
			...ctx,
			types: pushRowScope(ctx.types, {
				kind: "case",
				root: ctx.root,
				...(relation.destinationCaseType === undefined
					? {}
					: { caseType: relation.destinationCaseType }),
			}),
			anchor: descendOnDeviceCaseAnchor(ctx.anchor, relation.via),
			bindings:
				relation.via.kind === "self"
					? ctx.bindings
					: {
							...clearLookupRowScope(ctx.bindings),
							emitSelfProperty: undefined,
						},
		},
	};
}

function datumPath(datum: DatumRef, ctx: Context): WirePath {
	const id = ctx.bindings.datumId?.(datum);
	if (id === undefined)
		throw new Error(
			`The '${datum.kind}' session datum has no emitted id in this expression context.`,
		);
	return w.instance(sessionInstance(), [
		w.step("session"),
		w.step("data"),
		w.step(id),
	]);
}

function workerProperty(property: string): WireExpr {
	return w.expansion(
		"worker",
		w.append(USERCASE_CASE_SELECTOR, [w.step(property)]),
	);
}

function locationSteps(
	input: Extract<Term, { kind: "location-field" }>,
	ctx: Context,
): readonly WireStep[] {
	const field = input.field;
	if (typeof field === "string")
		return [field === "id" || field === "type" ? w.attr(field) : w.step(field)];
	if ("level" in field) {
		const level = ctx.bindings.organizationLevels?.[field.level];
		if (level === undefined)
			throw new Error(
				`Organization level '${field.level}' has no emitted location attribute.`,
			);
		return [w.attr(`${level.code}_id`)];
	}
	const slug = ctx.bindings.locationPropertySlugs?.get(field.property);
	if (slug === undefined)
		throw new Error(
			`Location property '${field.property}' has no emitted field name.`,
		);
	return [w.step("location_data"), w.step(slug)];
}

/** A projection appends relative row steps. Outer selected-case callbacks
 * must never intercept this explicitly selected row. */
function rowLeafSteps(input: Term, ctx: Context): readonly WireStep[] {
	switch (input.kind) {
		case "prop":
			if (input.via !== undefined && input.via.kind !== "self")
				throw new Error(
					"A projected property cannot traverse another relation.",
				);
			return [casePropertyStep(input.property)];
		case "case-row-type":
			return [w.attr("case_type")];
		case "case-index":
			return [w.step("index"), w.step(input.identifier)];
		case "table-column": {
			const lookup = ctx.bindings.lookup;
			if (lookup === undefined)
				throw new Error(
					"A projected table column needs the Project lookup naming catalog.",
				);
			return [
				w.step(
					lookup.naming.tableFor(input.tableId).wireNameFor(input.columnId),
				),
			];
		}
		case "location-field":
			return locationSteps(input, ctx);
		default:
			throw new Error(`The '${input.kind}' term is not a projected row value.`);
	}
}

function term(input: Term, ctx: Context): WireExpr {
	const { bindings, root, anchor } = ctx;
	switch (input.kind) {
		case "literal":
			return wireLiteral(input.value);
		case "form-case": {
			if (bindings.formCaseProperty === undefined)
				throw new Error(
					"Selected form record is unavailable in this expression context.",
				);
			return w.expansion(
				"case",
				bindings.formCaseProperty(input.caseType, input.property),
			);
		}
		case "field":
		case "form-node":
		case "repeat-row": {
			const result =
				input.kind === "field" &&
				input.role === undefined &&
				input.filters === undefined
					? bindings.formFields?.get(input.uuid)
					: undefined;
			if (result !== undefined) return result;
			if (ctx.form === undefined)
				throw new Error(
					"A form read reached wire emission without the owning form-node projection.",
				);
			return formReadToWire(input, ctx.types, ctx.form, (expression, types) =>
				emitExpression(expression, { ...ctx, types }),
			);
		}
		case "choice":
			return w.str(choiceValue(input, ctx.types.facts.options));

		case "case-type":
			return w.str(input.caseType);
		case "case-row-type":
			return w.context([w.attr("case_type")]);
		case "case-index":
			return w.context([w.step("index"), w.step(input.identifier)]);
		case "session-datum":
			return datumPath(input.datum, ctx);
		case "location-level": {
			const level = bindings.organizationLevels?.[input.levelUuid];
			if (level === undefined)
				throw new Error(
					`Organization level '${input.levelUuid}' has no emitted code.`,
				);
			return w.str(level.code);
		}
		case "location-field":
			return w.context(locationSteps(input, ctx));
		case "prop": {
			const self = input.via === undefined || input.via.kind === "self";
			if (self && bindings.emitSelfProperty !== undefined)
				return bindings.emitSelfProperty(input);
			const anchored = bindings.caseProperty?.(
				input,
				root,
				anchor.kind === "root" ? "root" : "related",
			);
			if (anchored !== undefined) return anchored;
			const leaf = casePropertyStep(input.property);
			const row = bindings.lookup?.rowScope;
			if (self && row !== undefined) {
				switch (row.caseAnchor.kind) {
					case "root":
						return w.append(
							bindings.rootCaseIdWireExpr === undefined
								? w.current()
								: caseById(bindings.rootCaseIdWireExpr, root),
							[leaf],
						);
					case "ancestor":
						return w.append(
							buildAncestorJoinNodeset(
								row.caseAnchor.via,
								root,
								bindings.rootCaseIdWireExpr,
							),
							[leaf],
						);
					case "unaddressable":
						throw new Error(
							`Case property '${input.property}' is read inside a lookup-row filter whose case cannot be addressed from current(). Validation should reject this shape before emission.`,
						);
				}
			}
			if (self) return w.context([leaf]);
			const via = input.via;
			if (via === undefined || via.kind === "self") return w.context([leaf]);
			switch (via.kind) {
				case "ancestor":
					return w.append(buildAncestorJoinNodeset(via.via, root), [leaf]);
				case "subcase":
					return w.append(
						buildSubcaseJoinNodeset(via.identifier, root, via.ofCaseType),
						[leaf],
					);
				case "any-relation":
					throw new Error(
						"An any-relation scalar read reached wire lowering before relation normalization. CommCare Core does not implement XPath union.",
					);
				default: {
					const exhaustive: never = via;
					return exhaustive;
				}
			}
		}
		case "input": {
			const name = bindings.searchInputNames?.get(input.searchInputUuid);
			if (name === undefined)
				throw new Error(
					`Search input identity '${input.searchInputUuid}' has no current runtime-name binding.`,
				);
			const id = bindings.searchInputInstanceId ?? "search-input:results";
			return w.expansion(
				"search",
				w.instance(searchInputInstance(id), [
					w.step("input"),
					w.step("field", [w.eq(w.context([w.attr("name")]), w.str(name))]),
				]),
			);
		}
		case "session-user":
			if (input.source === "worker-record")
				return (
					bindings.workerProperty?.(input.field) ?? workerProperty(input.field)
				);
			return w.instance(sessionInstance(), [
				w.step("session"),
				w.step("user"),
				w.step("data"),
				w.step(input.field),
			]);
		case "session-user-property": {
			const slug = bindings.userPropertySlugs?.get(input.userPropertyUuid);
			if (slug === undefined)
				throw new Error(
					`Worker-information property '${input.userPropertyUuid}' has no current saved-name binding.`,
				);
			if (input.source === "worker-record")
				return bindings.workerProperty?.(slug) ?? workerProperty(slug);
			return w.instance(sessionInstance(), [
				w.step("session"),
				w.step("user"),
				w.step("data"),
				w.step(slug),
			]);
		}
		case "session-context":
			return w.instance(sessionInstance(), [
				w.step("session"),
				w.step("context"),
				w.step(input.field),
			]);
		case "fixed-location":
			return w.str(input.locationUuid);
		case "owner-location-at-level": {
			const levels = bindings.organizationLevels;
			const destination = levels?.[input.levelUuid];
			if (levels === undefined || destination === undefined)
				throw new Error(
					`Organization level '${input.levelUuid}' is not available in this expression context.`,
				);
			let source =
				destination.parentLevelUuid === undefined
					? undefined
					: levels[destination.parentLevelUuid];
			const seen = new Set([destination.uuid]);
			while (source !== undefined && !source.caseFlow.ownsCases) {
				if (seen.has(source.uuid)) break;
				seen.add(source.uuid);
				source =
					source.parentLevelUuid === undefined
						? undefined
						: levels[source.parentLevelUuid];
			}
			if (source === undefined || !source.caseFlow.ownsCases)
				throw new Error(
					`Organization level '${destination.name}' has no case-owning ancestor for an owner reverse hop.`,
				);
			const owner = term(
				{ kind: "prop", caseType: input.ownerCaseType, property: "owner_id" },
				ctx,
			);
			return w.instance(locationsInstance(), [
				w.step("locations"),
				w.step("location", [
					w.eq(w.context([w.attr("type")]), w.str(destination.code)),
					w.eq(w.context([w.attr(`${source.code}_id`)]), owner),
				]),
				w.attr("id"),
			]);
		}
		case "table-column": {
			const lookup = bindings.lookup;
			const row = activeRowScope(ctx.types);
			if (lookup === undefined || row?.kind !== "table")
				throw new Error(
					"A lookup-table column term needs an explicit fixture-row scope before wire emission.",
				);
			if (row.tableId !== input.tableId)
				throw new Error(
					`Lookup column reads table '${input.tableId}' inside the row scope of '${row.tableId}'.`,
				);
			return w.context([
				w.step(
					lookup.naming.tableFor(input.tableId).wireNameFor(input.columnId),
				),
			]);
		}
	}
}

function operand(input: Expression | Term, ctx: Context): WireExpr {
	return isExpression(input) ? emitExpression(input, ctx) : term(input, ctx);
}

function queryContext(expression: Expression, ctx: Context): Context {
	const row = expressionRowScope(expression, ctx.types);
	if (row === undefined)
		throw new Error(
			`The '${expression.kind}' expression has no typed row scope.`,
		);
	return {
		...ctx,
		types: pushRowScope(ctx.types, row),
		...(row.kind === "case" ? { root: row.root } : {}),
		anchor: { kind: "unaddressable" },
		bindings: {
			...clearLookupRowScope(ctx.bindings),
			emitSelfProperty: undefined,
			caseProperty: undefined,
			rootCaseIdWireExpr: undefined,
		},
	};
}

/** One side of a comparison, emitted once in each spelling it is used in,
 * so `in`, `between` and `switch` share it across their comparisons. */
interface ComparisonSide {
	readonly expression: Expression;
	readonly operand: InstantOperand;
	bare?: WireExpr;
	day?: WireExpr;
	lowered?: WireExpr;
}
function comparisonSide(
	expression: Expression,
	ctx: Context,
	operand: InstantOperand = instantOperand(expression, ctx.types, {
		memo: instantMemo(ctx),
	}),
): ComparisonSide {
	return { expression, operand };
}
function instantEmission(ctx: Context): InstantEmission {
	return {
		value: (expression) => emitExpression(expression, ctx),
		condition: (condition) =>
			emitExpression(
				normalizeRelationEvaluationScopes(condition, relationScope(ctx)),
				ctx,
			),
		switchTests: (expression) => switchTests(expression, ctx),
	};
}
/** A comparison as a device must run it: two moments in integer
 * microseconds, two days, or as written (`instantOperand.ts::comparisonPlan`). */
function compareSides(
	kind: InstantComparisonKind,
	left: ComparisonSide,
	right: ComparisonSide,
	ctx: Context,
): WireExpr {
	const plan = comparisonPlan(kind, left.operand, right.operand);
	const wire = (side: ComparisonSide): WireExpr => {
		switch (plan) {
			case "lowered":
				side.lowered ??= instantOperandWire(side.operand, instantEmission(ctx));
				return side.lowered;
			case "day":
				side.day ??= emitExpression(side.expression, {
					...ctx,
					dayComparison: true,
				});
				return side.day;
			case "bare":
				side.bare ??= emitExpression(side.expression, ctx);
				return side.bare;
		}
	};
	return w.cmp(comparison[kind], wire(left), wire(right));
}
/** Each case's test of a `switch`, its subject emitted once. */
function switchTests(
	expr: Extract<Expression, { kind: "switch" }>,
	ctx: Context,
): readonly WireExpr[] {
	const on = comparisonSide(expr.on, ctx);
	return expr.cases.map((entry) =>
		compareSides(
			"eq",
			on,
			comparisonSide(termExpression(entry.when), ctx),
			ctx,
		),
	);
}

function emitExpression(expr: Expression, ctx: Context): WireExpr {
	const overridden = ctx.overrides?.get(expr);
	if (overridden !== undefined) return overridden;
	if (
		ctx.dayComparison === true &&
		expr.kind !== "datetime-coerce" &&
		expr.kind !== "if" &&
		expr.kind !== "coalesce" &&
		expr.kind !== "switch"
	)
		return emitExpression(expr, { ...ctx, dayComparison: undefined });
	const plain: Context =
		ctx.dayComparison === true ? { ...ctx, dayComparison: undefined } : ctx;
	const emit = (input: Expression) => emitExpression(input, ctx);
	const val = emit;
	const pred = emit;
	switch (expr.kind) {
		case "negate":
			return w.neg(emit(expr.value));
		case "call":
			return expr.fn === "normalize-space"
				? w.call("replace", [
						w.call("replace", [
							emit(expr.args[0]),
							w.str("[ \\t\\r\\n]+"),
							w.str(" "),
						]),
						w.str("^ | $"),
						w.str(""),
					])
				: w.call(expr.fn, expr.args.map(emit));
		case "here":
			return w.call("here");
		case "itext": {
			const id = ctx.bindings.itextId?.(expr.unit);
			if (id === undefined)
				throw new Error(
					`The translation unit for field '${expr.unit.field}' has no emitted text id.`,
				);
			return w.call("jr:itext", [w.str(id)]);
		}
		case "choice-name": {
			const path = ctx.form?.path({ kind: "field", uuid: expr.field });
			if (path === undefined)
				throw new Error(
					`Choice field '${expr.field}' has no emitted form path.`,
				);
			return w.call("jr:choice-name", [
				emit(expr.value),
				w.str(path.toXPath()),
			]);
		}
		case "cases": {
			const child = queryContext(expr, ctx);
			const root = expr.source === "casedb" ? "casedb" : "results:inline";
			return caseNodes(root, [
				...(expr.source === "search-results"
					? [
							w.not(
								w.eq(
									w.context([w.step("commcare_is_related_case")]),
									w.call("true"),
								),
							),
						]
					: []),
				...expr.where.map((where) => emitExpression(where, child)),
			]);
		}
		case "table-rows": {
			const lookup = ctx.bindings.lookup;
			if (lookup === undefined)
				throw new Error(
					"A lookup-row query needs the Project lookup naming catalog.",
				);
			const table = lookup.naming.tableFor(expr.tableId);
			const child = queryContext(expr, ctx);
			return w.instance(
				lookupInstance(expr.tableId, lookup.naming, lookup.instanceScope),
				[
					w.step(table.listElementName),
					w.step(
						table.rowElementName,
						expr.where.map((where) => emitExpression(where, child)),
					),
				],
			);
		}
		case "locations": {
			const child = queryContext(expr, ctx);
			return w.instance(locationsInstance(), [
				w.step("locations"),
				w.step(
					"location",
					expr.where.map((where) => emitExpression(where, child)),
				),
			]);
		}
		case "selected-cases": {
			const id = ctx.bindings.datumId?.({
				kind: "selected-case",
				module: expr.module,
			});
			if (id === undefined)
				throw new Error(
					`The selected cases for module '${expr.module}' have no emitted datum id.`,
				);
			return w.instance(selectedCasesInstance(id), [
				w.step("results"),
				w.step("value"),
			]);
		}
		case "project": {
			const base = emit(expr.of);
			if (base.k !== "path")
				throw new Error(
					"A row projection must lower from a selected node-set path.",
				);
			return w.append(
				base,
				rowLeafSteps(expr.value, queryContext(expr.of, ctx)),
			);
		}
		case "value-list":
			throw new Error(
				"A CSQL value list cannot be emitted as on-device XPath.",
			);
		case "term": {
			const input = expr.term;
			if (
				input.kind !== "prop" ||
				input.via === undefined ||
				input.via.kind === "self"
			)
				return term(input, ctx);
			const scope = relationScope(ctx);
			const relation = canonicalizeRelationPath(input.via, {
				...scope,
				currentCaseType: scope.currentCaseType ?? input.caseType,
			});
			return term({ ...input, via: relation.via }, ctx);
		}
		case "today":
		case "now":
			return w.call(expr.kind);
		case "acting-user":
			return w.form(["meta", "userID"]);
		case "unowned":
			return w.str("-");
		case "id-of": {
			const result = ctx.bindings.operationIds?.get(expr.opUuid);
			if (result === undefined)
				throw new Error(
					`Operation '${expr.opUuid}' has no case-id XPath binding in this expression context.`,
				);
			return result;
		}
		case "date-coerce":
			return w.call("date", [emit(expr.value)]);
		case "datetime-coerce":
			return ctx.dayComparison === true
				? w.call("date", [emitExpression(expr.value, plain)])
				: datetimeCoerceValue(
						instantOperand(expr, ctx.types, { memo: instantMemo(ctx) }),
						instantEmission(ctx),
					);
		case "double":
			return w.call("double", [emit(expr.value)]);
		case "arith": {
			const left = emit(expr.left),
				right = emit(expr.right);
			return expr.op === "quotient"
				? w.call("if", [
						w.eq(right, w.num(0)),
						w.div(left, right),
						w.div(w.sub(left, w.mod(left, right)), right),
					])
				: w.arith(expr.op, left, right);
		}
		case "concat":
			return w.call("concat", expr.parts.map(emit));
		case "coalesce":
			return w.call("coalesce", expr.values.map(emit));
		case "if":
			return w.call("if", [
				emitExpression(
					normalizeRelationEvaluationScopes(expr.cond, relationScope(plain)),
					plain,
				),
				emit(expr.then),
				emit(expr.else),
			]);
		case "switch": {
			const tests = switchTests(expr, plain);
			let result = emit(expr.fallback);
			for (let index = expr.cases.length - 1; index >= 0; index--) {
				const entry = expr.cases[index];
				const test = tests[index];
				if (entry === undefined || test === undefined)
					throw new Error("A switch case has no test in its emitted chain.");
				result = w.call("if", [test, emit(entry.then), result]);
			}
			return result;
		}
		case "format-date":
			return w.call("format-date", [
				emit(expr.date),
				typeof expr.pattern === "string"
					? w.str(resolveCommCareDatePattern(expr.pattern))
					: emit(expr.pattern),
			]);
		case "date-add": {
			if (expr.interval === "months" || expr.interval === "years")
				throw new Error(
					`Calendar-relative date-add interval '${expr.interval}' cannot run faithfully in JavaRosa's on-device XPath evaluator.`,
				);
			if (scalarDataType(typeOf(expr.date, ctx.types)?.data) === "datetime")
				throw new Error(
					"A date-add with a structurally datetime-typed base cannot use JavaRosa's epoch-day fallback because it would discard the time-of-day.",
				);
			const quantity = emit(expr.quantity);
			const scaled =
				expr.interval === "seconds"
					? w.div(quantity, w.num(86400))
					: expr.interval === "minutes"
						? w.div(quantity, w.num(1440))
						: expr.interval === "hours"
							? w.div(quantity, w.num(24))
							: expr.interval === "weeks"
								? w.mul(quantity, w.num(7))
								: quantity;
			return w.call("date", [
				w.call("floor", [w.add(emit(expr.date), scaled)]),
			]);
		}
		case "count":
			return isRelationPath(expr.via)
				? count(expr.via, expr.where, ctx)
				: w.call("count", [emit(expr.via)]);
		case "table-lookup": {
			const lookup = ctx.bindings.lookup;
			if (lookup === undefined)
				throw new Error(
					"A lookup-table expression reached wire emission without its Project lookup naming catalog.",
				);
			const table = lookup.naming.tableFor(expr.tableId);
			const where = simplifyForEmission(expr.where);
			const whereContext = {
				...ctx,
				types: pushRowScope(ctx.types, {
					kind: "table",
					root: "table",
					tableId: expr.tableId,
					...(caseRow(ctx.types) === undefined
						? {}
						: { capturedCase: caseRow(ctx.types) }),
				}),
				bindings: {
					...ctx.bindings,
					lookup: {
						...lookup,
						rowScope: { tableId: expr.tableId, caseAnchor: ctx.anchor },
					},
				},
			};
			const filters = isMatchAll(where)
				? []
				: [
						emitExpression(
							normalizeRelationEvaluationScopes(where, relationScope(ctx)),
							whereContext,
						),
					];
			return w.instance(
				lookupInstance(expr.tableId, lookup.naming, lookup.instanceScope),
				[
					w.step(table.listElementName),
					w.step(table.rowElementName, [...filters, w.num(1)]),
					w.step(table.wireNameFor(expr.resultColumnId)),
				],
			);
		}
		case "match-all":
			return w.call("true");
		case "match-none":
			return w.call("false");
		case "and":
			return w.and(...expr.clauses.map(pred));
		case "or":
			return w.or(...expr.clauses.map(pred));
		case "not":
			return w.not(pred(expr.clause));
		case "eq":
		case "neq":
		case "lt":
		case "lte":
		case "gt":
		case "gte": {
			const { left, right } = comparisonOperands(expr, ctx.types, {
				memo: instantMemo(ctx),
			});
			return compareSides(
				expr.kind,
				comparisonSide(expr.left, ctx, left),
				comparisonSide(expr.right, ctx, right),
				ctx,
			);
		}
		case "is-blank":
			return w.eq(
				w.call("string-length", [w.call("string", [val(expr.left)])]),
				w.num(0),
			);
		case "in": {
			const left = comparisonSide(expr.left, ctx);
			return w.or(
				...expr.values.map((item) =>
					compareSides(
						"eq",
						left,
						comparisonSide(termExpression(item), ctx),
						ctx,
					),
				),
			);
		}
		case "between": {
			const left = comparisonSide(expr.left, ctx);
			const clauses: WireExpr[] = [];
			if (expr.lower !== undefined)
				clauses.push(
					compareSides(
						expr.lowerInclusive ? "gte" : "gt",
						left,
						comparisonSide(expr.lower, ctx),
						ctx,
					),
				);
			if (expr.upper !== undefined)
				clauses.push(
					compareSides(
						expr.upperInclusive ? "lte" : "lt",
						left,
						comparisonSide(expr.upper, ctx),
						ctx,
					),
				);
			if (clauses.length === 0)
				throw new Error(
					"'between' has no bounds; the schema's at-least-one-bound refinement was bypassed.",
				);
			return w.and(...clauses);
		}
		case "match": {
			if (!matchModeRunsOnDevice(expr.mode))
				throw new Error(
					`The '${expr.mode}' match mode is a case-search function that CommCare Core's on-device XPath evaluator does not register.`,
				);
			return w.call("starts-with", [
				operand(expr.property, ctx),
				val(expr.value),
			]);
		}
		case "multi-select-contains": {
			const parts = expr.values.map((item) =>
				w.call("selected", [operand(expr.property, ctx), operand(item, ctx)]),
			);
			return expr.quantifier === "any" ? w.or(...parts) : w.and(...parts);
		}
		case "matches-pattern":
			return w.call("regex", [
				val(expr.left),
				typeof expr.pattern === "string"
					? w.str(expr.pattern)
					: emit(expr.pattern),
			]);
		case "when-input-present":
			return w.call("if", [
				w.call("count", [term(expr.input, ctx)]),
				pred(expr.clause),
				w.call("true"),
			]);
		case "exists":
		case "missing": {
			const relation = related(expr.via, ctx);
			const where =
				expr.where === undefined
					? undefined
					: emitExpression(expr.where, relation.context);
			if (relation.via.kind === "self" && where === undefined)
				return w.call(expr.kind === "exists" ? "true" : "false");
			const presence =
				relation.via.kind === "self"
					? (where ?? w.call("true"))
					: immediateRelationPresence(
							relation.via,
							where,
							ctx.root,
							origin(ctx),
						);
			return expr.kind === "exists" ? presence : w.not(presence);
		}
		case "within-distance": {
			if (typeof expr.distance !== "number" || typeof expr.unit !== "string")
				throw new Error(
					"A runtime distance radius or unit needs the CSQL query lowering.",
				);
			const property = term(expr.property, ctx),
				raw = val(expr.center),
				center = normalizeGeopoint(raw);
			const latitude = w.call("double", [
				w.call("selected-at", [property, w.num(0)]),
			]);
			const longitude = w.call("double", [
				w.call("selected-at", [property, w.num(1)]),
			]);
			const distance = w.call("distance", [property, center]);
			return w.and(
				w.call("regex", [property, w.str(GEOPOINT_PROPERTY_PATTERN)]),
				validGeopointCenter(raw, center),
				w.gte(latitude, w.num(-90)),
				w.lte(latitude, w.num(90)),
				w.gte(longitude, w.num(-180)),
				w.lte(longitude, w.num(180)),
				w.gte(distance, w.num(0)),
				w.lte(distance, w.num(distanceToMeters(expr.distance, expr.unit))),
			);
		}
		default: {
			const exhaustive: never = expr;
			throw new Error(
				`Unknown expression reached wire emission: ${String(exhaustive)}.`,
			);
		}
	}
}
function count(
	via: RelationPath,
	where: Expression | undefined,
	ctx: Context,
): WireExpr {
	const relation = related(via, ctx);
	const child = relation.context;
	const filter =
		where === undefined
			? undefined
			: emitExpression(
					normalizeRelationEvaluationScopes(where, relationScope(child)),
					child,
				);
	const asCount = (condition: WireExpr) =>
		w.call("if", [condition, w.num(1), w.num(0)]);
	if (relation.via.kind === "self")
		return filter === undefined ? w.num(1) : asCount(filter);
	if (relation.via.kind === "ancestor")
		return asCount(
			immediateRelationPresence(relation.via, filter, ctx.root, origin(ctx)),
		);
	const anchorId = origin(ctx) ?? onDeviceAnchorCaseId(ctx.anchor, ctx.root);
	if (anchorId === undefined)
		throw new Error(
			"A child-case count is nested under a relation scope that CommCare Core cannot name. Validation should reject it before wire emission.",
		);
	const nodes = buildSubcaseJoinNodeset(
		relation.via.identifier,
		ctx.root,
		relation.via.ofCaseType,
		anchorId,
	);
	const subcaseCount = w.call("count", [
		filter === undefined ? nodes : filterPath(nodes, filter),
	]);
	if (relation.via.kind === "subcase") return subcaseCount;
	const ancestor: RelationPath = {
		kind: "ancestor",
		via: [
			{
				identifier: relation.via.identifier,
				throughCaseType: relation.via.ofCaseType,
			},
		],
	};
	const ancestorContext = {
		...child,
		anchor: descendOnDeviceCaseAnchor(ctx.anchor, ancestor),
	};
	const ancestorFilter =
		where === undefined
			? undefined
			: emitExpression(
					normalizeRelationEvaluationScopes(where, relationScope(child)),
					ancestorContext,
				);
	return w.add(
		asCount(
			immediateRelationPresence(
				ancestor,
				ancestorFilter,
				ctx.root,
				origin(ctx),
			),
		),
		subcaseCount,
	);
}
