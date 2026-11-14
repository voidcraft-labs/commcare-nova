/**
 * The uses an expression's syntax makes, in the lane's vocabulary: each
 * function, path step, operator, instance, session path and CSQL word an
 * app's text holds, claimed against the manifest entry whose value class
 * takes it, held or not. The proof lane reads the same uses of Nova's own
 * exports (`proof/checks/manifest_usage.py`) and the same classes
 * (`proof/checks/manifest_value_classes.py`), so a reading's claim log and
 * the lane's standings can be held to each other.
 */
import type { ExpressionContext } from "@/lib/domain/expression/context";
import { literalShape } from "@/lib/domain/expression/ruleSets";
import type { Expression } from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import { inventoryIndex } from "../../surface/inventory";
import { canonicalInstanceId } from "../../xpath/formPathBinding";
import type { FormSyntax } from "../../xpath/formSyntax";
import {
	CSQL_QUERY_FUNCTIONS,
	CSQL_VALUE_FUNCTIONS,
} from "../../xpath/functionCapabilities";
import { readFormSyntax } from "../syntaxRead";
import { searchRowCsql } from "./csqlRead";
import { EXPRESSION_CLAIMS, visitSyntax } from "./findings";

const C = EXPRESSION_CLAIMS;

/** The surface key families an expression's syntax uses. */
const USE_FAMILIES: ReadonlySet<string> = new Set([
	"jr-fn",
	"jr-handler",
	"instance-scheme",
	"session-path",
	"xpath-expr",
	"xpath-axis",
	"xpath-test",
	"xpath-token",
	"hashtag",
	"csql-op",
	"csql-fn",
	"csql-metadata",
	"csql-unit",
	"csql-key",
]);

type UseRow = {
	readonly valueClass: string | undefined;
	readonly entryId: string;
};

/** Each surface key the expression stage claims a use of, with the entries
 *  that share it by value class: every member of `EXPRESSION_CLAIMS` whose
 *  key is of a use family, under the class its entry names. A key one entry
 *  holds has one row whose class is undefined. */
export const SURFACE_USE_ENTRIES: Readonly<Record<string, readonly UseRow[]>> =
	surfaceUseEntries();

function surfaceUseEntries(): Record<string, readonly UseRow[]> {
	const index = inventoryIndex();
	const rows = new Map<string, UseRow[]>();
	for (const claim of Object.values(C)) {
		const key = claim.key;
		if (key === null) continue;
		const family = key.slice(0, key.indexOf(":"));
		if (!USE_FAMILIES.has(family)) continue;
		const row = {
			valueClass: index.entry(claim.entry)?.valueClass ?? undefined,
			entryId: claim.entry,
		};
		const list = rows.get(key);
		if (list === undefined) rows.set(key, [row]);
		else if (!list.some((known) => known.entryId === row.entryId))
			list.push(row);
	}
	return Object.fromEntries(
		[...rows].map(([key, list]) => [
			key,
			list.length === 1
				? [{ valueClass: undefined, entryId: (list[0] as UseRow).entryId }]
				: list,
		]),
	);
}

export interface SurfaceUse {
	readonly key: string;
	readonly entryId: string;
}

/** The uses of one expression, one per key: the first class a key is used in
 *  is the one claimed, since a site claims each key once. */
class Uses {
	readonly #uses = new Map<string, string>();

	/** A use of `key` in `valueClass`, where the table holds the key; the row
	 *  whose class is undefined where none is named. */
	add(key: string, valueClass?: string): void {
		if (this.#uses.has(key)) return;
		const rows = SURFACE_USE_ENTRIES[key];
		if (rows === undefined) return;
		const row =
			rows.length === 1
				? rows[0]
				: rows.find((candidate) => candidate.valueClass === valueClass);
		if (row !== undefined) this.#uses.set(key, row.entryId);
	}

	list(): readonly SurfaceUse[] {
		return [...this.#uses].map(([key, entryId]) => ({ key, entryId }));
	}
}

// ── Form and HQ JSON expressions ─────────────────────────────────────

const BINARY: Readonly<Record<string, { token: string; expression: string }>> =
	{
		and: { token: "AND", expression: "XPathBoolExpr" },
		or: { token: "OR", expression: "XPathBoolExpr" },
		"=": { token: "EQ", expression: "XPathEqExpr" },
		"!=": { token: "NEQ", expression: "XPathEqExpr" },
		"<": { token: "LT", expression: "XPathCmpExpr" },
		"<=": { token: "LTE", expression: "XPathCmpExpr" },
		">": { token: "GT", expression: "XPathCmpExpr" },
		">=": { token: "GTE", expression: "XPathCmpExpr" },
		"+": { token: "PLUS", expression: "XPathArithExpr" },
		"-": { token: "MINUS", expression: "XPathArithExpr" },
		"*": { token: "MULT", expression: "XPathArithExpr" },
		div: { token: "DIV", expression: "XPathArithExpr" },
		mod: { token: "MOD", expression: "XPathArithExpr" },
		"|": { token: "UNION", expression: "XPathUnionExpr" },
	};
/** Operators and literals the manifest splits by whether a time stands on a
 *  side; the checker refuses a time ordered, and that refusal is the slot's
 *  own claim, so a use is the class every other operand is in. */
const OPERAND_CLASS = "non-time-operands";
const HANDLERS: ReadonlySet<string> = new Set([
	"jr:itext",
	"jr:choice-name",
	"here",
]);

function bare(node: FormSyntax): FormSyntax {
	return node.kind === "group" ? bare(node.value) : node;
}

/** The scheme an instance id is read under: the text before its first colon. */
function scheme(id: string): string {
	return id.split(":")[0] ?? id;
}

/** The path a node roots at an `instance()` call, as that call's id and the
 *  plain steps after it. */
function instancePath(
	node: FormSyntax,
): { readonly id: string; readonly steps: readonly string[] } | undefined {
	const steps: string[] = [];
	let at = bare(node);
	for (;;) {
		if (at.kind === "child" && at.left !== undefined && !at.descendant) {
			const step = bare(at.step);
			if (step.kind === "name" && !step.wildcard) steps.unshift(step.name);
			else if (step.kind === "filter") {
				const base = bare(step.base);
				if (base.kind !== "name") return undefined;
				steps.unshift(base.name);
			} else return undefined;
			at = bare(at.left);
			continue;
		}
		if (at.kind === "filter") {
			at = bare(at.base);
			continue;
		}
		break;
	}
	if (at.kind !== "call" || at.name !== "instance") return undefined;
	const first = at.args[0] === undefined ? undefined : bare(at.args[0]);
	return first?.kind === "string" ? { id: first.value, steps } : undefined;
}

/** What decides the class of a use beyond its syntax and its slot, from the
 *  slot's reading and its owner. */
export interface SurfaceUseFacts {
	/** The session datum ids the expression reads that its entry does not
	 *  supply, from the parse issue or the checker's refusal; `"all"` where
	 *  the refusal says the entry does not supply a datum the expression reads
	 *  and names none. */
	readonly unsupplied: ReadonlySet<string> | "all";
	/** The ids the slot's form's computed datums give (an advanced form's). */
	readonly computedDatums: ReadonlySet<string>;
	/** Where the slot's menu stands to a search whose answers its forms read:
	 *  the menu itself (`inline`), a child menu whose parent selection
	 *  chooses a case from that menu's list (`child-of-inline`), or neither. */
	readonly menu: "inline" | "child-of-inline" | "other";
	/** The source the slot's form declares for each instance id it names, by
	 *  id; empty outside a form. */
	readonly instanceSources: ReadonlyMap<string, string>;
}

const NO_FACTS: SurfaceUseFacts = {
	unsupplied: new Set(),
	computedDatums: new Set(),
	menu: "other",
	instanceSources: new Map(),
};

/** The id an `instance()` read is classed under: in a form, the id the source
 *  it declares for the id names, since Core reads the instance its source
 *  gives (a table's `jr://fixture/item-list:<tag>` under the bare tag Nova
 *  writes is `item-list:<tag>`); elsewhere, and for a source no id names,
 *  the id as written. */
function classedInstanceId(id: string, facts: SurfaceUseFacts): string {
	const source = facts.instanceSources.get(id);
	return (source === undefined ? undefined : canonicalInstanceId(source)) ?? id;
}

/** The session path key and class a path through the session instance makes. */
function sessionUse(
	steps: readonly string[],
	context: ExpressionContext,
	facts: SurfaceUseFacts,
): { readonly key: string; readonly valueClass?: string } | undefined {
	const [root, group, next, field] = steps;
	if (root !== "session" || next === undefined) return undefined;
	if (group === "data") {
		if (next === "stringquery" || next === "fingerprintquery")
			return { key: `session-path:session/data/${next}` };
		return {
			key: "session-path:session/data/*",
			valueClass:
				next === "supply_point_id"
					? facts.computedDatums.has(next)
						? "supply-point-id-computed-datum"
						: "supply-point-id-outside-a-computed-datum"
					: facts.unsupplied === "all" || facts.unsupplied.has(next)
						? "not-supplied"
						: "supplied",
		};
	}
	if (group === "context")
		return {
			key: `session-path:session/context/${next}`,
			valueClass:
				context.ruleSet === "form" ? "in-form-logic" : "outside-form-logic",
		};
	if (group === "user" && next === "data" && field !== undefined)
		return { key: "session-path:session/user/data/*" };
	return undefined;
}

/** The class an instance of `id` is read in from the slot it stands in and
 *  where the slot's menu stands to a search. */
function instanceClass(
	id: string,
	context: ExpressionContext,
	facts: SurfaceUseFacts,
): string | undefined {
	const slot = context.slot.slot;
	const inModule = context.slot.entity === "module";
	// A form opened after the inline query that keeps the Search answers: one
	// of the menu's own, or its registration form after an empty search.
	const inlineForm =
		facts.menu === "inline" ||
		context.form?.formsReadSearchModule === true ||
		context.form?.caseListRegistrationForm === true;
	switch (scheme(id)) {
		case "item-list":
			return slot === "lookup_options_source" || slot === "search_input_options"
				? "typed-lookup-carrier"
				: "other-expression";
		case "locations":
			return "flat-locations";
		case "commtrack":
			return id === "commtrack:locations"
				? "hierarchical-locations"
				: "products-and-programs";
		case "commcare":
		case "commcare-reports":
		case "commcare-reports-filters":
			return "mobile-ucr-reports";
		case "results":
			if (inModule) return "search-detail";
			return inlineForm ? "inline-search-form" : "non-inline-search-form";
		case "search-input":
			// A Search field's own slots run while the query is built, where
			// the legacy id reads too.
			if (inModule && slot.startsWith("search_input_")) return "query-build";
			// The legacy id is provided only while the query is built.
			if (!id.includes(":")) return "legacy-after-query";
			if (inModule)
				return facts.menu === "inline"
					? "inline-search-list"
					: "results-detail";
			if (inlineForm) return "inline-search-form";
			return facts.menu === "child-of-inline"
				? "child-menu-of-inline-search-form"
				: "non-inline-search-form";
		default:
			return undefined;
	}
}

/** Whether a node's last step is a named step, which a following `..` climbs out of. */
function endsAtName(node: FormSyntax | undefined): boolean {
	if (node === undefined) return false;
	const at = bare(node);
	if (at.kind === "name") return !at.wildcard;
	if (at.kind === "filter") return endsAtName(at.base);
	if (at.kind === "child") return endsAtName(at.step);
	return false;
}

function xpathUses(
	source: FormSyntax,
	candidate: Expression | undefined,
	context: ExpressionContext,
	facts: SurfaceUseFacts,
	uses: Uses,
): void {
	const held = candidate !== undefined;
	const token = (name: string) =>
		uses.add(`xpath-token:${name}`, OPERAND_CLASS);
	const expression = (name: string, valueClass?: string) =>
		uses.add(`xpath-expr:${name}`, valueClass ?? OPERAND_CLASS);
	const staticChoices = new Set<string>();
	if (candidate !== undefined)
		walkExpression(candidate, {
			visitExpression(node) {
				if (
					node.kind === "choice-name" &&
					context.facts.options.has(node.field)
				)
					staticChoices.add(node.field);
			},
		});
	const visit = (node: FormSyntax, parent: FormSyntax | undefined): void => {
		switch (node.kind) {
			case "string":
				token("STR");
				expression("XPathStringLiteral");
				return;
			case "number":
				token("NUM");
				expression("XPathNumericLiteral");
				return;
			case "negative":
				token("UMINUS");
				expression("XPathNumNegExpr");
				visit(node.value, node);
				return;
			case "group":
				token("LPAREN");
				token("RPAREN");
				visit(node.value, node);
				return;
			case "binary": {
				const operator = BINARY[node.op];
				if (operator !== undefined) {
					token(operator.token);
					expression(operator.expression);
				}
				visit(node.left, node);
				visit(node.right, node);
				return;
			}
			case "call": {
				token("LPAREN");
				token("RPAREN");
				if (node.args.length > 1) token("COMMA");
				if (node.name === "instance" || node.name === "current") {
					uses.add("xpath-expr:XPathPathExpr", "instance-or-current-root");
					const id =
						node.args[0] === undefined ? undefined : bare(node.args[0]);
					if (node.name === "instance" && id?.kind === "string") {
						const classed = classedInstanceId(id.value, facts);
						uses.add(
							`instance-scheme:${scheme(classed)}`,
							instanceClass(classed, context, facts),
						);
					}
				} else if (HANDLERS.has(node.name))
					uses.add(
						`jr-handler:${node.name}`,
						node.name === "here"
							? context.ruleSet === "form"
								? "in-a-form"
								: "case-list-row-context"
							: node.name === "jr:choice-name"
								? staticChoices.size > 0 || !held
									? "static-choice-select"
									: "lookup-itemset-select"
								: undefined,
					);
				else uses.add(`jr-fn:${node.name}`);
				for (const arg of node.args) visit(arg, node);
				return;
			}
			case "variable":
				uses.add(
					"xpath-token:VAR",
					context.ruleSet === "form" ? "in-a-form" : "suite-declared-variable",
				);
				expression(
					"XPathVariableReference",
					context.ruleSet === "form" ? "in-a-form" : "suite-declared-variable",
				);
				return;
			case "name":
				if (node.wildcard) {
					token("WILDCARD");
					uses.add("xpath-test:TEST_NAME_WILDCARD");
				} else {
					token("QNAME");
					uses.add("xpath-test:TEST_NAME");
				}
				uses.add("xpath-axis:AXIS_CHILD");
				uses.add("xpath-expr:XPathPathExpr");
				return;
			case "self":
				token("DOT");
				uses.add("xpath-axis:AXIS_SELF");
				uses.add("xpath-test:TEST_TYPE_NODE");
				uses.add("xpath-expr:XPathPathExpr");
				return;
			case "parent": {
				const afterName = parent?.kind === "child" && endsAtName(parent.left);
				uses.add(
					"xpath-token:DBL_DOT",
					afterName ? "parent-after-a-named-step" : undefined,
				);
				uses.add(
					"xpath-axis:AXIS_PARENT",
					afterName ? "parent-after-a-named-step" : undefined,
				);
				uses.add("xpath-test:TEST_TYPE_NODE");
				uses.add("xpath-expr:XPathPathExpr");
				return;
			}
			case "root":
				token("SLASH");
				uses.add("xpath-expr:XPathPathExpr");
				return;
			case "axis":
				if (node.axis === "attribute") {
					token("AT");
					uses.add("xpath-axis:AXIS_ATTRIBUTE");
				} else
					uses.add(
						`xpath-axis:AXIS_${node.axis.toUpperCase().replaceAll("-", "_")}`,
					);
				visit(node.value, node);
				return;
			case "child": {
				token(node.descendant ? "DBL_SLASH" : "SLASH");
				if (node.descendant) uses.add("xpath-axis:AXIS_DESCENDANT_OR_SELF");
				const path = instancePath(node);
				if (path !== undefined) {
					const session = sessionUse(path.steps, context, facts);
					if (session !== undefined) uses.add(session.key, session.valueClass);
				}
				if (node.left !== undefined) visit(node.left, node);
				visit(node.step, node);
				return;
			}
			case "filter": {
				token("LBRACK");
				token("RBRACK");
				/* A step's second predicate filters its first (`case[a][b]`): the
				 * root is the step's own. */
				let base = bare(node.base);
				while (base.kind === "filter") base = bare(base.base);
				if (
					base.kind !== "name" &&
					base.kind !== "child" &&
					!(
						base.kind === "call" &&
						(base.name === "instance" || base.name === "current")
					)
				)
					expression("XPathFilterExpr");
				visit(node.base, node);
				visit(node.where, node);
				return;
			}
			case "hashtag": {
				const [first] = node.segments;
				if (node.namespace === "session")
					uses.add(
						"hashtag:#session/",
						first === "data" ? "data-datum" : "context-and-user-paths",
					);
				if (node.namespace === "case")
					uses.add(
						first === "parent"
							? "hashtag:#case/parent"
							: first === "grandparent"
								? "hashtag:#case/grandparent"
								: "hashtag:#case/",
					);
				return;
			}
		}
	};
	visit(source, undefined);
}

// ── Search filter rows ───────────────────────────────────────────────

const RELATION_FUNCTIONS: ReadonlySet<string> = new Set([
	"ancestor-exists",
	"subcase-exists",
	"subcase-count",
]);
const SYSTEM_DATES: ReadonlySet<string> = new Set([
	"date_opened",
	"closed_on",
	"last_modified",
]);
const METADATA_STEPS: ReadonlySet<string> = new Set([
	"@case_id",
	"@case_type",
	"@owner_id",
	"@status",
	"case_name",
	"closed_on",
	"date_opened",
	"external_id",
	"last_modified",
	"name",
]);

/** The name a CSQL step reads: a name, or `@` and an attribute's name. */
function stepName(node: FormSyntax): string | undefined {
	const at = bare(node);
	if (at.kind === "name" && !at.wildcard) return at.name;
	if (at.kind === "axis" && at.axis === "attribute") {
		const inner = bare(at.value);
		return inner.kind === "name" ? `@${inner.name}` : undefined;
	}
	return undefined;
}

function csqlUses(
	wrapper: FormSyntax,
	candidate: Expression | undefined,
	uses: Uses,
): void {
	const row = searchRowCsql(wrapper);
	if (row === undefined) return;
	const isHole = (node: FormSyntax): boolean => {
		const at = bare(node);
		if (at.kind === "name") return row.holes.has(at.name);
		if (at.kind === "string")
			return [...row.holes.keys()].some((marker) => at.value.includes(marker));
		return false;
	};
	const rightClass = (
		op: string,
		right: FormSyntax,
		relation: boolean,
	): string => {
		if (relation) return "relation-arms-with-typed-right-sides";
		const at = bare(right);
		if (op === "=" && at.kind === "string" && at.value === "")
			return "blank-on-property";
		if (op === "=" || op === "!=") return "typed-right-side";
		if (candidate !== undefined || isHole(right) || at.kind === "number")
			return "typed-right-side";
		if (at.kind === "string") {
			const shape = literalShape(at.value);
			return shape !== undefined && shape.type !== "time"
				? "typed-right-side"
				: "untyped-right-side";
		}
		return "typed-right-side";
	};
	const metadataClass = (
		name: string,
		right: FormSyntax | undefined,
	): string | undefined => {
		if (!SYSTEM_DATES.has(name)) return undefined;
		const held =
			name === "closed_on"
				? "standard-readable-compared-as-datetime"
				: "standard-readable-dates-compared-as-datetimes";
		if (right === undefined || isHole(right)) return held;
		const at = bare(right);
		if (at.kind === "string") {
			const shape = literalShape(at.value);
			if (shape?.type === "date") return "project-timezone-date";
			if (shape?.type === "datetime") return held;
			return "non-date-value";
		}
		if (at.kind === "call") return held;
		return "non-date-value";
	};
	const visit = (
		node: FormSyntax,
		relation: boolean,
		right: FormSyntax | undefined,
	): void => {
		const at = bare(node);
		switch (at.kind) {
			case "binary": {
				if (at.op === "and" || at.op === "or") {
					uses.add(`csql-op:${at.op}`);
					visit(at.left, relation, undefined);
					visit(at.right, relation, undefined);
					return;
				}
				if (at.op.length <= 2) {
					uses.add(`csql-op:${at.op}`, rightClass(at.op, at.right, relation));
					visit(at.left, relation, at.right);
					visit(at.right, relation, undefined);
				}
				return;
			}
			case "call": {
				const name = at.name;
				if (CSQL_QUERY_FUNCTIONS.has(name) || CSQL_VALUE_FUNCTIONS.has(name)) {
					const first = at.args[0] === undefined ? undefined : bare(at.args[0]);
					const valueClass =
						name === "date" || name === "datetime"
							? first?.kind === "number" ||
								(first !== undefined && isHole(first) && first.kind === "name")
								? "epoch-number-argument"
								: "string-or-date-argument"
							: name === "selected" ||
									name === "selected-any" ||
									name === "selected-all"
								? at.args[1] !== undefined && isHole(at.args[1])
									? "runtime-value"
									: "literal-value"
								: name === "within-distance"
									? withinDistanceClass(at.args, isHole)
									: undefined;
					uses.add(`csql-fn:${name}`, valueClass);
				}
				if (name === "within-distance") {
					const unit = at.args[3] === undefined ? undefined : bare(at.args[3]);
					if (unit?.kind === "string" && !isHole(unit))
						uses.add(`csql-unit:${unit.value}`);
				}
				const inRelation = relation || RELATION_FUNCTIONS.has(name);
				for (const arg of at.args) visit(arg, inRelation, undefined);
				return;
			}
			default: {
				const name = stepName(at);
				if (name !== undefined && METADATA_STEPS.has(name))
					uses.add(`csql-metadata:${name}`, metadataClass(name, right));
				if (at.kind === "child") {
					if (at.left !== undefined) visit(at.left, relation, undefined);
					const last = stepName(at.step);
					if (last !== undefined && METADATA_STEPS.has(last))
						uses.add(`csql-metadata:${last}`, metadataClass(last, right));
				}
				return;
			}
		}
	};
	visit(row.csql, false, undefined);
	if (row.presence) uses.add("csql-key:_xpath_query", "input-presence-choice");
}

function withinDistanceClass(
	args: readonly FormSyntax[],
	isHole: (node: FormSyntax) => boolean,
): string {
	const distance = args[2];
	const unit = args[3] === undefined ? undefined : bare(args[3]);
	if (distance === undefined || unit === undefined) return "other-unit";
	if (isHole(distance) || isHole(unit)) return "runtime-radius-or-unit";
	return unit.kind === "string" &&
		(unit.value === "miles" || unit.value === "kilometers")
		? "static-miles-or-kilometers"
		: "other-unit";
}

/** The surface keys an expression's syntax uses, with the entry that takes
 *  each use. `source` is the text as the registration or the search filter
 *  row holds it, before HQ's interpolation, read by the one grammar;
 *  `language` whether it is form XPath or a search filter row's CSQL;
 *  `candidate` the tree held, where the slot is held; `facts` what the slot's
 *  reading and its owner say of a use's class. */
export function expressionSurfaceUses(
	source: FormSyntax,
	candidate: Expression | undefined,
	context: ExpressionContext,
	language: "xpath" | "csql",
	facts: SurfaceUseFacts = NO_FACTS,
): readonly SurfaceUse[] {
	const uses = new Uses();
	if (language === "csql") csqlUses(source, candidate, uses);
	else xpathUses(source, candidate, context, facts, uses);
	return uses.list();
}

/** The claim of a form's `<instance>` declaration no held expression of the
 *  form reads: INERT, since Nova writes a form's declarations from what its
 *  printed expressions read, so an unread one is not written back. The key is
 *  the declaration's source as the lane names it (`instance-source:<src>`). */
export function unreadDeclarationUse(src: string): SurfaceUse {
	const servedFixture =
		src.startsWith("jr://fixture/item-list:") ||
		src === "jr://fixture/locations" ||
		src === "jr://fixture/user-groups";
	return {
		key: `instance-source:${instanceSourceItem(src)}`,
		entryId: servedFixture
			? C["declared-unreferenced-fixture-instance-item-list-locations-user"]
					.entry
			: C["declared-unreferenced-instance-whose-source-loads-no-data-casedb"]
					.entry,
	};
}

/** The surface's `instance-source` item for a declared source, by the first
 *  branch of `CommCareInstanceInitializer.generateRoot` its `src` takes:
 *  ledgerdb, casedb, fixture, session (substring tests), then remote,
 *  selected entities and search input (prefix tests). */
function instanceSourceItem(src: string): string {
	if (src.includes("ledgerdb")) return "ledgerdb";
	if (src.includes("casedb")) return "casedb";
	if (src.includes("fixture")) return "fixture";
	if (src.includes("session")) return "session";
	for (const prefix of [
		"jr://instance/remote",
		"jr://instance/selected-entities",
		"jr://instance/search-input",
	])
		if (src.startsWith(prefix)) return prefix;
	return "(none)";
}

/** The instance ids a form expression's text reads, `instance('<id>')`. */
export function instanceIdsRead(text: string): readonly string[] {
	let read: ReturnType<typeof readFormSyntax>;
	try {
		read = readFormSyntax(text);
	} catch {
		return [];
	}
	if (!read.ok || read.node === undefined) return [];
	const ids: string[] = [];
	visitSyntax(read.node, (node) => {
		if (node.kind !== "call" || node.name !== "instance") return;
		const first = node.args[0] === undefined ? undefined : bare(node.args[0]);
		if (first?.kind === "string") ids.push(first.value);
	});
	return ids;
}
