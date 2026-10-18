/**
 * Frozen at expression-cutover PR 2. Both census halves import this file.
 * This reads emitted wire, never the current domain AST or wire serializer.
 * Keep every non-expression value, child order and entity identity observable.
 */
import { createHash } from "node:crypto";
import type { SyntaxNode } from "@lezer/common";
import { type AnyNode, type Document, type Element, isTag } from "domhandler";
import { removeElement } from "domutils";
import { SaxesParser } from "saxes";
import { serializeXml } from "@/lib/commcare/serializeXml";
import { parseXml } from "@/lib/commcare/xmlParse";
import { parser } from "@/lib/commcare/xpath/parser";

export const CENSUS_RUNTIME_TARGET = Object.freeze({
	server: "production" as const,
	domain: "nova-expressions-census",
	appId: "nova-expressions-census",
});
export const CENSUS_ATTACHMENT_TARGET = Object.freeze({
	origin: "https://www.commcarehq.org",
	domain: CENSUS_RUNTIME_TARGET.domain,
});
export const CENSUS_COMPILE_OPTIONS = Object.freeze({
	runtimeTarget: CENSUS_RUNTIME_TARGET,
	compiledAtSeq: 1,
	earlierHqApps: 0,
	emptyCaseListText: false,
});

export interface EmissionFragment {
	readonly file: string;
	readonly rawDigest: string;
	readonly digest: string;
}

const binary: Readonly<Record<string, readonly [string, number]>> = {
	OrExpr: ["or", 1],
	AndExpr: ["and", 2],
	EqualsExpr: ["=", 3],
	NotEqualsExpr: ["!=", 3],
	LessThanExpr: ["<", 4],
	LessEqualExpr: ["<=", 4],
	GreaterThanExpr: [">", 4],
	GreaterEqualExpr: [">=", 4],
	AddExpr: ["+", 5],
	SubtractExpr: ["-", 5],
	MultiplyExpr: ["*", 6],
	DivideExpr: ["div", 6],
	ModulusExpr: ["mod", 6],
	UnionExpr: ["|", 8],
};
const expressionKinds = new Set([
	...Object.keys(binary),
	"HashtagRef",
	"VariableReference",
	"StringLiteral",
	"NumberLiteral",
	"Child",
	"Descendant",
	"RootPath",
	"Filtered",
	"UnaryNegativeExpr",
	"AxisSpecified",
	"AttrSpecified",
	"NameTest",
	"Invoke",
	"SelfStep",
	"ParentStep",
]);

function expressionChildren(node: SyntaxNode, expected?: number): SyntaxNode[] {
	const children: SyntaxNode[] = [];
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (expressionKinds.has(child.name)) children.push(child);
	}
	if (expected !== undefined && children.length !== expected) {
		throw new Error(
			`Cannot normalize XPath: unexpected ${node.name} shape at ${node.from}.`,
		);
	}
	return children;
}

function precedence(node: SyntaxNode): number {
	return binary[node.name]?.[1] ?? (node.name === "UnaryNegativeExpr" ? 7 : 9);
}

/** Expand the shortest IEEE-754 spelling, without toFixed's truncation. */
function decimal(raw: string): string {
	const number = Number(raw);
	if (!Number.isFinite(number))
		throw new Error("Cannot normalize a nonfinite XPath number.");
	const shortest = String(number);
	const exponentAt = shortest.indexOf("e");
	if (exponentAt === -1) return shortest;
	const mantissa = shortest.slice(0, exponentAt);
	const exponent = Number(shortest.slice(exponentAt + 1));
	const point = mantissa.indexOf(".");
	const digits = mantissa.replace(".", "");
	const position = (point === -1 ? mantissa.length : point) + exponent;
	if (position <= 0) return `0.${"0".repeat(-position)}${digits}`;
	if (position >= digits.length)
		return digits + "0".repeat(position - digits.length);
	return `${digits.slice(0, position)}.${digits.slice(position)}`;
}

/** The grammar has no parenthesized-expression node. These punctuation tokens
 * distinguish a/b[1] from (a/b)[1], and must survive canonical printing. */
function groupedBase(parent: SyntaxNode, child: SyntaxNode): boolean {
	return parent.firstChild?.name === "(" && child.nextSibling?.name === ")";
}
function compoundPath(node: SyntaxNode): boolean {
	return (
		node.name === "Child" ||
		node.name === "Descendant" ||
		(node.name === "Filtered" && compoundPath(expressionChildren(node, 2)[0]))
	);
}

interface ExpressionRead {
	readonly text: string;
	readonly instances: ReadonlySet<string>;
}

function readExpression(source: string): ExpressionRead {
	const tree = parser.parse(source);
	tree.iterate({
		enter(node) {
			if (node.type.isError)
				throw new Error(`Cannot normalize malformed XPath at ${node.from}.`);
		},
	});
	const [root] = expressionChildren(tree.topNode, 1);
	const instances = new Set<string>();
	const sourceOf = (node: SyntaxNode) => source.slice(node.from, node.to);
	const print = (node: SyntaxNode): string => {
		const operator = binary[node.name];
		if (operator !== undefined) {
			const [left, right] = expressionChildren(node, 2);
			const [symbol, level] = operator;
			const associative =
				(node.name === "AndExpr" || node.name === "OrExpr") &&
				right.name === node.name;
			const l = print(left),
				r = print(right);
			return `${precedence(left) < level ? `(${l})` : l} ${symbol} ${precedence(right) < level || (precedence(right) === level && !associative) ? `(${r})` : r}`;
		}
		switch (node.name) {
			case "StringLiteral": {
				const value = sourceOf(node).slice(1, -1);
				return value.includes("'") ? `"${value}"` : `'${value}'`;
			}
			case "NumberLiteral":
				return decimal(sourceOf(node));
			case "HashtagRef":
			case "VariableReference":
			case "NameTest":
				return sourceOf(node);
			case "RootPath":
				return "/";
			case "SelfStep":
				return ".";
			case "ParentStep":
				return "..";
			case "AttrSpecified":
				return `@${print(expressionChildren(node, 1)[0])}`;
			case "AxisSpecified": {
				const axis = node.getChild("AxisName");
				if (axis === null)
					throw new Error("Cannot normalize an XPath axis without its name.");
				return `${sourceOf(axis)}::${print(expressionChildren(node, 1)[0])}`;
			}
			case "UnaryNegativeExpr": {
				const [child] = expressionChildren(node, 1);
				const value = print(child);
				return precedence(child) > 7 ? `-${value}` : `-(${value})`;
			}
			case "Invoke": {
				const name = node.getChild("FunctionName"),
					list = node.getChild("ArgumentList");
				if (name === null || list === null)
					throw new Error("Cannot normalize an incomplete XPath call.");
				const fn = sourceOf(name),
					args = expressionChildren(list);
				if (fn === "instance") {
					if (args.length !== 1 || args[0].name !== "StringLiteral") {
						throw new Error(
							"Cannot normalize a dynamic instance id: its declaration scope is unknown.",
						);
					}
					instances.add(sourceOf(args[0]).slice(1, -1));
				}
				if (fn === "concat" && args.length === 0) return "''";
				return `${fn === "is-selected" ? "selected" : fn}(${args.map(print).join(", ")})`;
			}
			case "Child":
			case "Descendant": {
				const children = expressionChildren(node),
					separator = node.name === "Child" ? "/" : "//";
				if (children.length === 1) return separator + print(children[0]);
				if (children.length !== 2)
					throw new Error("Cannot normalize an incomplete XPath path.");
				const [base, step] = children,
					value = print(base);
				return `${precedence(base) < 9 ? `(${value})` : value}${separator}${print(step)}`;
			}
			case "Filtered": {
				const [base, predicate] = expressionChildren(node, 2),
					value = print(base);
				const grouped =
					precedence(base) < 9 ||
					(groupedBase(node, base) && compoundPath(base));
				return `${grouped ? `(${value})` : value}[${print(predicate)}]`;
			}
			default:
				throw new Error(`Cannot normalize unknown XPath node ${node.name}.`);
		}
	};
	return { text: print(root), instances };
}

export function canonicalizeXPath(source: string): string {
	return readExpression(source).text;
}

const XFORMS = "http://www.w3.org/2002/xforms";
const VELLUM = "http://commcarehq.org/xforms/vellum";
const JAVAROSA = "http://openrosa.org/javarosa";
const OPENROSA = "http://openrosa.org/jr/xforms";

function localName(name: string): string {
	return name.slice(name.indexOf(":") + 1);
}
function namespace(element: Element, name: string, attribute = false): string {
	const colon = name.indexOf(":"),
		prefix = colon === -1 ? "" : name.slice(0, colon);
	if (attribute && prefix === "") return "";
	const key = prefix === "" ? "xmlns" : `xmlns:${prefix}`;
	for (
		let cursor: AnyNode | null = element;
		cursor !== null;
		cursor = cursor.parent
	) {
		if (isTag(cursor) && cursor.attribs[key] !== undefined)
			return cursor.attribs[key];
	}
	return "";
}
function children(element: Document | Element): Element[] {
	return element.children.filter(isTag);
}
function walk(
	element: Document | Element,
	visit: (element: Element) => boolean | undefined,
): void {
	for (const child of children(element)) {
		if (visit(child) !== false) walk(child, visit);
	}
}
function canonicalXml(doc: Document): string {
	walk(doc, (element) => {
		element.attribs = Object.fromEntries(
			Object.entries(element.attribs).sort(([a], [b]) => compare(a, b)),
		);
	});
	return serializeXml(doc);
}
function addAll(target: Set<string>, source: Iterable<string>): void {
	for (const id of source) target.add(id);
}

const xformAttributes: Readonly<Record<string, readonly string[]>> = {
	bind: [
		"calculate",
		"relevant",
		"constraint",
		"required",
		"readonly",
		"nodeset",
	],
	setvalue: ["ref", "value"],
	output: ["ref", "value"],
	itemset: ["nodeset"],
	group: ["ref", "relevant"],
	repeat: ["ref", "nodeset"],
	input: ["ref"],
	select: ["ref"],
	select1: ["ref"],
	upload: ["ref"],
	secret: ["ref"],
	range: ["ref"],
	trigger: ["ref"],
	submit: ["ref"],
	label: ["ref"],
	hint: ["ref"],
	help: ["ref"],
	alert: ["ref"],
	value: ["ref"],
};
const shadowAttributes = new Set([
	"calculate",
	"relevant",
	"constraint",
	"requiredCondition",
	"required",
	"nodeset",
	"value",
	"ref",
	"jr__count",
]);

function xformSlots(element: Element): string[] {
	const elementName = localName(element.name),
		uri = namespace(element, element.name);
	return Object.keys(element.attribs).filter((name) => {
		const attrUri = namespace(element, name, true),
			attr = localName(name);
		if (attrUri === VELLUM) return shadowAttributes.has(attr);
		if (attrUri === JAVAROSA)
			return (
				(elementName === "repeat" && attr === "count") ||
				(elementName === "bind" && attr === "constraintMsg")
			);
		if (name.includes(":")) return false;
		if (uri === OPENROSA && elementName === "pollsensor") return name === "ref";
		return (
			(uri === XFORMS || uri === "") &&
			(xformAttributes[elementName]?.includes(name) ?? false)
		);
	});
}

function normalizeSlots(
	element: Element,
	slots: readonly string[],
): Set<string> {
	const reads = new Set<string>();
	for (const name of slots) {
		const value = element.attribs[name];
		// Empty optional expressions are the wire's absence sentinel, not XPath.
		if (value === "") continue;
		const expression = readExpression(value);
		element.attribs[name] = expression.text;
		addAll(reads, expression.instances);
	}
	return reads;
}

function xformDocument(xml: string): { doc: Document; models: Element[] } {
	const doc = parseXml(xml),
		models: Element[] = [];
	walk(doc, (element) => {
		if (localName(element.name) === "instance") return false;
		if (
			localName(element.name) === "model" &&
			[XFORMS, ""].includes(namespace(element, element.name))
		)
			models.push(element);
	});
	if (models.length !== 1)
		throw new Error("Cannot normalize an XForm without exactly one model.");
	return { doc, models };
}

export function normalizeXForm(xml: string): string {
	const { doc, models } = xformDocument(xml),
		reads = new Set<string>();
	walk(doc, (element) => {
		// The primary instance and every secondary instance contain DATA. Their
		// fields can be called ref, calculate, bind or instance without being code.
		if (localName(element.name) === "instance") return false;
		addAll(reads, normalizeSlots(element, xformSlots(element)));
	});
	for (const model of models) {
		const instances = children(model).filter(
			(instance) => localName(instance.name) === "instance",
		);
		// Absolute and relative data paths read the first instance without an
		// instance(...) call, including when that primary instance has an id.
		for (const instance of instances.slice(1)) {
			const { id } = instance.attribs;
			if (id === undefined)
				throw new Error(
					"Cannot normalize an unnamed secondary XForm instance.",
				);
			if (!reads.has(id)) removeElement(instance);
		}
	}
	return canonicalXml(doc);
}

const suiteAttributes: Readonly<Record<string, readonly string[]>> = {
	xpath: ["function"],
	group: ["function", "relevant"],
	datum: ["function", "nodeset", "value"],
	"instance-datum": ["function", "nodeset", "value"],
	form: ["function", "nodeset", "value"],
	data: ["ref", "nodeset", "exclude"],
	itemset: ["nodeset"],
	label: ["ref"],
	value: ["ref"],
	sort: ["ref"],
	prompt: ["default", "exclude", "relevant"],
	required: ["test"],
	validation: ["test"],
	assert: ["test"],
	menu: ["relevant"],
	command: ["relevant", "value"],
	field: ["relevant"],
	detail: ["relevant"],
	action: ["relevant", "auto_launch"],
	post: ["relevant"],
	create: ["if"],
	push: ["if"],
	clear: ["if"],
	rewind: ["value"],
};
function suiteSlots(element: Element): string[] {
	if (namespace(element, element.name) !== "") return [];
	const attrs = suiteAttributes[element.name] ?? [];
	return attrs.filter((name) => element.attribs[name] !== undefined);
}

interface Scope {
	readonly element: Element;
	readonly declarations: Map<string, Element>;
	readonly used: Set<string>;
}

function suiteDocument(xml: string): { doc: Document; suite: Element } {
	const doc = parseXml(xml),
		roots = children(doc);
	if (roots.length !== 1 || roots[0].name !== "suite")
		throw new Error("Cannot normalize XML without one suite root.");
	return { doc, suite: roots[0] };
}
function stripFixtures(suite: Element): void {
	for (const element of children(suite))
		if (element.name === "fixture") removeElement(element);
}

/** Preserve actual source bytes for the raw digest. DOM serialization would
 * hide quote/entity/attribute-order respellings before the raw census. SAXES
 * determines element boundaries; parseXml has already validated the XML. */
function suiteBytesWithoutFixtures(xml: string): string {
	const xmlParser = new SaxesParser({ xmlns: true });
	const ranges: [number, number][] = [];
	let depth = 0,
		start: number | undefined;
	xmlParser.on("opentagstart", (tag) => {
		if (depth === 1 && tag.name === "fixture") {
			start = xml.lastIndexOf("<", xmlParser.position - 1);
		}
	});
	xmlParser.on("opentag", () => {
		depth++;
	});
	xmlParser.on("closetag", (tag) => {
		if (depth === 2 && tag.name === "fixture") {
			if (start === undefined || start < 0)
				throw new Error("Cannot locate a suite fixture in its source.");
			ranges.push([start, xmlParser.position]);
			start = undefined;
		}
		depth--;
	});
	xmlParser.write(xml).close();
	let previous = 0,
		result = "";
	for (const [from, to] of ranges) {
		result += xml.slice(previous, from);
		previous = to;
	}
	return result + xml.slice(previous);
}

export function normalizeSuite(xml: string): string {
	const { doc, suite } = suiteDocument(xml);
	const reads = new Map<Element, Set<string>>(),
		scopes: Scope[] = [],
		details = new Map<string, Element>();
	walk(doc, (element) => {
		if (element.name === "fixture" || element.name === "instance") return false;
		reads.set(element, normalizeSlots(element, suiteSlots(element)));
		if (["entry", "remote-request", "view", "menu"].includes(element.name)) {
			const declarations = new Map<string, Element>();
			for (const declaration of children(element).filter(
				(child) => child.name === "instance",
			)) {
				const id = declaration.attribs.id;
				if (!id || declarations.has(id))
					throw new Error(
						"Cannot normalize missing or duplicate suite instance identity.",
					);
				declarations.set(id, declaration);
			}
			scopes.push({ element, declarations, used: new Set() });
		}
		if (element.name === "detail" && element.parent === suite) {
			const id = element.attribs.id;
			if (!id || details.has(id))
				throw new Error(
					"Cannot normalize missing or duplicate suite detail identity.",
				);
			details.set(id, element);
		}
	});
	const subtreeReads = (element: Element): Set<string> => {
		const result = new Set(reads.get(element));
		walk(element, (child) => {
			if (child.name === "fixture" || child.name === "instance") return false;
			addAll(result, reads.get(child) ?? []);
		});
		return result;
	};
	const entries = scopes.filter((scope) => scope.element.name !== "menu");
	const menus = scopes.filter((scope) => scope.element.name === "menu");
	const commands = new Map<string, Scope>();
	for (const entry of entries) {
		addAll(entry.used, subtreeReads(entry.element));
		for (const command of children(entry.element).filter(
			(child) => child.name === "command",
		)) {
			if (command.attribs.id !== undefined)
				commands.set(command.attribs.id, entry);
		}
		walk(entry.element, (datum) => {
			if (datum.name === "instance" || datum.name === "fixture") return false;
			if (datum.name !== "datum" && datum.name !== "instance-datum") return;
			for (const name of ["detail-select", "detail-confirm"]) {
				const id = datum.attribs[name];
				if (id === undefined) continue;
				const detail = details.get(id);
				if (detail === undefined)
					throw new Error(
						"Cannot normalize a suite with an unresolved detail.",
					);
				addAll(entry.used, subtreeReads(detail));
			}
		});
	}
	/** Core's restricted context uses the first command in every same-id menu
	 * before a direct entry, then overlays every same-id menu's instances. A
	 * command is evaluated by its OWN id, never its containing menu's id. */
	const markRestricted = (
		id: string | undefined,
		refs: ReadonlySet<string>,
	) => {
		if (id === undefined) {
			if (refs.size > 0)
				throw new Error("Cannot resolve an unnamed suite navigation scope.");
			return;
		}
		const matching = menus.filter((menu) => menu.element.attribs.id === id);
		const firstCommand = matching.flatMap((menu) =>
			children(menu.element).filter((child) => child.name === "command"),
		)[0];
		const entry = commands.get(
			firstCommand === undefined ? id : firstCommand.attribs.id,
		);
		const owners = new Map<string, Scope>();
		for (const scope of [
			...(entry === undefined ? [] : [entry]),
			...matching,
		]) {
			for (const instance of scope.declarations.keys())
				owners.set(instance, scope);
		}
		for (const ref of refs) owners.get(ref)?.used.add(ref);
	};
	for (const menu of menus) {
		const own = new Set(reads.get(menu.element));
		for (const child of children(menu.element)) {
			if (child.name === "instance") continue;
			if (child.name === "command")
				markRestricted(child.attribs.id, subtreeReads(child));
			else addAll(own, subtreeReads(child));
		}
		markRestricted(menu.element.attribs.id, own);
	}
	for (const scope of scopes) {
		for (const [id, declaration] of scope.declarations) {
			if (!scope.used.has(id)) removeElement(declaration);
		}
	}
	// Lookup row bytes are excluded from the census; their declarations were
	// just analyzed using the executable slots, never the fixture's data.
	stripFixtures(suite);
	return canonicalXml(doc);
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
function object(value: Json | undefined, context: string): JsonObject {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Cannot normalize ${context}: expected an object.`);
	return value;
}
function array(value: Json | undefined, context: string): Json[] {
	if (!Array.isArray(value))
		throw new Error(`Cannot normalize ${context}: expected an array.`);
	return value;
}
function string(value: Json | undefined, context: string): string {
	if (typeof value !== "string" || value === "")
		throw new Error(`Cannot normalize ${context}: expected a nonempty string.`);
	return value;
}
function jsonClone(value: unknown): JsonObject {
	return object(JSON.parse(JSON.stringify(value)) as Json, "HQ application");
}
function optionalObject(
	parent: JsonObject,
	name: string,
): JsonObject | undefined {
	return parent[name] === undefined || parent[name] === null
		? undefined
		: object(parent[name], name);
}
function objectArray(parent: JsonObject, name: string): JsonObject[] {
	return parent[name] === undefined
		? []
		: array(parent[name], name).map((value) => object(value, name));
}
function normalizeStrings(
	parent: JsonObject | undefined,
	names: readonly string[],
): void {
	if (parent === undefined) return;
	for (const name of names) {
		const value = parent[name];
		if (value === undefined || value === null || value === "") continue;
		if (typeof value !== "string")
			throw new Error(`Cannot normalize HQ XPath ${name}: expected a string.`);
		parent[name] = canonicalizeXPath(value);
	}
}

/** Exact wire carriers; a translated label can have keys named field or test. */
export function normalizeHqApplication(value: unknown): JsonObject {
	const app = jsonClone(value);
	for (const module of objectArray(app, "modules")) {
		normalizeStrings(module, ["module_filter"]);
		normalizeStrings(optionalObject(module, "case_list_form"), [
			"relevancy_expression",
		]);
		const details = optionalObject(module, "case_details");
		if (details !== undefined)
			for (const name of ["short", "long"]) {
				const detail = optionalObject(details, name);
				if (detail === undefined) continue;
				normalizeStrings(detail, ["filter"]);
				for (const column of objectArray(detail, "columns")) {
					normalizeStrings(column, [
						"calc_xpath",
						"filter_xpath",
						"relevant",
						"nodeset",
					]);
					if (column.useXpathExpression === true)
						normalizeStrings(column, ["field"]);
				}
			}
		for (const form of objectArray(module, "forms")) {
			normalizeStrings(form, ["form_filter"]);
			for (const link of objectArray(form, "form_links")) {
				normalizeStrings(link, ["xpath"]);
				for (const datum of objectArray(link, "datums"))
					normalizeStrings(datum, ["xpath"]);
			}
		}
		const search = optionalObject(module, "search_config");
		if (search === undefined) continue;
		normalizeStrings(search, [
			"search_button_display_condition",
			"blacklisted_owner_ids_expression",
		]);
		for (const property of objectArray(search, "properties")) {
			normalizeStrings(property, ["default_value"]);
			normalizeStrings(optionalObject(property, "required"), ["test"]);
			for (const validation of objectArray(property, "validations"))
				normalizeStrings(validation, ["test"]);
			normalizeStrings(optionalObject(property, "itemset"), [
				"nodeset",
				"label",
				"value",
				"sort",
			]);
		}
		for (const property of objectArray(search, "default_properties"))
			normalizeStrings(property, ["defaultValue"]);
	}
	const attachments = optionalObject(app, "_attachments");
	if (attachments !== undefined)
		for (const [name, attachment] of Object.entries(attachments)) {
			if (!name.endsWith(".xml") || typeof attachment !== "string")
				throw new Error("Cannot normalize an unknown HQ attachment shape.");
			attachments[name] = normalizeXForm(attachment);
		}
	return app;
}

function canonicalJson(value: Json): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
function identity(value: JsonObject, name: string): string {
	return string(value[name], name);
}
function without(value: JsonObject, keys: readonly string[]): JsonObject {
	return Object.fromEntries(
		Object.entries(value).filter(([key]) => !keys.includes(key)),
	);
}
function primaryNamespace(xml: string): string {
	const { models } = xformDocument(xml);
	const instance = children(models[0]).find(
		(element) => localName(element.name) === "instance",
	);
	const data = instance === undefined ? undefined : children(instance)[0];
	if (data === undefined)
		throw new Error("Cannot identify an XForm without its primary instance.");
	const xmlns = namespace(data, data.name);
	if (xmlns === "" || xmlns === XFORMS)
		throw new Error("Cannot identify an XForm without its data namespace.");
	return xmlns;
}

/** Logical fragments make later named-change verdicts entity-specific. Parent
 * shells retain ordered identity vectors; splitting never hides an addition,
 * deletion, reorder, attachment rename or archive resource path change. */
export function normalizeEmittedApp(
	value: unknown,
	localFiles: Readonly<Record<string, string>> | ReadonlyMap<string, string>,
): EmissionFragment[] {
	const raw = jsonClone(value),
		normalized = normalizeHqApplication(raw);
	const fragments: EmissionFragment[] = [],
		keys = new Set<string>();
	const add = (file: string, before: string, after: string) => {
		if (keys.has(file))
			throw new Error("Cannot census duplicate emitted identities.");
		keys.add(file);
		fragments.push({ file, rawDigest: digest(before), digest: digest(after) });
	};
	const json = (file: string, before: Json, after: Json) =>
		add(file, JSON.stringify(before), canonicalJson(after));
	const modules = objectArray(raw, "modules"),
		normalModules = objectArray(normalized, "modules");
	const moduleIds = modules.map((module) => identity(module, "unique_id"));
	if (new Set(moduleIds).size !== moduleIds.length)
		throw new Error("Cannot census duplicate HQ module identities.");
	const attachments = object(raw._attachments, "HQ attachments"),
		normalAttachments = object(normalized._attachments, "HQ attachments");
	const formNamespaces = new Map<string, string>(),
		formIds = new Set<string>();
	for (let m = 0; m < modules.length; m++) {
		const module = modules[m],
			normalModule = normalModules[m],
			moduleId = moduleIds[m];
		const forms = objectArray(module, "forms"),
			normalForms = objectArray(normalModule, "forms");
		const ids = forms.map((form) => identity(form, "unique_id"));
		const prefix = `hq/modules/${encodeURIComponent(moduleId)}`;
		json(
			`${prefix}/module.json`,
			{ content: without(module, ["forms"]), forms: ids },
			{ content: without(normalModule, ["forms"]), forms: ids },
		);
		for (let f = 0; f < forms.length; f++) {
			const id = ids[f],
				xmlns = identity(forms[f], "xmlns");
			if (formIds.has(id) || formNamespaces.has(xmlns))
				throw new Error("Cannot census duplicate HQ form identities.");
			formIds.add(id);
			formNamespaces.set(xmlns, id);
			json(
				`${prefix}/forms/${encodeURIComponent(id)}/form.json`,
				forms[f],
				normalForms[f],
			);
			const attachment = attachments[`${id}.xml`];
			if (
				typeof attachment !== "string" ||
				primaryNamespace(attachment) !== xmlns
			)
				throw new Error(
					"Cannot census an HQ form without its matching XForm attachment.",
				);
		}
	}
	for (const [name, attachment] of Object.entries(attachments)) {
		const id = name.slice(0, -4);
		if (
			!name.endsWith(".xml") ||
			!formIds.has(id) ||
			typeof attachment !== "string"
		)
			throw new Error("Cannot census an unowned HQ attachment.");
		add(
			`hq/xforms/${encodeURIComponent(id)}.xml`,
			attachment,
			string(normalAttachments[name], "normalized XForm"),
		);
	}
	json(
		"hq/app.json",
		{
			content: without(raw, ["modules", "_attachments"]),
			modules: moduleIds,
			attachments: Object.keys(attachments).sort(),
		},
		{
			content: without(normalized, ["modules", "_attachments"]),
			modules: moduleIds,
			attachments: Object.keys(attachments).sort(),
		},
	);
	const files =
		localFiles instanceof Map ? [...localFiles] : Object.entries(localFiles);
	const localNamespaces = new Set<string>();
	let suiteSeen = false;
	for (const [name, contents] of files) {
		if (name === "suite.xml") {
			suiteSeen = true;
			const normalizedSuite = normalizeSuite(contents);
			add(
				"local/suite.xml",
				suiteBytesWithoutFixtures(contents),
				normalizedSuite,
			);
		} else if (/^modules-\d+\/forms-\d+\.xml$/.test(name)) {
			const xmlns = primaryNamespace(contents);
			if (!formNamespaces.has(xmlns) || localNamespaces.has(xmlns))
				throw new Error("Cannot census an unowned or duplicate local XForm.");
			localNamespaces.add(xmlns);
			// The path remains observable even though the fragment key is identity.
			add(
				`local/xforms/${encodeURIComponent(xmlns)}.xml`,
				`${JSON.stringify(name)}\n${contents}`,
				`${JSON.stringify(name)}\n${normalizeXForm(contents)}`,
			);
		} else if (name.endsWith(".xml") && name !== "media_suite.xml") {
			throw new Error("Cannot census an unrecognized archive XML resource.");
		}
	}
	if (!suiteSeen || localNamespaces.size !== formNamespaces.size)
		throw new Error("Cannot census an incomplete local archive.");
	return fragments.sort((a, b) => compare(a.file, b.file));
}
