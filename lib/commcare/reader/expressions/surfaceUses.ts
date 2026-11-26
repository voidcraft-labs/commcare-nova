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
import { recordFromEntries } from "@/lib/domain/records";
import { type SourceTable, tableOf } from "../../sourceKeys";
import { inventoryIndex } from "../../surface/inventory";
import { rethrowWorkStop } from "../../workMeter";
import { type FormSyntax, literalInstanceId } from "../../xpath/formSyntax";
import {
	CSQL_QUERY_FUNCTIONS,
	CSQL_VALUE_FUNCTIONS,
} from "../../xpath/functionCapabilities";
import { sharedFormSyntax } from "../syntaxRead";
import { searchRowCsql } from "./csqlRead";
import {
	classifiedInstanceId,
	EXPRESSION_CLAIMS,
	visitSyntax,
} from "./findings";

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
	return recordFromEntries(
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

/** The uses of one expression. An XPath text's are one per key: the first
 *  class a key is used in is the one claimed, since a site claims each key
 *  once. A search row's are one per key and class (`everyClass`): the row
 *  sends several texts, each parsed on its own, so a key one text uses in one
 *  class and another text in another is a use in each. */
class Uses {
	readonly #uses = new Map<string, string[]>();
	readonly #everyClass: boolean;

	constructor(everyClass = false) {
		this.#everyClass = everyClass;
	}

	/** A use of `key` in `valueClass`, where the table holds the key; the row
	 *  whose class is undefined where none is named. */
	add(key: string, valueClass?: string): void {
		const known = this.#uses.get(key);
		if (known !== undefined && !this.#everyClass) return;
		const rows = SURFACE_USE_ENTRIES[key];
		if (rows === undefined) return;
		const row =
			rows.length === 1
				? rows[0]
				: rows.find((candidate) => candidate.valueClass === valueClass);
		if (row === undefined) return;
		if (known === undefined) this.#uses.set(key, [row.entryId]);
		else if (!known.includes(row.entryId)) known.push(row.entryId);
	}

	list(): readonly SurfaceUse[] {
		return [...this.#uses].flatMap(([key, entryIds]) =>
			entryIds.map((entryId) => ({ key, entryId })),
		);
	}
}

// ── Form and HQ JSON expressions ─────────────────────────────────────

const BINARY: SourceTable<{ token: string; expression: string }> = tableOf({
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
});
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
	return !id.includes(":") && id.includes("selected_cases")
		? "selected_cases"
		: (id.split(":")[0] ?? id);
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
	const id = literalInstanceId(at);
	return id === undefined ? undefined : { id: id.value, steps };
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
	readonly formInstancesOnly?: boolean;
	/** Whether HQ's build reads the slot's text through its shorthand
	 *  (`xpath.py::interpolate_xpath`: a menu's and a form's display condition,
	 *  the case list's filter, a detail tab's filter over a case type's
	 *  children, a Search field's required and validation conditions), which
	 *  replaces each of its patterns (`#session/`, `#user`, `#case`, `#parent`,
	 *  `#host`) wherever the text holds it, inside a string too, so each is a use
	 *  of that pattern's item (`hashtag:#case`) found in the text
	 *  (`shorthandUses`), and a hashtag there is no form builder's hashtag. */
	readonly shorthand: boolean;
	/** Whether the caller that interpolates the slot names a fixture, so
	 *  `$fixture_value` is one of its patterns: a form's display condition in a
	 *  menu whose lookup table selection is active (`menus.py`, `fixture_xpath`). */
	readonly fixtureValue: boolean;
}

const NO_FACTS: SurfaceUseFacts = {
	unsupplied: new Set(),
	computedDatums: new Set(),
	menu: "other",
	instanceSources: new Map(),
	shorthand: false,
	fixtureValue: false,
};

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
	source: string | undefined,
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
		case "groups":
			return "user-groups-fixture";
		case "locations":
			return source === "jr://fixture/commtrack:locations"
				? "hierarchical-locations"
				: "flat-locations";
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
			// the legacy id reads too, and so does the owner exclusion: HQ's
			// build writes it as a query datum (`remote_requests.py`,
			// `x_commcare_blacklisted_owner_ids`), which Core evaluates with the
			// answers (`RemoteQuerySessionManager.getRawQueryParams`).
			if (
				inModule &&
				(slot.startsWith("search_input_") || slot === "excluded_owner_ids")
			)
				return "query-build";
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

/** The patterns `xpath.py::interpolate_xpath` replaces, each with the surface
 *  key of its item. */
const SHORTHAND_PATTERNS: readonly (readonly [string, string])[] = [
	["#session/", "hashtag:#session/"],
	["#user", "hashtag:#user"],
	["#case", "hashtag:#case"],
	["#parent", "hashtag:#parent"],
	["#host", "hashtag:#host"],
];
const FIXTURE_PATTERN = "$fixture_value";
/** The class of a `#case` that names a menu's case by its slug (`#case:<slug>/…`). */
const CASE_BY_SLUG_CLASS = "case-of-a-menu-named-by-its-slug";

/**
 * The shorthand of a slot HQ interpolates, found as HQ's own replacement finds
 * it: each pattern the slot's text holds, wherever it stands, once a slot
 * (`xpath.py::interpolate_xpath`, a `str.replace` of each). `#session/` is in
 * the class of what its first occurrence names, the session's data or its
 * context and user paths; `#case` is a menu's case named by its slug where the
 * text holds `#case:` anywhere, since the replacement leaves the `:<slug>`
 * after the case's path.
 */
function shorthandUses(text: string, facts: SurfaceUseFacts, uses: Uses): void {
	for (const [pattern, key] of SHORTHAND_PATTERNS) {
		const at = text.indexOf(pattern);
		if (at < 0) continue;
		if (key === "hashtag:#session/")
			uses.add(
				key,
				text.startsWith("data/", at + pattern.length)
					? "data-datum"
					: "context-and-user-paths",
			);
		else if (key === "hashtag:#case" && text.includes("#case:"))
			uses.add(key, CASE_BY_SLUG_CLASS);
		else uses.add(key);
	}
	if (facts.fixtureValue && text.includes(FIXTURE_PATTERN))
		uses.add(`hashtag:${FIXTURE_PATTERN}`);
}

/** Whether a text's syntax holds a hashtag, which Core's lexer refuses (`xpathUses`). */
export function syntaxHoldsHashtag(
	source: FormSyntax,
	context: ExpressionContext,
	facts: SurfaceUseFacts,
): boolean {
	return xpathUses(source, undefined, context, facts, new Uses(), new Uses());
}

/** The uses of a slot's text the grammar does not read: its shorthand alone, where HQ
 *  interpolates the slot (`shorthandUses`), since HQ's replacement reads no syntax. */
export function unreadSlotUses(
	text: string,
	facts: SurfaceUseFacts,
): readonly SurfaceUse[] {
	if (!facts.shorthand) return [];
	const uses = new Uses();
	shorthandUses(text, facts, uses);
	return uses.list();
}

/**
 * The uses an XForm or HQ JSON text's syntax makes, in one walk of its tree:
 * each token, expression, axis, test, function and instance as Core's parse
 * of the text gives them, and each hashtag the text holds. A text holding a
 * hashtag is one Core's lexer refuses (`Lexer.lex` reads `#` as no token), so
 * Core parses only what HQ's build writes for it and its syntax makes no use
 * of its own: the text's uses are then its hashtags alone (`hashtags`), and
 * otherwise its syntax's alone (`uses`). Answers whether the text holds a
 * hashtag.
 */
function xpathUses(
	source: FormSyntax,
	candidate: Expression | undefined,
	context: ExpressionContext,
	facts: SurfaceUseFacts,
	uses: Uses,
	hashtags: Uses,
): boolean {
	let hashtagged = false;
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
				const operator = BINARY.get(node.op);
				if (operator !== undefined) {
					token(operator.token);
					expression(operator.expression);
				}
				visit(node.left, node);
				visit(node.right, node);
				return;
			}
			case "call": {
				token("QNAME");
				token("LPAREN");
				token("RPAREN");
				if (node.args.length > 1) token("COMMA");
				if (node.name === "instance" || node.name === "current") {
					uses.add("xpath-expr:XPathPathExpr", "instance-or-current-root");
					const id = literalInstanceId(node);
					if (id !== undefined) {
						const classed = classifiedInstanceId(
							id.value,
							facts.instanceSources.get(id.value),
						);
						if (
							classed !== undefined &&
							(!facts.formInstancesOnly || facts.instanceSources.has(id.value))
						)
							uses.add(
								`instance-scheme:${scheme(classed)}`,
								instanceClass(
									classed,
									facts.instanceSources.get(id.value),
									context,
									facts,
								),
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
				// A name an axis names (`@case_id`) is that axis's step, not a child step.
				if (parent?.kind !== "axis") uses.add("xpath-axis:AXIS_CHILD");
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
				if (
					path !== undefined &&
					classifiedInstanceId(path.id, facts.instanceSources.get(path.id)) ===
						"commcaresession"
				) {
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
				hashtagged = true;
				// A slot HQ interpolates uses its shorthand by its text (`shorthandUses`).
				if (facts.shorthand) return;
				const [first] = node.segments;
				if (node.namespace === "session")
					hashtags.add(
						"hashtag:#session/",
						first === "data" ? "data-datum" : "context-and-user-paths",
					);
				else if (node.namespace === "case")
					hashtags.add(
						first === "parent"
							? "hashtag:#case/parent"
							: first === "grandparent"
								? "hashtag:#case/grandparent"
								: "hashtag:#case/",
					);
				else hashtags.add(`hashtag:#${node.namespace}/`);
				return;
			}
		}
	};
	visit(source, undefined);
	return hashtagged;
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
	// The device works out a row while the query is built, with the Search
	// fields' answers: each read of them is that class, whatever the row's CSQL.
	visitSyntax(wrapper, (node) => {
		const id = literalInstanceId(node);
		if (id !== undefined && scheme(id.value) === "search-input")
			uses.add("instance-scheme:search-input", "query-build");
	});
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
		if (at.kind === "call")
			return at.name === "today" || at.name === "date"
				? "project-timezone-date"
				: held;
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
					// HQ's search compares a system date by its own date rule and never as a range of
					// a property (`comparison.py::property_comparison_query`), so what the right side
					// holds is the system date's class alone.
					const left = stepName(at.left);
					uses.add(
						`csql-op:${at.op}`,
						left !== undefined && SYSTEM_DATES.has(left) && !relation
							? "typed-right-side"
							: rightClass(at.op, at.right, relation),
					);
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
	// Each text the row can send HQ is parsed there on its own: every branch of a choice, the
	// `match-all()` of a presence test, the `match-none()` of a row that fails closed. The CSQL
	// the row's binding reads (`row.csql`) is no text HQ is sent.
	for (const text of row.sent) visit(text, false, undefined);
	// The row's own key in the class its presence test chooses it in, which the search
	// reader claims at the row's value.
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
 *  row holds it, before HQ's interpolation, read by the one grammar, and
 *  `text` that text, whose shorthand a slot HQ interpolates uses
 *  (`shorthandUses`); `language` whether it is form XPath or a search filter
 *  row's CSQL; `candidate` the tree held, where the slot is held; `facts` what
 *  the slot's reading and its owner say of a use's class. */
export function expressionSurfaceUses(
	source: FormSyntax,
	candidate: Expression | undefined,
	context: ExpressionContext,
	language: "xpath" | "csql",
	facts: SurfaceUseFacts = NO_FACTS,
	text?: string,
): readonly SurfaceUse[] {
	if (language === "csql") {
		const uses = new Uses(true);
		csqlUses(source, candidate, uses);
		return uses.list();
	}
	const uses = new Uses();
	const hashtags = new Uses();
	const own = xpathUses(source, candidate, context, facts, uses, hashtags)
		? hashtags
		: uses;
	if (facts.shorthand && text !== undefined) shorthandUses(text, facts, own);
	return own.list();
}

/** The claim of a form's `<instance>` declaration no held expression of the
 *  form reads, which Nova does not write back, since it writes a form's
 *  declarations from what its printed expressions read. Core initializes
 *  every declared instance when the form opens (`FormDef.initialize`), so the
 *  class is what that initialization does: a source that loads nothing, or
 *  cannot fail (`casedb`, `ledgerdb`, session and the rest), and a table the
 *  project space's list holds (project data refuses one it lacks) or
 *  `user-groups`, which CommCare HQ serves every worker, are INERT; any other
 *  fixture (`locations`, which HQ serves only where the project space uses
 *  places, `commcare:reports`, `commtrack:*`) stops the form opening where the
 *  project space does not serve it (`loadFixtureRoot`), which no export says,
 *  so the reading drops it and the first publish says so
 *  (`provisional.ts::claimDeclarations`, `unread-fixture-declarations-dropped`).
 *  The key is the declaration's source as the lane names it
 *  (`instance-source:<src>`). */
export function unreadDeclarationUse(src: string): SurfaceUse {
	const item = instanceSourceItem(src);
	const servedFixture =
		src.startsWith("jr://fixture/item-list:") ||
		src === "jr://fixture/user-groups";
	return {
		key: `instance-source:${item}`,
		entryId:
			item !== "fixture"
				? C["declared-unreferenced-instance-whose-source-loads-no-data-casedb"]
						.entry
				: servedFixture
					? C["declared-unreferenced-fixture-instance-item-list-locations-user"]
							.entry
					: C[
							"declared-unreferenced-fixture-instance-the-project-space-may-not"
						].entry,
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
	let read: ReturnType<typeof sharedFormSyntax>;
	try {
		read = sharedFormSyntax(text);
	} catch (error) {
		rethrowWorkStop(error);
		return [];
	}
	if (!read.ok || read.node === undefined) return [];
	return instanceIdsIn(read.node);
}

/** Every literal instance id in an already parsed XPath expression. */
export function instanceIdsIn(syntax: FormSyntax): readonly string[] {
	const ids: string[] = [];
	visitSyntax(syntax, (node) => {
		const id = literalInstanceId(node);
		if (id !== undefined) ids.push(id.value);
	});
	return ids;
}
