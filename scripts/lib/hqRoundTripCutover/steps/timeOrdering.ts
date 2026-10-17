/**
 * Step `time-ordering` (defect 6): a comparison that orders a time of day,
 * which is never true on a device, and a CommCare search term HQ's search
 * cannot run, each replaced in place by its never-true spelling (part 08 of
 * step 2's plan, Defect 6: ordering a time, and the three system dates in
 * CSQL).
 *
 * - A Predicate `gt`, `gte`, `lt` or `lte` with a time operand, or a
 *   `between` anchored on a time, becomes `{ kind: "match-none" }`, in every
 *   `predicate-ast` and `options-source` slot of the registry
 *   (`lib/domain/referenceSlots.ts`), read as data.
 * - A form-logic `<`, `<=`, `>` or `>=` with a time operand becomes `false()`,
 *   outermost first, in every `xpath-ast` slot of the registry and a catalog
 *   property's `required` and `validation`: the slot is printed with this
 *   module's print context, the comparison's span replaced, and the text
 *   parsed back to the stored expression with resolvers built over the rows.
 *   A reference leaf inside the span goes with it; every leaf outside it must
 *   come back as the same identity, and the result must print as the edited
 *   text.
 * - In a menu whose case search is effective, `is-blank` on `date_opened`,
 *   `closed_on` or `last_modified`, or the null literal compared with one, in
 *   the Cases available rule or an advanced search input, becomes
 *   `{ kind: "match-none" }`.
 *
 * Nothing is simplified afterwards, so the author sees where the comparison
 * was; step `hidden-from-menu`, which runs after this one, is the only step
 * that reads a display condition this leaves as `match-none`. No search input
 * is migrated: range mode is stored only on the date-range input, which ranges
 * over dates alone.
 *
 * Which operand is a time is this module's own reading of the raw rows,
 * written to the rules of `lib/commcare/validator/timeOrdering.ts`, of the
 * `time-ordering` refusal of `lib/domain/predicate/typeChecker.ts`, and of
 * `lib/domain/effectiveCaseTypes.ts`, and held equal to them by
 * `__tests__/equality.test.ts`: a time question, a hidden value whose calculate
 * is a time (in form logic), a case property whose declared type is `time`
 * (or, undeclared, whose writers are all time questions), a lookup column of
 * type `time`, a literal typed `time`, and in form logic text holding `:`;
 * through `if`, `switch` and `coalesce`, and parentheses.
 *
 * One `time-comparison-never-true` line per replaced comparison, naming its
 * carrier (the field with its form, the form, the menu, or the app for a
 * catalog property) and the comparison's text; one
 * `search-term-matches-nothing` line per replaced search term, naming the
 * menu and the term.
 */

import type { SyntaxNode } from "@lezer/common";
import { parser, parseXPathExpression } from "@/lib/commcare/xpath";
import { asUuid } from "@/lib/domain";
import {
	FIELD_REFERENCE_SLOTS,
	FORM_REFERENCE_SLOTS,
	MODULE_REFERENCE_SLOTS,
	rewriteSlotValues,
} from "@/lib/domain/referenceSlots";
import { SYSTEM_DATETIME_CASE_PROPERTIES } from "@/lib/domain/standardCaseProperties";
import type { XPathExpression } from "@/lib/domain/xpath/ast";
import { projectXPath, type XPathPrintContext } from "@/lib/domain/xpath/print";
import type { NoticeEntityRef } from "@/lib/notices/migrationNotice";
import type { Json, JsonRecord, RawDocument } from "../oldShape";
import type { CutoverStep, DocumentChange, StepContext } from "../transform";
import {
	fieldUuidsUnder,
	formXPathSlots,
	isRecord,
	type PrintedExpression,
	printExpression,
	rawPrintContext,
	rawText,
} from "./relativePaths";

const NEVER: JsonRecord = { kind: "match-none" };
const ORDERINGS: ReadonlySet<string> = new Set(["gt", "gte", "lt", "lte"]);
const COMPARISONS: ReadonlySet<string> = new Set([
	"eq",
	"neq",
	"gt",
	"gte",
	"lt",
	"lte",
]);
const OPERATOR_TEXT: Readonly<Record<string, string>> = {
	eq: "=",
	neq: "!=",
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
};
const XPATH_ORDERINGS: ReadonlySet<string> = new Set([
	"LessThanExpr",
	"LessEqualExpr",
	"GreaterThanExpr",
	"GreaterEqualExpr",
]);
/** The longest text a notice stores (`lib/notices/migrationNotice.ts::NOTICE_TEXT_MAX`). */
const NOTICE_TEXT_MAX = 200;

// ── What is a time, over the raw rows ───────────────────────────────

/**
 * The case properties whose effective type is `time`, as `caseType/property`:
 * a declared type wins; an undeclared or untyped property is a time when
 * every field that writes it is a time question.
 */
export function rawTimeProperties(document: RawDocument): ReadonlySet<string> {
	const declared = new Map<string, string | undefined>();
	if (Array.isArray(document.caseTypes)) {
		for (const caseType of document.caseTypes) {
			if (!isRecord(caseType) || !Array.isArray(caseType.properties)) continue;
			for (const property of caseType.properties) {
				if (!isRecord(property)) continue;
				const type = rawText(property.data_type);
				declared.set(
					`${rawText(caseType.name)}/${rawText(property.name)}`,
					type === "" ? undefined : type,
				);
			}
		}
	}
	const writers = new Map<string, Set<string>>();
	for (const field of Object.values(document.fields)) {
		const write = field.caseWrite;
		if (!isRecord(write)) continue;
		const key = `${rawText(write.caseType)}/${rawText(write.property)}`;
		const kinds = writers.get(key) ?? new Set<string>();
		kinds.add(rawText(field.kind));
		writers.set(key, kinds);
	}
	const times = new Set<string>();
	for (const [key, type] of declared) {
		if (type === "time") times.add(key);
	}
	for (const [key, kinds] of writers) {
		if (declared.get(key) !== undefined) continue;
		if (kinds.size === 1 && kinds.has("time")) times.add(key);
	}
	return times;
}

interface TimeContext {
	readonly document: RawDocument;
	readonly properties: ReadonlySet<string>;
	readonly columns: StepContext["lookupColumnTypes"];
	readonly print: XPathPrintContext;
}

/** Whether a Predicate operand's value is a time of day. */
function valueIsTime(value: Json | undefined, context: TimeContext): boolean {
	if (!isRecord(value)) return false;
	switch (value.kind) {
		case "term":
			return termIsTime(value.term, context);
		case "if":
			return (
				valueIsTime(value.then, context) || valueIsTime(value.else, context)
			);
		case "switch":
			return (
				valueIsTime(value.fallback, context) ||
				(Array.isArray(value.cases) &&
					value.cases.some(
						(entry) => isRecord(entry) && valueIsTime(entry.then, context),
					))
			);
		case "coalesce":
			return (
				Array.isArray(value.values) &&
				value.values.some((entry) => valueIsTime(entry, context))
			);
		default:
			return false;
	}
}

function termIsTime(term: Json | undefined, context: TimeContext): boolean {
	if (!isRecord(term)) return false;
	switch (term.kind) {
		case "literal":
			return term.data_type === "time";
		case "prop":
		case "form-case": {
			const via = term.via;
			if (isRecord(via) && via.kind !== "self") return false;
			return context.properties.has(
				`${rawText(term.caseType)}/${rawText(term.property)}`,
			);
		}
		case "field":
			return context.document.fields[rawText(term.uuid)]?.kind === "time";
		case "table-column":
			return (
				context.columns
					.get(rawText(term.tableId))
					?.get(rawText(term.columnId)) === "time"
			);
		default:
			return false;
	}
}

/** Whether a Predicate node orders a time of day. */
function ordersTime(node: JsonRecord, context: TimeContext): boolean {
	if (ORDERINGS.has(rawText(node.kind))) {
		return valueIsTime(node.left, context) || valueIsTime(node.right, context);
	}
	return node.kind === "between" && valueIsTime(node.left, context);
}

// ── Notice text ─────────────────────────────────────────────────────

function operandText(value: Json | undefined, document: RawDocument): string {
	if (!isRecord(value)) return "a value";
	if (value.kind !== "term" || !isRecord(value.term)) {
		return "a calculated value";
	}
	const term = value.term;
	switch (term.kind) {
		case "literal":
			return term.value === null ? "blank" : String(term.value);
		case "prop":
		case "form-case":
			return rawText(term.property);
		case "field":
			return rawText(document.fields[rawText(term.uuid)]?.id) || "a question";
		default:
			return "a value";
	}
}

/** A comparison as its notice line names it, e.g. `visit_time > 08:00`. */
export function comparisonText(
	node: JsonRecord,
	document: RawDocument,
): string {
	const left = operandText(node.left, document);
	let text: string;
	switch (node.kind) {
		case "between": {
			const lower =
				node.lower === undefined
					? undefined
					: operandText(node.lower, document);
			const upper =
				node.upper === undefined
					? undefined
					: operandText(node.upper, document);
			text =
				lower !== undefined && upper !== undefined
					? `${left} between ${lower} and ${upper}`
					: lower !== undefined
						? `${left} ${node.lowerInclusive === true ? ">=" : ">"} ${lower}`
						: `${left} ${node.upperInclusive === true ? "<=" : "<"} ${upper ?? "a value"}`;
			break;
		}
		case "is-blank":
			text = `${left} is blank`;
			break;
		case "in":
			text = `${left} is one of ${
				Array.isArray(node.values)
					? node.values
							.map((entry) =>
								isRecord(entry) && entry.value === null
									? "blank"
									: String(isRecord(entry) ? entry.value : ""),
							)
							.join(", ")
					: ""
			}`;
			break;
		default:
			text = `${left} ${OPERATOR_TEXT[rawText(node.kind)] ?? ""} ${operandText(node.right, document)}`;
	}
	return text.length > NOTICE_TEXT_MAX ? text.slice(0, NOTICE_TEXT_MAX) : text;
}

// ── Predicate slots ─────────────────────────────────────────────────

/**
 * Replace, in place, every node `replace` answers for, and return the
 * replaced nodes. A node that is replaced is not walked further.
 */
function replaceNodes(
	value: unknown,
	replace: (node: JsonRecord) => boolean,
	replaced: JsonRecord[],
): unknown {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			value[index] = replaceNodes(value[index], replace, replaced);
		}
		return value;
	}
	if (!isRecord(value as Json)) return value;
	const record = value as JsonRecord;
	if (replace(record)) {
		replaced.push(record);
		return { ...NEVER };
	}
	const writable = record as unknown as Record<string, unknown>;
	for (const key of Object.keys(writable)) {
		writable[key] = replaceNodes(writable[key], replace, replaced);
	}
	return record;
}

/** Every Predicate slot path of one entity kind, from the registry. */
function predicatePaths(
	slots: readonly { readonly kind: string; readonly path: string }[],
): string[] {
	return slots
		.filter(
			(slot) => slot.kind === "predicate-ast" || slot.kind === "options-source",
		)
		.map((slot) => slot.path);
}

const MODULE_PREDICATE_PATHS = predicatePaths(MODULE_REFERENCE_SLOTS);
const FORM_PREDICATE_PATHS = predicatePaths(FORM_REFERENCE_SLOTS);
const FIELD_PREDICATE_PATHS = predicatePaths(FIELD_REFERENCE_SLOTS);

/** Replace every time ordering under one entity's Predicate slots. */
function replacePredicateOrderings(
	entity: JsonRecord,
	paths: readonly string[],
	context: TimeContext,
): JsonRecord[] {
	const replaced: JsonRecord[] = [];
	for (const path of paths) {
		rewriteSlotValues(entity, path, (value) =>
			replaceNodes(value, (node) => ordersTime(node, context), replaced),
		);
	}
	return replaced;
}

// ── CommCare search terms ───────────────────────────────────────────

function systemDate(value: Json | undefined): boolean {
	return (
		isRecord(value) &&
		value.kind === "term" &&
		isRecord(value.term) &&
		value.term.kind === "prop" &&
		SYSTEM_DATETIME_CASE_PROPERTIES.has(rawText(value.term.property))
	);
}

function nullLiteral(value: Json | undefined): boolean {
	return (
		isRecord(value) &&
		value.kind === "term" &&
		isRecord(value.term) &&
		value.term.kind === "literal" &&
		value.term.value === null
	);
}

/** Whether a search term asks HQ's search what it can't answer of a system date. */
function unrunnableSearchTerm(node: JsonRecord): boolean {
	const kind = rawText(node.kind);
	if (kind === "is-blank") return systemDate(node.left);
	if (COMPARISONS.has(kind)) {
		return (
			(systemDate(node.left) && nullLiteral(node.right)) ||
			(systemDate(node.right) && nullLiteral(node.left))
		);
	}
	if (kind === "in") {
		return (
			systemDate(node.left) &&
			Array.isArray(node.values) &&
			node.values.some((entry) => isRecord(entry) && entry.value === null)
		);
	}
	if (kind === "between") {
		return (
			systemDate(node.left) &&
			(nullLiteral(node.lower) || nullLiteral(node.upper))
		);
	}
	return false;
}

/** `effectiveCaseSearchConfig`: whether the menu searches with CommCare's search. */
function searchIsEffective(module: JsonRecord): boolean {
	const config = module.caseListConfig;
	const inputs =
		isRecord(config) && Array.isArray(config.searchInputs)
			? config.searchInputs
			: [];
	const search = module.caseSearchConfig;
	if (search === undefined || search === null) return inputs.length > 0;
	return !(isRecord(search) && "searchActionEnabled" in search);
}

/** The Cases available rule and the advanced inputs' bodies: what reaches `_xpath_query`. */
function replaceSearchTerms(module: JsonRecord): JsonRecord[] {
	if (!searchIsEffective(module)) return [];
	const config = module.caseListConfig;
	if (!isRecord(config)) return [];
	const replaced: JsonRecord[] = [];
	const writable = config as unknown as Record<string, unknown>;
	if (writable.filter !== undefined) {
		writable.filter = replaceNodes(
			writable.filter,
			unrunnableSearchTerm,
			replaced,
		);
	}
	if (Array.isArray(config.searchInputs)) {
		for (const input of config.searchInputs) {
			if (!isRecord(input) || input.kind !== "advanced") continue;
			const holder = input as unknown as Record<string, unknown>;
			holder.predicate = replaceNodes(
				holder.predicate,
				unrunnableSearchTerm,
				replaced,
			);
		}
	}
	return replaced;
}

// ── Form logic ──────────────────────────────────────────────────────

function childrenOf(node: SyntaxNode): SyntaxNode[] {
	const children: SyntaxNode[] = [];
	for (let child = node.firstChild; child !== null; child = child.nextSibling) {
		children.push(child);
	}
	return children;
}

function innerOperand(children: readonly SyntaxNode[]): SyntaxNode | undefined {
	const inner = children.filter(
		(child) => child.name !== "(" && child.name !== ")",
	);
	return inner.length === 1 ? inner[0] : undefined;
}

class FormLogicReader {
	private readonly visiting = new Set<string>();

	constructor(private readonly context: TimeContext) {}

	/** Whether a node of `printed` is a time, by `timeOrdering.ts`'s operand table. */
	isTime(node: SyntaxNode, printed: PrintedExpression): boolean {
		const leaf = printed.parts.find(
			(part) => !part.isText && part.from === node.from && part.to === node.to,
		);
		if (leaf !== undefined) return this.leafIsTime(leaf.part);
		if (node.name === "StringLiteral") {
			return printed.text.slice(node.from, node.to).includes(":");
		}
		if (node.name !== "Invoke") return false;
		const name = node.getChild("FunctionName");
		const fn = name === null ? "" : printed.text.slice(name.from, name.to);
		const list = node.getChild("ArgumentList");
		const args =
			list === null
				? []
				: childrenOf(list).filter(
						(child) =>
							child.name !== "(" && child.name !== ")" && child.name !== ",",
					);
		const branches =
			fn === "if" ? args.slice(1) : fn === "coalesce" ? args : [];
		return branches.some((branch) => this.isTime(branch, printed));
	}

	private leafIsTime(part: JsonRecord): boolean {
		if (part.kind === "case-ref") {
			return this.context.properties.has(
				`${rawText(part.caseType)}/${rawText(part.property)}`,
			);
		}
		if (part.kind !== "field-ref" && part.kind !== "path-ref") return false;
		const uuid = rawText(part.uuid);
		const field = this.context.document.fields[uuid];
		if (field === undefined) return false;
		if (field.kind === "time") return true;
		if (field.kind !== "hidden" || this.visiting.has(uuid)) return false;
		const printed = printExpression(field.calculate, this.context.print);
		if (printed === undefined) return false;
		this.visiting.add(uuid);
		try {
			const inner = innerOperand(
				childrenOf(parser.parse(printed.text).topNode),
			);
			return inner !== undefined && this.isTime(inner, printed);
		} finally {
			this.visiting.delete(uuid);
		}
	}

	/** The outermost orderings on a time in `printed`, by span. */
	findings(printed: PrintedExpression): { from: number; to: number }[] {
		const spans: { from: number; to: number }[] = [];
		parser.parse(printed.text).iterate({
			enter: (cursor) => {
				if (!XPATH_ORDERINGS.has(cursor.name)) return;
				const children = childrenOf(cursor.node);
				const index = children.findIndex((child) =>
					["<", "<=", ">", ">="].includes(child.name),
				);
				if (index === -1) return;
				const left = innerOperand(children.slice(0, index));
				const right = innerOperand(children.slice(index + 1));
				if (
					(left !== undefined && this.isTime(left, printed)) ||
					(right !== undefined && this.isTime(right, printed))
				) {
					spans.push({ from: cursor.from, to: cursor.to });
					return false;
				}
				return undefined;
			},
		});
		return spans;
	}
}

/** Resolve a form's field path by stored ids, from its root. */
function rawFieldPathResolver(
	document: RawDocument,
	formUuid: string | undefined,
): (segments: readonly string[]) => string | undefined {
	return (segments) => {
		if (formUuid === undefined || segments.length === 0) return undefined;
		let parent = formUuid;
		let resolved: string | undefined;
		for (const segment of segments) {
			resolved = (document.fieldOrder[parent] ?? []).find(
				(uuid) => rawText(document.fields[uuid]?.id) === segment,
			);
			if (resolved === undefined) return undefined;
			parent = resolved;
		}
		return resolved;
	};
}

function rawSlugResolver(
	document: RawDocument,
): (slug: string) => string | undefined {
	return (slug) => {
		const matches = Object.entries(document.userProperties).filter(
			([, property]) => property.slug === slug,
		);
		return matches.length === 1 ? matches[0]?.[0] : undefined;
	};
}

function rawSearchInputResolver(
	document: RawDocument,
	moduleUuid: string | undefined,
): (name: string) => string | undefined {
	return (name) => {
		const config =
			moduleUuid === undefined
				? undefined
				: document.modules[moduleUuid]?.caseListConfig;
		if (!isRecord(config) || !Array.isArray(config.searchInputs)) {
			return undefined;
		}
		const input = config.searchInputs.find(
			(candidate) => isRecord(candidate) && candidate.name === name,
		);
		return isRecord(input) ? rawText(input.uuid) || undefined : undefined;
	};
}

/** Each stored leaf of an expression as its JSON, in order. */
function leafIdentities(parts: readonly JsonRecord[]): string[] {
	return parts
		.filter((part) => part.kind !== "text")
		.map((part) => JSON.stringify(part));
}

/**
 * Rewrite one stored form-logic expression, in place, with every outermost
 * ordering on a time replaced by `false()`. Returns the comparisons' texts.
 */
function rewriteFormLogic(
	value: unknown,
	reader: FormLogicReader,
	context: TimeContext,
	resolve: {
		readonly fieldPath: (segments: readonly string[]) => string | undefined;
		readonly slug: (slug: string) => string | undefined;
		readonly searchInput: (name: string) => string | undefined;
	},
): string[] {
	const printed = printExpression(value, context.print);
	if (printed === undefined || printed.text === "") return [];
	const spans = reader.findings(printed);
	if (spans.length === 0) return [];
	let edited = "";
	let cursor = 0;
	for (const span of spans) {
		edited += `${printed.text.slice(cursor, span.from)}false()`;
		cursor = span.to;
	}
	edited += printed.text.slice(cursor);
	const reparsed = parseXPathExpression(
		edited,
		resolve.fieldPath,
		resolve.slug,
		resolve.searchInput,
	);
	const kept = printed.parts
		.filter(
			(part) =>
				!part.isText &&
				!spans.some((span) => span.from <= part.from && part.to <= span.to),
		)
		.map((part) => part.part);
	if (
		projectXPath(reparsed, context.print).text !== edited ||
		JSON.stringify(leafIdentities(kept)) !==
			JSON.stringify(
				leafIdentities(reparsed.parts as unknown as readonly JsonRecord[]),
			)
	) {
		throw new Error(
			`Replacing the time comparisons of "${printed.text}" with false() did not read back as the same references, so the cutover cannot make this edit.`,
		);
	}
	(value as { parts: XPathExpression["parts"] }).parts = reparsed.parts;
	return spans.map((span) => {
		const text = printed.text.slice(span.from, span.to);
		return text.length > NOTICE_TEXT_MAX
			? text.slice(0, NOTICE_TEXT_MAX)
			: text;
	});
}

// ── The step ────────────────────────────────────────────────────────

function moduleEntity(uuid: string, module: JsonRecord): NoticeEntityRef {
	return {
		type: "module",
		uuid: asUuid(uuid),
		nameAtMigration: rawText(module.name),
	};
}

function formEntity(uuid: string, form: JsonRecord): NoticeEntityRef {
	return {
		type: "form",
		uuid: asUuid(uuid),
		nameAtMigration: rawText(form.name),
	};
}

function fieldEntity(uuid: string, field: JsonRecord): NoticeEntityRef {
	return {
		type: "field",
		uuid: asUuid(uuid),
		nameAtMigration: rawText(field.id),
	};
}

export const timeOrderingStep: CutoverStep = {
	id: "time-ordering",
	apply(document, stepContext) {
		const changes: DocumentChange[] = [];
		const context: TimeContext = {
			document,
			properties: rawTimeProperties(document),
			columns: stepContext.lookupColumnTypes,
			print: rawPrintContext(document),
		};
		const never = (
			entity: NoticeEntityRef,
			comparison: string,
			form?: string,
		): DocumentChange => ({
			reason: "time-comparison-never-true",
			entity,
			detail: { ...(form !== undefined && { form }), comparison },
		});

		// Form logic first: it reads hidden values' calculates as they stand.
		const reader = new FormLogicReader(context);
		const slug = rawSlugResolver(document);
		const formLogic: DocumentChange[] = [];
		for (const moduleUuid of document.moduleOrder) {
			for (const formUuid of document.formOrder[moduleUuid] ?? []) {
				const form = document.forms[formUuid];
				if (form === undefined) continue;
				const resolve = {
					fieldPath: rawFieldPathResolver(document, formUuid),
					slug,
					searchInput: rawSearchInputResolver(document, moduleUuid),
				};
				for (const slot of formXPathSlots(document, formUuid)) {
					for (const comparison of rewriteFormLogic(
						slot.value,
						reader,
						context,
						resolve,
					)) {
						const carrier = slot.carrier;
						const field =
							carrier.kind === "field"
								? document.fields[carrier.fieldUuid]
								: undefined;
						formLogic.push(
							carrier.kind === "field" && field !== undefined
								? never(
										fieldEntity(carrier.fieldUuid, field),
										comparison,
										rawText(form.name),
									)
								: never(formEntity(formUuid, form), comparison),
						);
					}
				}
			}
		}
		if (Array.isArray(document.caseTypes)) {
			const resolve = {
				fieldPath: rawFieldPathResolver(document, undefined),
				slug,
				searchInput: rawSearchInputResolver(document, undefined),
			};
			for (const caseType of document.caseTypes) {
				if (!isRecord(caseType) || !Array.isArray(caseType.properties))
					continue;
				for (const property of caseType.properties) {
					if (!isRecord(property)) continue;
					for (const slot of ["required", "validation"] as const) {
						for (const comparison of rewriteFormLogic(
							property[slot],
							reader,
							context,
							resolve,
						)) {
							formLogic.push({
								reason: "time-comparison-never-true",
								entity: { type: "app", nameAtMigration: document.appName },
								detail: {
									comparison,
									caseType: rawText(caseType.name),
									property: rawText(property.name),
								},
							});
						}
					}
				}
			}
		}

		// Predicate slots: menus, then each menu's forms and their fields.
		for (const moduleUuid of document.moduleOrder) {
			const module = document.modules[moduleUuid];
			if (module === undefined) continue;
			for (const node of replacePredicateOrderings(
				module,
				MODULE_PREDICATE_PATHS,
				context,
			)) {
				changes.push(
					never(
						moduleEntity(moduleUuid, module),
						comparisonText(node, document),
					),
				);
			}
			for (const formUuid of document.formOrder[moduleUuid] ?? []) {
				const form = document.forms[formUuid];
				if (form === undefined) continue;
				for (const node of replacePredicateOrderings(
					form,
					FORM_PREDICATE_PATHS,
					context,
				)) {
					changes.push(
						never(formEntity(formUuid, form), comparisonText(node, document)),
					);
				}
				for (const fieldUuid of fieldUuidsUnder(document, formUuid)) {
					const field = document.fields[fieldUuid];
					if (field === undefined) continue;
					for (const node of replacePredicateOrderings(
						field,
						FIELD_PREDICATE_PATHS,
						context,
					)) {
						changes.push(
							never(
								fieldEntity(fieldUuid, field),
								comparisonText(node, document),
								rawText(form.name),
							),
						);
					}
				}
			}
		}
		changes.push(...formLogic);

		// CommCare search terms.
		for (const moduleUuid of document.moduleOrder) {
			const module = document.modules[moduleUuid];
			if (module === undefined) continue;
			for (const node of replaceSearchTerms(module)) {
				changes.push({
					reason: "search-term-matches-nothing",
					entity: moduleEntity(moduleUuid, module),
					detail: { term: comparisonText(node, document) },
				});
			}
		}
		return changes;
	},
};
