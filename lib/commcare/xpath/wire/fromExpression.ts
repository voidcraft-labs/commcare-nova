import type { OrganizationLevel } from "@/lib/domain";
import { resolveCommCareDatePattern } from "@/lib/domain/dateFormats";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { isMatchAll, simplifyForEmission } from "@/lib/domain/predicate";
import { distanceToMeters } from "@/lib/domain/predicate/distance";
import {
	canonicalizeRelationPath,
	normalizeRelationEvaluationScopes,
	type RelationEvaluationScopeContext,
} from "@/lib/domain/predicate/normalizeRelationEvaluationScopes";
import { resolveNumericExpressionType } from "@/lib/domain/predicate/numericType";
import { inferStructuralTemporalType } from "@/lib/domain/predicate/temporalType";
import type { SearchInputInstanceId } from "@/lib/domain/predicate/typeChecker";
import type {
	Predicate,
	PropertyRef,
	RelationPath,
	Term,
	ValueExpression,
} from "@/lib/domain/predicate/types";
import type { Uuid } from "@/lib/domain/uuid";
import { findOnDeviceScalarExpressionIssue } from "../../expression/onDeviceCompatibility";
import type { LookupWireNaming } from "../../lookup/naming";
import { GEOPOINT_PROPERTY_PATTERN } from "../../predicate/geopoint";
import { matchModeRunsOnDevice } from "../../predicate/matchModes";
import { w } from "./builders";
import { normalizeGeopoint, validGeopointCenter } from "./geopoint";
import {
	locationsInstance,
	lookupInstance,
	searchInputInstance,
	sessionInstance,
} from "./instances";
import {
	buildAncestorJoinNodeset,
	buildSubcaseJoinNodeset,
	caseById,
	casePropertyStep,
	DEFAULT_INSTANCE_ROOT,
	descendOnDeviceCaseAnchor,
	type InstanceRoot,
	immediateRelationPresence,
	type OnDeviceCaseAnchor,
	onDeviceAnchorCaseId,
	ROOT_ON_DEVICE_CASE_ANCHOR,
} from "./rowScope";
import type { WireComparison, WireExpr, WirePath } from "./tree";

export interface WireTermBindings {
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
	readonly searchInputNames?: ReadonlyMap<Uuid, string>;
	readonly searchInputInstanceId?: SearchInputInstanceId;
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
	readonly target: "xform" | "suite" | "hq-json" | "csql-runtime" | "preview";
	readonly types: RelationEvaluationScopeContext;
	readonly root?: InstanceRoot;
	readonly anchor?: OnDeviceCaseAnchor;
	readonly bindings?: WireTermBindings;
}
type Context = WireBuildContext & {
	readonly root: InstanceRoot;
	readonly anchor: OnDeviceCaseAnchor;
	readonly bindings: WireTermBindings;
};
const comparison: Record<
	"eq" | "neq" | "lt" | "lte" | "gt" | "gte",
	WireComparison
> = { eq: "=", neq: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" };
const predicateKinds = new Set([
	"match-all",
	"match-none",
	"and",
	"or",
	"not",
	"eq",
	"neq",
	"lt",
	"lte",
	"gt",
	"gte",
	"is-blank",
	"in",
	"between",
	"match",
	"multi-select-contains",
	"exists",
	"missing",
	"when-input-present",
	"matches-pattern",
	"within-distance",
]);
function isPredicate(expr: Predicate | ValueExpression): expr is Predicate {
	return predicateKinds.has(expr.kind);
}

/** Lower admitted domain expressions once. Serializers own every lexical choice. */
export function toWire(
	expr: Predicate | ValueExpression,
	ctx: WireBuildContext,
): WireExpr {
	const bindings = ctx.bindings ?? {};
	const context: Context = {
		...ctx,
		root: ctx.root ?? DEFAULT_INSTANCE_ROOT,
		anchor: ctx.anchor ?? ROOT_ON_DEVICE_CASE_ANCHOR,
		bindings: {
			...bindings,
			userPropertySlugs:
				bindings.userPropertySlugs ?? ctx.types.userPropertySlugs,
			searchInputNames:
				bindings.searchInputNames ??
				(ctx.types.knownInputs === undefined
					? undefined
					: new Map(
							ctx.types.knownInputs.map((input) => [input.uuid, input.name]),
						)),
			searchInputInstanceId:
				bindings.searchInputInstanceId ?? ctx.types.searchInputInstanceId,
			organizationLevels:
				bindings.organizationLevels ?? ctx.types.organizationLevels,
		},
	};
	return isPredicate(expr)
		? predicate(normalizeRelationEvaluationScopes(expr, context.types), context)
		: value(expr, context);
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
	const relation = canonicalizeRelationPath(via, ctx.types);
	return {
		via: relation.via,
		context: {
			...ctx,
			types:
				relation.destinationCaseType === undefined
					? ctx.types
					: { ...ctx.types, currentCaseType: relation.destinationCaseType },
			anchor: descendOnDeviceCaseAnchor(ctx.anchor, relation.via),
			bindings:
				relation.via.kind === "self"
					? ctx.bindings
					: clearLookupRowScope(ctx.bindings),
		},
	};
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
			return bindings.formCaseProperty(input.caseType, input.property);
		}
		case "field": {
			const result = bindings.formFields?.get(input.uuid);
			if (result === undefined)
				throw new Error(
					`Form field '${input.uuid}' has no XPath binding in this expression context.`,
				);
			return result;
		}
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
			return w.instance(searchInputInstance(id), [
				w.step("input"),
				w.step("field", [w.eq(w.context([w.attr("name")]), w.str(name))]),
			]);
		}
		case "session-user":
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
			if (lookup?.rowScope === undefined)
				throw new Error(
					"A lookup-table column term needs an explicit fixture-row scope before wire emission.",
				);
			if (lookup.rowScope.tableId !== input.tableId)
				throw new Error(
					`Lookup column reads table '${input.tableId}' inside the row scope of '${lookup.rowScope.tableId}'.`,
				);
			return w.context([
				w.step(
					lookup.naming.tableFor(input.tableId).wireNameFor(input.columnId),
				),
			]);
		}
	}
}

function value(expr: ValueExpression, ctx: Context): WireExpr {
	const issue = findOnDeviceScalarExpressionIssue(expr, ctx.types);
	if (issue?.reason === "multi-valued-relation-read")
		throw new Error(
			`Case property '${issue.property.property}' uses a '${issue.property.via?.kind}' relation that can produce several values in a scalar on-device expression. Use count(...) or a predicate relation scope.`,
		);
	const emit = (input: ValueExpression) => value(input, ctx);
	switch (expr.kind) {
		case "term": {
			const input = expr.term;
			if (
				input.kind !== "prop" ||
				input.via === undefined ||
				input.via.kind === "self"
			)
				return term(input, ctx);
			const relation = canonicalizeRelationPath(input.via, {
				...ctx.types,
				currentCaseType: ctx.types.currentCaseType ?? input.caseType,
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
		case "datetime-coerce":
			return w.call("date", [emit(expr.value)]);
		case "double":
			return w.call("double", [emit(expr.value)]);
		case "arith": {
			const left = emit(expr.left),
				right = emit(expr.right);
			if (expr.op === "div") {
				const lookupTables =
					ctx.types.lookupTables ??
					new Map(
						ctx.bindings.lookup?.naming.tables.map((table) => [
							table.tableId,
							new Map(
								table.columns.map((column) => [column.id, column.dataType]),
							),
						]),
					);
				const rowTableId = ctx.bindings.lookup?.rowScope?.tableId;
				const columns =
					rowTableId === undefined ? undefined : lookupTables.get(rowTableId);
				const type = resolveNumericExpressionType(expr, {
					...ctx.types,
					caseTypes: [...(ctx.types.caseTypes ?? [])],
					knownInputs: [...(ctx.types.knownInputs ?? [])],
					lookupTables,
					...(rowTableId !== undefined && columns !== undefined
						? { tableScope: { tableId: rowTableId, columns } }
						: {}),
				});
				if (type === "int")
					return w.call("if", [
						w.eq(right, w.num(0)),
						w.div(left, right),
						w.div(w.sub(left, w.mod(left, right)), right),
					]);
			}
			return w.arith(expr.op, left, right);
		}
		case "concat":
			return w.call("concat", expr.parts.map(emit));
		case "coalesce":
			return w.call("coalesce", expr.values.map(emit));
		case "if":
			return w.call("if", [
				predicate(normalizeRelationEvaluationScopes(expr.cond, ctx.types), ctx),
				emit(expr.then),
				emit(expr.else),
			]);
		case "switch": {
			const on = emit(expr.on);
			let result = emit(expr.fallback);
			for (const entry of [...expr.cases].reverse())
				result = w.call("if", [
					w.eq(on, wireLiteral(entry.when.value)),
					emit(entry.then),
					result,
				]);
			return result;
		}
		case "format-date":
			return w.call("format-date", [
				emit(expr.date),
				w.str(resolveCommCareDatePattern(expr.pattern)),
			]);
		case "date-add": {
			if (expr.interval === "months" || expr.interval === "years")
				throw new Error(
					`Calendar-relative date-add interval '${expr.interval}' cannot run faithfully in JavaRosa's on-device XPath evaluator.`,
				);
			if (inferStructuralTemporalType(expr.date) === "datetime")
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
			return count(expr.via, expr.where, ctx);
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
						predicate(
							normalizeRelationEvaluationScopes(where, ctx.types),
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
	}
}
function count(
	via: RelationPath,
	where: Predicate | undefined,
	ctx: Context,
): WireExpr {
	const relation = related(via, ctx);
	const child = relation.context;
	const filter =
		where === undefined
			? undefined
			: predicate(normalizeRelationEvaluationScopes(where, child.types), child);
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
			: predicate(
					normalizeRelationEvaluationScopes(where, child.types),
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
function predicate(expr: Predicate, ctx: Context): WireExpr {
	const val = (input: ValueExpression) => value(input, ctx);
	const pred = (input: Predicate) => predicate(input, ctx);
	switch (expr.kind) {
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
		case "gte":
			return w.cmp(comparison[expr.kind], val(expr.left), val(expr.right));
		case "is-blank":
			return w.eq(
				w.call("string-length", [w.call("string", [val(expr.left)])]),
				w.num(0),
			);
		case "in":
			return w.or(
				...expr.values.map((item) =>
					w.eq(val(expr.left), wireLiteral(item.value)),
				),
			);
		case "between": {
			const clauses: WireExpr[] = [];
			if (expr.lower !== undefined)
				clauses.push(
					w.cmp(
						expr.lowerInclusive ? ">=" : ">",
						val(expr.left),
						val(expr.lower),
					),
				);
			if (expr.upper !== undefined)
				clauses.push(
					w.cmp(
						expr.upperInclusive ? "<=" : "<",
						val(expr.left),
						val(expr.upper),
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
			return w.call("starts-with", [term(expr.property, ctx), val(expr.value)]);
		}
		case "multi-select-contains": {
			const parts = expr.values.map((item) =>
				w.call("selected", [term(expr.property, ctx), wireLiteral(item.value)]),
			);
			return expr.quantifier === "any" ? w.or(...parts) : w.and(...parts);
		}
		case "matches-pattern":
			return w.call("regex", [val(expr.left), w.str(expr.pattern)]);
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
					: predicate(expr.where, relation.context);
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
	}
}
