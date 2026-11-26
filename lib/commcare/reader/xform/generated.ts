/**
 * The nodes Nova adds to a form's source, recognized by rebuilding them. Each
 * generated node is proposed for an owner by its name, which must be the
 * allocator's base for that owner or the base with a suffix
 * (`xform/generatedNodes.ts::generatedBaseName`); the proposal is then held
 * to the tree the production emitter builds for that owner's path, compared
 * with the source's attribute through `syntaxCompare.ts::sameXPathText`. A
 * node a person changed in CommCare HQ's form builder fails the comparison
 * and is read as their own Hidden Value; a node the allocator would not have
 * named so is read the same way.
 *
 * The case region (the scaffolding of Save to Case blocks, condition groups,
 * keyed repeats, guards and clock nodes) is recognized here by its shape and
 * left to the case management stage, which reads every block of it.
 */

import { type Element, isTag } from "domhandler";
import { recordFromEntries } from "@/lib/domain/records";
import type { WireElementContext } from "../../elementBuilders";
import {
	buildOwnerNodes,
	constraintCountRelevant,
	countPlacementTrees,
	queryIdsValue,
} from "../../xform/builder";
import { captureUrlCalculate } from "../../xform/captureUrlNode";
import { caseScalarTextValueCalculation } from "../../xform/caseOps";
import { countPlacementRowPieces } from "../../xform/countPlacementRow";
import { FormPath } from "../../xform/formPath";
import {
	type GeneratedNodePurpose,
	generatedBaseName,
} from "../../xform/generatedNodes";
import {
	JAVAROSA_NS,
	type NamespaceScope,
	scopeOf,
	splitName,
	VELLUM_NS,
} from "../../xmlNamespaces";
import type { FormSyntax } from "../../xpath/formSyntax";
import { w } from "../../xpath/wire/builders";
import { InstanceSink } from "../../xpath/wire/instances";
import {
	storedInstantValue,
	typedInstantValue,
} from "../../xpath/wire/instant";
import { serializeWire } from "../../xpath/wire/serialize";
import type { WireExpr } from "../../xpath/wire/tree";
import {
	type Claim,
	type ClaimUse,
	defineClaims,
	derived,
	drop,
	take,
} from "../claims";
import { sameSyntax, sameXPathText } from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";
import type { ReaderInput } from "../types";
import type { XmlCursor } from "../xmlCursor";
import type { ControlNode } from "./body";
import type { DraftField, NodeRole } from "./index";
import {
	type BindFacts,
	type DataNode,
	formPathOf,
	type SetvalueFacts,
} from "./model";

// ── Claims ───────────────────────────────────────────────────────────────

function named<U extends ClaimUse>(
	make: (entry: string, key: string | null) => Claim<U>,
	use: U,
	entry: string,
	key: string,
): Claim<U> {
	const claim = make(entry, key);
	defineClaims(
		"xform",
		recordFromEntries([
			[`${entry.slice(entry.indexOf("/") + 1)}@${use}@${key}`, claim],
		]),
	);
	return claim;
}

const Q = (id: string) => `questions/${id}`;

/**
 * What a generated node's parts are claimed under. Nova writes every such
 * node as a Hidden Value, so each part is claimed under the entry that holds
 * that part of a Hidden Value, `derived`: the document holds it through the
 * owner's own slot.
 */
export const G = {
	node: named(
		derived,
		"derived",
		Q("hidden-value-data-node-bind-no-control-with-calculate-or-default"),
		"mug:DataBindOnly",
	),
	typeInt: named(
		derived,
		"derived",
		Q("integer-xsd-int-xsd-integer-read-as-the-same"),
		"xform:model/bind@type",
	),
	typeString: named(
		derived,
		"derived",
		Q("text-input-xsd-string"),
		"xform:model/bind@type",
	),
	calculate: named(
		derived,
		"derived",
		Q("bind-calculate-on-a-hidden-value"),
		"xform:model/bind@calculate",
	),
	relevant: named(
		derived,
		"derived",
		Q("bind-relevant"),
		"xform:model/bind@relevant",
	),
	readonly: named(
		derived,
		"derived",
		Q("protected-constraint-message-carrier-readonly"),
		"xform:model/bind@readonly",
	),
	carrierControl: named(
		derived,
		"derived",
		Q("text-input-xsd-string"),
		"xform:input",
	),
	carrierRef: named(
		derived,
		"derived",
		Q("text-input-xsd-string"),
		"xform:input@ref",
	),
	setvalue: named(
		derived,
		"derived",
		Q("setvalue-event-jr-insert-default-inside-a-repeat-not-reading"),
		"xform:setvalue",
	),
	setvalueEvent: named(
		derived,
		"derived",
		Q("setvalue-event-jr-insert-default-inside-a-repeat-not-reading"),
		"xform:setvalue@event",
	),
	setvalueRef: named(
		derived,
		"derived",
		Q("setvalue-event-jr-insert-default-inside-a-repeat-not-reading"),
		"xform:setvalue@ref",
	),
	setvalueValue: named(
		derived,
		"derived",
		Q("setvalue-event-jr-insert-default-inside-a-repeat-not-reading"),
		"xform:setvalue@value",
	),
	/** A protected validation message's expression on its question's bind, its text's forms
	 *  and the form that names the text's own id, which the text reader claims once it has read
	 *  the message's text. */
	messageExpression: named(
		derived,
		"derived",
		Q("protected-constraint-message-expression"),
		"xform:model/bind@jr:constraintMsg",
	),
	messageForms: named(
		derived,
		"derived",
		Q("protected-constraint-message-forms"),
		"xform:model/itext/translation/text/value@form",
	),
	messageIdentity: named(
		drop,
		"drop",
		Q("protected-constraint-message-identity"),
		"xform:model/itext/translation/text/value@form",
	),
	/** A count repeat's `jr:count` naming its generated count node. */
	countFromNode: named(
		take,
		"take",
		Q("jr-count-naming-a-hidden-value-whose-calculate-is-an-integer-in"),
		"xform:repeat@jr:count",
	),
	/** The count placement's wrapper node, which is the query repeat's field. */
	queryWrapper: named(
		take,
		"take",
		Q("count-repeat-whose-count-and-row-ids-come-from-one-query-a"),
		"mug:Repeat",
	),
	/** The count placement's `<group ref="…/r">`, which no runtime draws. */
	queryWrapperGroup: named(
		derived,
		"derived",
		Q("group-ref-x-wrapping-the-repeat-raw-attribute"),
		"xform:group",
	),
	queryWrapperGroupRef: named(
		derived,
		"derived",
		Q("group-ref-x-wrapping-the-repeat-raw-attribute"),
		"xform:group@ref",
	),
} as const;

/** The entry a question's date-and-time sibling is read under (`datetime`). */
export const DATETIME_SIBLING_ENTRY =
	"forms-and-case-writes/update-from-a-date-and-time-question-through-a-hidden-sibling";

// ── The rules ────────────────────────────────────────────────────────────

export interface GeneratedRule {
	readonly purpose: GeneratedNodePurpose;
	/** `forms`: settled here. `case-management`: proposed here, settled by the case management
	 *  stage, which reads the case action that names the node. */
	readonly settledBy: "forms" | "case-management";
}

const rule = (
	purpose: GeneratedNodePurpose,
	settledBy: GeneratedRule["settledBy"],
): GeneratedRule => ({ purpose, settledBy });

/** Total over the union, so a purpose the emitter gains fails `tsc` here. */
export const GENERATED_RULES: Readonly<
	Record<GeneratedNodePurpose, GeneratedRule>
> = {
	"constraint-count": rule("constraint-count", "forms"),
	"constraint-message": rule("constraint-message", "forms"),
	count: rule("count", "forms"),
	"query-ids": rule("query-ids", "forms"),
	"query-count": rule("query-count", "forms"),
	"query-position": rule("query-position", "forms"),
	"query-id": rule("query-id", "forms"),
	"query-index": rule("query-index", "forms"),
	url: rule("url", "case-management"),
	datetime: rule("datetime", "case-management"),
	trimmed: rule("trimmed", "case-management"),
	owner: rule("owner", "case-management"),
	instant: rule("instant", "case-management"),
	keyed: rule("keyed", "case-management"),
	"keyed-count": rule("keyed-count", "case-management"),
	condition: rule("condition", "case-management"),
	guard: rule("guard", "case-management"),
};

// ── Comparing trees ──────────────────────────────────────────────────────

/** Whether an attribute's text is the tree the emitter writes, printed as the emitter prints
 *  that attribute: in a form's runtime spelling, as a validation condition where `constraint`. */
export function sameTree(
	sourceText: string,
	expected: WireExpr,
	constraint = false,
): boolean {
	const print = serializeWire(expected, { target: "xform", constraint }).text;
	return sameXPathText(sourceText, print, { ruleSet: "form" });
}

/** A throwaway context for a production function that builds elements, whose attributes the
 *  reader reads back as text. */
function printingContext(): WireElementContext {
	return {
		mode: { target: "xform", constraint: false },
		instances: new InstanceSink(),
	};
}

/** Whether a name is `base`, or `base` followed by `_` and a whole number from 1 with no
 *  leading zero, the suffix the allocator's `Namespace.peek` gives. */
export function isAllocatedName(name: string, base: string): boolean {
	if (name === base) return true;
	if (!name.startsWith(`${base}_`)) return false;
	const suffix = name.slice(base.length + 1);
	if (suffix.length === 0 || suffix[0] === "0") return false;
	for (const character of suffix)
		if (character < "0" || character > "9") return false;
	return true;
}

/** A constraint count's ordinal: a whole number from 0 with no leading zero. */
function isOrdinal(text: string): boolean {
	if (text.length === 0 || (text.length > 1 && text[0] === "0")) return false;
	for (const character of text)
		if (character < "0" || character > "9") return false;
	return true;
}

/** A node's absolute data path, the data root's name first. */
export function absolutePath(node: DataNode, root: string): string {
	return `/${[root, ...node.path].join("/")}`;
}

/** An attribute written with no prefix. */
function plain(element: Element, name: string): string | undefined {
	return Object.hasOwn(element.attribs, name)
		? element.attribs[name]
		: undefined;
}

/** An element's namespace scope, folded from the document's root down. */
function scopeAt(element: Element): NamespaceScope {
	const chain: Element[] = [];
	for (
		let at: Element | null = element;
		at !== null;
		at = at.parent !== null && isTag(at.parent) ? (at.parent as Element) : null
	)
		chain.unshift(at);
	let scope: NamespaceScope = new Map();
	for (const at of chain) scope = scopeOf(at, scope);
	return scope;
}

/** The name an attribute in `uri` named `local` is written under on `element`. */
function attributeNamed(
	element: Element,
	uri: string,
	local: string,
): string | undefined {
	const scope = scopeAt(element);
	for (const name of Object.keys(element.attribs)) {
		const split = splitName(name);
		if (
			split.prefix !== "" &&
			split.prefix !== "xmlns" &&
			split.local === local &&
			scope.get(split.prefix) === uri
		)
			return name;
	}
	return undefined;
}

/**
 * The data path a location path names, the data root left out: an absolute path from the data
 * root `root`, or a relative one from `base` (`.` is `base`, `..` its parent). Undefined where
 * the text is no chain of name steps, or leaves the data root.
 */
function namedPath(
	syntax: FormSyntax,
	base: readonly string[],
	root: string,
): readonly string[] | undefined {
	const steps: string[] = [];
	const walk = (node: FormSyntax): boolean => {
		switch (node.kind) {
			case "group":
				return walk(node.value);
			case "child":
				if (node.descendant) return false;
				if (node.left === undefined) steps.push("/");
				else if (!walk(node.left)) return false;
				return walk(node.step);
			case "name":
				if (node.wildcard) return false;
				steps.push(node.name);
				return true;
			case "axis":
				if (node.axis !== "child") return false;
				return walk(node.value);
			case "self":
				steps.push(".");
				return true;
			case "parent":
				steps.push("..");
				return true;
			default:
				return false;
		}
	};
	if (!walk(syntax)) return undefined;
	let at: string[] = [...base];
	let rest = steps;
	if (steps[0] === "/") {
		if (steps[1] !== root) return undefined;
		at = [];
		rest = steps.slice(2);
	}
	for (const step of rest) {
		if (step === ".") continue;
		if (step === "..") {
			if (at.length === 0) return undefined;
			at.pop();
			continue;
		}
		at.push(step);
	}
	return at;
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((step, index) => step === b[index]);
}

/** The data root's name, from any node of the tree under it. */
export function dataRootName(node: DataNode): string {
	let top = node;
	while (top.parent !== null) top = top.parent;
	const parent = top.element.parent;
	return parent !== null && isTag(parent) ? (parent as Element).name : "data";
}

/** Every location path in a tree, outermost first, a predicate's paths among them. */
function pathsIn(node: FormSyntax, found: FormSyntax[] = []): FormSyntax[] {
	switch (node.kind) {
		case "child":
		case "name":
		case "self":
		case "parent":
			found.push(node);
			if (node.kind === "child") {
				if (node.left !== undefined) pathsIn(node.left, found);
				pathsIn(node.step, found);
			}
			return found;
		case "group":
		case "negative":
			return pathsIn(node.value, found);
		case "axis":
			return pathsIn(node.value, found);
		case "filter":
			pathsIn(node.base, found);
			return pathsIn(node.where, found);
		case "binary":
			pathsIn(node.left, found);
			return pathsIn(node.right, found);
		case "call":
			for (const arg of node.args) pathsIn(arg, found);
			return found;
		default:
			return found;
	}
}

/** Whether `text` reads the node at `target` by some path, read from `base`. */
function readsPath(
	text: string,
	base: readonly string[],
	target: readonly string[],
	root: string,
): boolean {
	const read = readFormSyntax(text);
	if (!read.ok || read.node === undefined) return false;
	return pathsIn(read.node).some((path) => {
		const named = namedPath(path, base, root);
		return named !== undefined && samePath(named, target);
	});
}

/** Whether a tree holds a predicate anywhere in its path spine. */
function holdsFilter(node: FormSyntax): boolean {
	switch (node.kind) {
		case "filter":
			return true;
		case "group":
			return holdsFilter(node.value);
		case "child":
			return (
				(node.left !== undefined && holdsFilter(node.left)) ||
				holdsFilter(node.step)
			);
		default:
			return false;
	}
}

/** The source tree with the hole's subtree taken out: where `template`, built over the hole
 *  name `hole`, holds the hole, `source` may hold any subtree, the same one at every hole. */
export function matchesTemplate(
	source: string,
	template: WireExpr,
	hole: string,
): FormSyntax | undefined {
	return matchesHoles(source, template, (name) => name === hole)?.get(hole);
}

/** The source's subtree at each hole: where `template` holds a name `isHole` answers for,
 *  `source` may hold any subtree, the same one wherever that name stands; everywhere else
 *  the two trees are one. Undefined where they differ. */
export function matchesHoles(
	source: string,
	template: WireExpr,
	isHole: (name: string) => boolean,
): ReadonlyMap<string, FormSyntax> | undefined {
	const left = readFormSyntax(source);
	if (!left.ok || left.node === undefined) return undefined;
	return matchesHolesIn(left.node, template, isHole);
}

/** `matchesTemplate` over a tree already read: for a walk that asks of each node of one text,
 *  which reads the text once rather than once a node. The hole's subtree is the tree's own, so
 *  its span is in the text the tree was read from. */
export function matchesTemplateIn(
	source: FormSyntax,
	template: WireExpr,
	hole: string,
): FormSyntax | undefined {
	return matchesHolesIn(source, template, (name) => name === hole)?.get(hole);
}

/** Each template's tree as the grammar reads its print, by the template: a walk that matches
 *  every node of a text against one template prints and reads it once. */
const templateSyntaxes = new WeakMap<WireExpr, FormSyntax | null>();

function templateSyntax(template: WireExpr): FormSyntax | undefined {
	const known = templateSyntaxes.get(template);
	if (known !== undefined) return known ?? undefined;
	const read = readFormSyntax(
		serializeWire(template, { target: "xform", constraint: false }).text,
	);
	const tree = read.ok && read.node !== undefined ? read.node : null;
	templateSyntaxes.set(template, tree);
	return tree ?? undefined;
}

/** `matchesHoles` over a source tree already read. */
function matchesHolesIn(
	source: FormSyntax,
	template: WireExpr,
	isHole: (name: string) => boolean,
): ReadonlyMap<string, FormSyntax> | undefined {
	const right = templateSyntax(template);
	if (right === undefined) return undefined;
	const bound = new Map<string, FormSyntax>();
	const strip = (node: FormSyntax): FormSyntax =>
		node.kind === "group" ? strip(node.value) : node;
	const match = (s: FormSyntax, t: FormSyntax): boolean => {
		const a = strip(s);
		const b = strip(t);
		if (b.kind === "name" && isHole(b.name)) {
			const earlier = bound.get(b.name);
			if (earlier === undefined) {
				bound.set(b.name, a);
				return true;
			}
			return sameSyntax(earlier, a, { ruleSet: "form" });
		}
		if (!holdsHole(b, isHole)) return sameSyntax(a, b, { ruleSet: "form" });
		if (a.kind !== b.kind) return false;
		switch (b.kind) {
			case "binary":
				return (
					a.kind === "binary" &&
					a.op === b.op &&
					match(a.left, b.left) &&
					match(a.right, b.right)
				);
			case "call":
				return (
					a.kind === "call" &&
					a.name === b.name &&
					a.args.length === b.args.length &&
					a.args.every((arg, index) => match(arg, b.args[index] as FormSyntax))
				);
			case "negative":
				return a.kind === "negative" && match(a.value, b.value);
			case "filter":
				return (
					a.kind === "filter" &&
					match(a.base, b.base) &&
					match(a.where, b.where)
				);
			case "child":
				return (
					a.kind === "child" &&
					a.descendant === b.descendant &&
					(a.left === undefined) === (b.left === undefined) &&
					(a.left === undefined || match(a.left, b.left as FormSyntax)) &&
					match(a.step, b.step)
				);
			default:
				return false;
		}
	};
	return match(source, right) ? bound : undefined;
}

function holdsHole(
	node: FormSyntax,
	isHole: (name: string) => boolean,
): boolean {
	switch (node.kind) {
		case "name":
			return isHole(node.name);
		case "group":
		case "negative":
		case "axis":
			return holdsHole(node.value, isHole);
		case "child":
			return (
				(node.left !== undefined && holdsHole(node.left, isHole)) ||
				holdsHole(node.step, isHole)
			);
		case "filter":
			return holdsHole(node.base, isHole) || holdsHole(node.where, isHole);
		case "binary":
			return holdsHole(node.left, isHole) || holdsHole(node.right, isHole);
		case "call":
			return node.args.some((arg) => holdsHole(arg, isHole));
		default:
			return false;
	}
}

/** The name a template's hole is spelled with: no form names a node so. */
export const HOLE = "nova_reader_hole";

// ── A bind's shape ───────────────────────────────────────────────────────

/** The attributes a generated node's bind may carry, shadows aside: its path, the `nodeset` Core
 *  reads a bind's node from, the ones listed and nothing else. */
const BIND_PATH = new Set(["nodeset"]);

function bindHoldsOnly(
	bind: BindFacts,
	allowed: readonly ("type" | "calculate" | "relevant" | "readonly")[],
	options: { readonly calculateShadow?: false } = {},
): boolean {
	const scope = scopeAt(bind.element);
	for (const name of Object.keys(bind.element.attribs)) {
		const split = splitName(name);
		if (split.prefix === "xmlns" || name === "xmlns") continue;
		if (split.prefix !== "" && scope.get(split.prefix) === VELLUM_NS) {
			// Shadows are the shadow reader's; a validation count carries no calculate shadow,
			// which would make HQ's form builder print its filtered path back unparseable.
			if (split.local === "calculate" && options.calculateShadow === false)
				return false;
			continue;
		}
		if (split.prefix === "" && BIND_PATH.has(name)) continue;
		if (!(allowed as readonly string[]).includes(name)) return false;
	}
	return allowed.every(
		(name) => name === "type" || Object.hasOwn(bind.element.attribs, name),
	);
}

/** `count(q) > 0`, the relevance every question's sibling carries. */
function presentWhileOwner(bind: BindFacts, owner: FormPath): boolean {
	const relevant = bind.logic.relevant;
	return (
		relevant !== undefined && sameTree(relevant, constraintCountRelevant(owner))
	);
}

// ── Recognizing a node with no control ──────────────────────────────────

type GeneratedRole = Extract<
	NodeRole,
	{ kind: "generated" | "generated-candidate" }
>;

/** What a recognition read of a node beyond its role: the datetime sibling's spelling, which
 *  says whether its fold also changes what a publish writes. */
export type DatetimeSpelling =
	/** CommCare HQ's stored text of a typed date and time (`storedInstantValue`). */
	| "stored"
	/** The question's own value, a copy of stored text. */
	| "copy"
	/** The device's clock with its offset (`typedInstantValue`), which an app Nova published
	 *  before it stored CommCare HQ's spelling holds. */
	| "earlier";

/** The spelling a datetime candidate's calculate holds, for the owner at `owner`. */
export function datetimeSpelling(
	calculate: string,
	owner: FormPath,
): DatetimeSpelling | undefined {
	const read = owner.toWire();
	if (sameTree(calculate, storedInstantValue(read))) return "stored";
	if (sameTree(calculate, read)) return "copy";
	if (sameTree(calculate, typedInstantValue(read))) return "earlier";
	return undefined;
}

/**
 * The spelling a datetime candidate's calculate holds for `owner`, where the emitter writes it
 * for that question (`datetimeCaseValue.ts::questionDatetimeCaseValue`): a date-and-time
 * question is a typed leaf, never a copy, and a Hidden Value is a typed leaf or, where it holds
 * text, a copy of itself.
 */
export function datetimeSpellingOf(
	calculate: string,
	owner: DraftField,
	ownerPath: FormPath,
): DatetimeSpelling | undefined {
	if (owner.kind !== "datetime" && owner.kind !== "hidden") return undefined;
	const spelling = datetimeSpelling(calculate, ownerPath);
	return spelling === "copy" && owner.kind !== "hidden" ? undefined : spelling;
}

/** The owner value an owner node's calculate holds. */
function ownerValueOf(
	calculate: string,
	rootName: string,
): "acting-user" | "unowned" | undefined {
	for (const value of ["acting-user", "unowned"] as const) {
		const built = buildOwnerNodes(
			[
				{
					purpose: "owner",
					operationUuid: "reader" as never,
					scope: FormPath.root(rootName),
					name: "nova_owner_reader",
					value,
				},
			],
			printingContext(),
		);
		const bind = built.binds[0];
		const expected = bind === undefined ? undefined : plain(bind, "calculate");
		if (
			expected !== undefined &&
			sameXPathText(calculate, expected, { ruleSet: "form" })
		)
			return value;
	}
	return undefined;
}

/**
 * The role of a node with no control that is one of Nova's, proposed against `owners`, the
 * fields the join has found; undefined where no rule's tree matches, and the node is then a
 * Hidden Value. `target` is `ReaderInput.target`, which the `url` rule's tree names.
 */
export function recognizeGenerated(
	node: DataNode,
	binds: ReadonlyMap<DataNode, BindFacts>,
	owners: readonly DraftField[],
	target: ReaderInput["target"],
): GeneratedRole | undefined {
	const bind = binds.get(node);
	const root = dataRootName(node);
	if (bind === undefined || node.children.length > 0) return undefined;
	const calculate = bind.logic.calculate;
	const siblings = owners.filter(
		(owner) => owner.node !== node && owner.node.parent === node.parent,
	);
	for (const owner of siblings) {
		const ownerPath = formPathOf(owner.node);
		if (ownerPath === undefined) continue;
		const name = node.name;
		// constraint-count: `nova_constraint_<q>_<n>`, any n from 1.
		const countStem = `nova_constraint_${owner.id}_`;
		if (name.startsWith(countStem)) {
			const [n] = name.slice(countStem.length).split("_");
			if (
				n !== undefined &&
				isOrdinal(n) &&
				isAllocatedName(
					name,
					generatedBaseName("constraint-count", owner.id, n),
				) &&
				recognizesConstraintCount(node, bind, owner, ownerPath, binds, root)
			)
				return {
					kind: "generated",
					purpose: "constraint-count",
					owner: owner.node,
				};
		}
		if (
			owner.kind === "repeat" &&
			isAllocatedName(name, generatedBaseName("count", owner.id)) &&
			bind.type === "xsd:int" &&
			calculate !== undefined &&
			bindHoldsOnly(bind, ["type", "calculate"]) &&
			countNames(owner, node, root)
		)
			return { kind: "generated", purpose: "count", owner: owner.node };
		if (
			isAllocatedName(name, generatedBaseName("url", owner.id)) &&
			bind.type === "xsd:string" &&
			calculate !== undefined &&
			bindHoldsOnly(bind, ["type", "calculate", "relevant"]) &&
			presentWhileOwner(bind, ownerPath) &&
			sameTree(calculate, captureUrlCalculate(ownerPath, target))
		)
			return {
				kind: "generated-candidate",
				purpose: "url",
				owner: owner.node,
			};
		if (
			isAllocatedName(name, generatedBaseName("datetime", owner.id)) &&
			bind.type === "xsd:string" &&
			calculate !== undefined &&
			bindHoldsOnly(bind, ["type", "calculate", "relevant"]) &&
			presentWhileOwner(bind, ownerPath) &&
			datetimeSpellingOf(calculate, owner, ownerPath) !== undefined
		)
			return {
				kind: "generated-candidate",
				purpose: "datetime",
				owner: owner.node,
			};
		if (
			isAllocatedName(name, generatedBaseName("trimmed", owner.id)) &&
			bind.type === undefined &&
			calculate !== undefined &&
			bindHoldsOnly(bind, ["calculate", "relevant"]) &&
			presentWhileOwner(bind, ownerPath) &&
			trimmedValueRead(calculate, owner, ownerPath)
		)
			return {
				kind: "generated-candidate",
				purpose: "trimmed",
				owner: owner.node,
			};
	}
	if (
		node.name.startsWith("nova_owner_") &&
		calculate !== undefined &&
		bind.type === undefined &&
		bindHoldsOnly(bind, ["calculate"]) &&
		endsScope(node)
	) {
		const ownerValue = ownerValueOf(calculate, node.rootName);
		if (ownerValue !== undefined)
			return {
				kind: "generated-candidate",
				purpose: "owner",
				owner: null,
				ownerValue,
			};
	}
	return undefined;
}

/** Whether a node stands in the run of owner nodes that ends its scope: the emitter appends
 *  each after every authored and generated child there (`builder.ts::buildOwnerNodes`), so
 *  every sibling after it is an owner node too. */
function endsScope(node: DataNode): boolean {
	const parent = node.element.parent;
	if (parent === null || !isTag(parent)) return false;
	const siblings = (parent as Element).children.filter(isTag) as Element[];
	const at = siblings.indexOf(node.element);
	return (
		at >= 0 &&
		siblings
			.slice(at + 1)
			.every((sibling) => sibling.name.startsWith("nova_owner_"))
	);
}

/** The trimmed value reads its question, or the question's datetime sibling. */
function trimmedValueRead(
	calculate: string,
	owner: DraftField,
	ownerPath: FormPath,
): boolean {
	if (sameTree(calculate, caseScalarTextValueCalculation(ownerPath.toWire())))
		return true;
	const parent = owner.node.parent;
	const siblings =
		parent === null
			? siblingsAtRoot(owner.node)
			: parent.children.map((child) => child.name);
	const datetimeBase = generatedBaseName("datetime", owner.id);
	return siblings
		.filter((name) => isAllocatedName(name, datetimeBase))
		.some((name) =>
			sameTree(
				calculate,
				caseScalarTextValueCalculation(ownerPath.parent().child(name).toWire()),
			),
		);
}

function siblingsAtRoot(node: DataNode): string[] {
	const parent = node.element.parent;
	if (parent === null || !isTag(parent)) return [];
	return (parent as Element).children
		.filter(isTag)
		.map((child) => (child as Element).name);
}

/** A constraint count's bind and calculate, and the owner's constraint reading it. */
function recognizesConstraintCount(
	node: DataNode,
	bind: BindFacts,
	owner: DraftField,
	ownerPath: FormPath,
	binds: ReadonlyMap<DataNode, BindFacts>,
	root: string,
): boolean {
	if (bind.type !== "xsd:int") return false;
	if (
		!bindHoldsOnly(bind, ["type", "relevant", "calculate"], {
			calculateShadow: false,
		})
	)
		return false;
	if (!presentWhileOwner(bind, ownerPath)) return false;
	const calculate = bind.logic.calculate;
	if (calculate === undefined) return false;
	const read = readFormSyntax(calculate);
	let call = read.ok ? read.node : undefined;
	while (call?.kind === "group") call = call.value;
	if (
		call?.kind !== "call" ||
		call.name !== "count" ||
		call.args.length !== 1 ||
		!holdsFilter(call.args[0] as FormSyntax)
	)
		return false;
	const constraint = binds.get(owner.node)?.logic.constraint;
	return (
		constraint !== undefined &&
		readsPath(constraint, owner.node.path, node.path, root)
	);
}

/** Whether a count repeat's `jr:count` names `node`, read from the repeat's parent. */
function countNames(repeat: DraftField, node: DataNode, root: string): boolean {
	const control = repeat.control;
	if (control === undefined) return false;
	const element =
		control.tag === "repeat"
			? control.element
			: (control.children.find((child) => child.tag === "repeat")?.element ??
				control.element);
	const attribute = attributeNamed(element, JAVAROSA_NS, "count");
	const text = attribute === undefined ? undefined : element.attribs[attribute];
	if (text === undefined) return false;
	const read = readFormSyntax(text);
	if (!read.ok || read.node === undefined) return false;
	const named = namedPath(read.node, repeat.node.path.slice(0, -1), root);
	return named !== undefined && samePath(named, node.path);
}

// ── The protected validation message's carrier ──────────────────────────

/**
 * Whether an `input` control and its node are the carrier of a protected validation message
 * of the question just before it: a sibling of that question, named for it, bound
 * `xsd:string` with `relevant="false()"` and `readonly="true()"`, whose control holds one
 * `label` and directly follows the question's control, and whose question's bind carries
 * `jr:constraintMsg`. The message's own expression and text forms are compared once the
 * text is read.
 */
export function recognizeConstraintMessage(
	control: ControlNode,
	binds: ReadonlyMap<DataNode, BindFacts>,
	previous: ControlNode | undefined,
): GeneratedRole | undefined {
	const node = control.node;
	const owner = previous?.node;
	if (
		control.tag !== "input" ||
		node === undefined ||
		owner === undefined ||
		owner.parent !== node.parent ||
		node.children.length > 0 ||
		!isAllocatedName(
			node.name,
			generatedBaseName("constraint-message", owner.name),
		)
	)
		return undefined;
	const bind = binds.get(node);
	const ownerBind = binds.get(owner);
	if (
		bind === undefined ||
		ownerBind?.logic.constraintMsg === undefined ||
		bind.type !== "xsd:string" ||
		bind.logic.relevant === undefined ||
		bind.logic.readonly === undefined ||
		!bindHoldsOnly(bind, ["type", "relevant", "readonly"]) ||
		!sameTree(bind.logic.relevant, w.call("false")) ||
		!sameTree(bind.logic.readonly, w.call("true"))
	)
		return undefined;
	const children = control.element.children.filter(isTag) as Element[];
	if (
		children.length !== 1 ||
		splitName((children[0] as Element).name).local !== "label" ||
		control.children.length > 0 ||
		control.appearance !== undefined
	)
		return undefined;
	const ref = plain(children[0] as Element, "ref");
	const read = ref === undefined ? undefined : readFormSyntax(ref);
	const call = read?.ok === true ? read.node : undefined;
	if (
		call?.kind !== "call" ||
		call.name !== "jr:itext" ||
		call.args.length !== 1 ||
		call.args[0]?.kind !== "string"
	)
		return undefined;
	return { kind: "generated", purpose: "constraint-message", owner };
}

/** The text id a carrier's label references. */
export function carrierTextId(control: ControlNode): string | undefined {
	const label = control.element.children.filter(isTag)[0] as
		| Element
		| undefined;
	const ref = label === undefined ? undefined : plain(label, "ref");
	const read = ref === undefined ? undefined : readFormSyntax(ref);
	const call = read?.ok === true ? read.node : undefined;
	return call?.kind === "call" && call.args[0]?.kind === "string"
		? call.args[0].value
		: undefined;
}

// ── A query repeat's count placement ────────────────────────────────────

/** The count placement's parts a query repeat's wrapper and row hold, each recognized by the
 *  production emitter's trees. */
export interface QueryPlacementParts {
	readonly ids: DataNode;
	readonly count: DataNode;
	readonly position: DataNode | undefined;
	readonly id: DataNode;
	readonly index: DataNode;
	/** The query: the second argument of the ids node's `join(' ', …)`, as its source text. */
	readonly query: { readonly text: string; readonly at: Element };
	/** The row's `jr-insert` setvalues of its id and index. */
	readonly setvalues: readonly SetvalueFacts[];
	/** The row bind's condition, the left operand of the guard's `and`; undefined where the
	 *  row's `relevant` is the guard alone. */
	readonly condition: string | undefined;
}

/** One child of `parent` whose name is the allocator's for `purpose` and the repeat `id`. */
function childNamed(
	parent: DataNode,
	purpose: GeneratedNodePurpose,
	id: string,
): DataNode | undefined {
	const base = generatedBaseName(purpose, id);
	return parent.children.find((child) => isAllocatedName(child.name, base));
}

/**
 * Reads a query repeat's count placement around the wrapper `wrapper` and its row `row`:
 * `nova_query_ids_r` holding `join(' ', P)`, `nova_query_count_r` holding
 * `count-selected(../<ids>)`, `nova_query_position_r` where it is written, and the row's
 * `nova_query_id_r` and `nova_query_index_r` with the binds and `jr-insert` setvalues
 * `countPlacementRow.ts::countPlacementRowPieces` writes, and the row's guard
 * `position() < ../<count>` on its own or as the last operand of an `and`. Undefined where a
 * part is missing or differs, or the wrapper holds any other node.
 */
export function readQueryPlacement(
	wrapper: DataNode,
	row: DataNode,
	binds: ReadonlyMap<DataNode, BindFacts>,
	setvalues: readonly SetvalueFacts[],
): QueryPlacementParts | undefined {
	const id = wrapper.name;
	const wrapperPath = formPathOf(wrapper);
	if (wrapperPath === undefined || row.name !== "item" || !row.template)
		return undefined;
	const ids = childNamed(wrapper, "query-ids", id);
	const count = childNamed(wrapper, "query-count", id);
	const position = childNamed(wrapper, "query-position", id);
	const rowId = childNamed(row, "query-id", id);
	const rowIndex = childNamed(row, "query-index", id);
	if (
		ids === undefined ||
		count === undefined ||
		rowId === undefined ||
		rowIndex === undefined
	)
		return undefined;
	// The emitter writes nothing else in the wrapper: a node beside these is no row's, and the
	// wrapper holding it is no count placement but the group HQ's form builder shows.
	const parts = new Set([ids, count, position, row]);
	if (wrapper.children.some((child) => !parts.has(child))) return undefined;
	// Nor does it bind the wrapper: a condition there, which HQ's form builder can give the
	// unlabelled group it shows, leaves the generated ids and count out of the submission with
	// the rows, which a query repeat's condition (written on its rows) does not; the wrapper is
	// then that group, its condition its own.
	const wrapperBind = binds.get(wrapper);
	if (wrapperBind !== undefined && !bindHoldsOnly(wrapperBind, []))
		return undefined;
	const idsBind = binds.get(ids);
	const countBind = binds.get(count);
	const trees = countPlacementTrees({ ids: ids.name, count: count.name });
	if (
		idsBind?.logic.calculate === undefined ||
		idsBind.type !== undefined ||
		!bindHoldsOnly(idsBind, ["calculate"]) ||
		countBind?.logic.calculate === undefined ||
		countBind.type !== "xsd:int" ||
		!bindHoldsOnly(countBind, ["type", "calculate"]) ||
		!sameTree(countBind.logic.calculate, trees.count)
	)
		return undefined;
	const query = joinedQuery(idsBind.logic.calculate);
	if (query === undefined) return undefined;
	if (position !== undefined) {
		const positionBind = binds.get(position);
		if (
			positionBind?.logic.calculate === undefined ||
			positionBind.type !== undefined ||
			!bindHoldsOnly(positionBind, ["calculate"]) ||
			!sameTree(positionBind.logic.calculate, trees.position)
		)
			return undefined;
	}
	const rowPath = wrapperPath.queryBoundIteration();
	const pieces = countPlacementRowPieces(
		rowPath,
		{ ids: ids.name, count: count.name, id: rowId.name, index: rowIndex.name },
		printingContext(),
	);
	const [idBindBuilt, indexBindBuilt] = pieces.binds;
	const [idSetBuilt, indexSetBuilt] = pieces.setvalues;
	const idBind = binds.get(rowId);
	const indexBind = binds.get(rowIndex);
	if (
		idBindBuilt === undefined ||
		indexBindBuilt === undefined ||
		idSetBuilt === undefined ||
		indexSetBuilt === undefined ||
		idBind?.logic.calculate === undefined ||
		idBind.type !== undefined ||
		!bindHoldsOnly(idBind, ["calculate"]) ||
		!sameXPathText(
			idBind.logic.calculate,
			plain(idBindBuilt, "calculate") ?? "",
			{
				ruleSet: "form",
			},
		) ||
		indexBind === undefined ||
		indexBind.type !== "xsd:int" ||
		!bindHoldsOnly(indexBind, ["type"])
	)
		return undefined;
	const rowSetvalue = (node: DataNode, built: Element) => {
		const found = setvalues.filter(
			(one) =>
				one.target !== undefined &&
				one.target.length === node.path.length &&
				one.target.every((step, index) => step === node.path[index]),
		);
		const only = found.length === 1 ? found[0] : undefined;
		return only !== undefined &&
			only.event === "jr-insert" &&
			only.value !== undefined &&
			sameXPathText(only.value, plain(built, "value") ?? "", {
				ruleSet: "form",
			})
			? only
			: undefined;
	};
	const idSet = rowSetvalue(rowId, idSetBuilt);
	const indexSet = rowSetvalue(rowIndex, indexSetBuilt);
	if (idSet === undefined || indexSet === undefined) return undefined;
	const rowRelevant = binds.get(row)?.logic.relevant;
	if (rowRelevant === undefined) return undefined;
	const guard = trees.guard;
	let condition: string | undefined;
	if (!sameTree(rowRelevant, guard)) {
		const read = readFormSyntax(rowRelevant);
		let top = read.ok ? read.node : undefined;
		while (top?.kind === "group") top = top.value;
		if (top?.kind !== "binary" || top.op !== "and") return undefined;
		const right = rowRelevant.slice(top.right.from, top.right.to);
		if (!sameTree(right, guard)) return undefined;
		condition = rowRelevant.slice(top.left.from, top.left.to);
	}
	return {
		ids,
		count,
		position,
		id: rowId,
		index: rowIndex,
		query: { text: query, at: idsBind.element },
		setvalues: [idSet, indexSet],
		condition,
	};
}

/** The ids node's `join(' ', P)` (`builder.ts::queryIdsValue`): the source text of `P`, or
 *  undefined where the value is no such call. */
function joinedQuery(text: string): string | undefined {
	const query = matchesTemplate(
		text,
		queryIdsValue(w.context([w.step(HOLE)])),
		HOLE,
	);
	return query === undefined ? undefined : text.slice(query.from, query.to);
}

// ── Claiming a recognized node ──────────────────────────────────────────

/** Claims a generated node's element, its bind's type and its logic, each `derived`: the
 *  bind's own element and path are the bind reader's. */
export function claimGeneratedNode(
	cursor: XmlCursor,
	node: DataNode,
	bind: BindFacts | undefined,
	options: { readonly calculate?: boolean } = {},
): void {
	cursor.derived({ element: node.element }, G.node);
	if (bind === undefined) return;
	const element = bind.element;
	if (bind.type === "xsd:int")
		cursor.derived({ element, attribute: "type" }, G.typeInt);
	else if (bind.type === "xsd:string")
		cursor.derived({ element, attribute: "type" }, G.typeString);
	if (bind.logic.relevant !== undefined)
		cursor.derived({ element, attribute: "relevant" }, G.relevant);
	if (bind.logic.readonly !== undefined)
		cursor.derived({ element, attribute: "readonly" }, G.readonly);
	if (bind.logic.calculate !== undefined && options.calculate !== false)
		cursor.derived({ element, attribute: "calculate" }, G.calculate);
}

/** Claims a generated row node's `jr-insert` setvalue. */
export function claimGeneratedSetvalue(
	cursor: XmlCursor,
	setvalue: SetvalueFacts,
): void {
	const element = setvalue.element;
	cursor.derived({ element }, G.setvalue);
	cursor.derived({ element, attribute: "event" }, G.setvalueEvent);
	cursor.derived({ element, attribute: "ref" }, G.setvalueRef);
	cursor.derived({ element, attribute: "value" }, G.setvalueValue);
}

// ── The case region ──────────────────────────────────────────────────────

export type CaseRegionContainer = Extract<
	NodeRole,
	{ kind: "case-region" }
>["container"];

const OPERATIONS = "nova_operations";
const SUBCASES = "nova_subcases";
const SELECTED_CASES = "nova_selected_cases";

/** The container a case region node is, by its name and shape. */
function containerOf(node: DataNode): CaseRegionContainer {
	const name = node.name;
	if (node.role === "SaveToCase")
		return name.startsWith("nova_guard_") ? "guard" : undefined;
	if (isAllocatedName(name, OPERATIONS)) return "operations";
	if (isAllocatedName(name, SUBCASES)) return "subcases";
	if (isAllocatedName(name, SELECTED_CASES)) return "selected-cases";
	if (
		name === "item" &&
		node.parent !== null &&
		isAllocatedName(node.parent.name, SELECTED_CASES)
	)
		return "selected-case";
	if (name.startsWith("nova_count_nova_keyed_")) return "keyed-count";
	if (name.startsWith("nova_keyed_") && node.template) return "keyed";
	if (name.startsWith("nova_condition_")) return "condition";
	return undefined;
}

function inSaveToCase(node: DataNode): boolean {
	for (let at: DataNode | null = node; at !== null; at = at.parent)
		if (at.role === "SaveToCase") return true;
	return false;
}

/** A keyed create's count node: bind-only, `xsd:int`, its calculate the number 1. */
function keyedCountNode(
	node: DataNode,
	binds: ReadonlyMap<DataNode, BindFacts>,
): boolean {
	const bind = binds.get(node);
	return (
		bind !== undefined &&
		bind.type === "xsd:int" &&
		bind.logic.calculate !== undefined &&
		sameXPathText(bind.logic.calculate, "1", { ruleSet: "form" })
	);
}

/** An operation's clock node: bind-only, no type, named `nova_instant_<operation id>_<n>`,
 *  its calculate `typedInstantValue` of a leaf. */
function clockNode(
	node: DataNode,
	binds: ReadonlyMap<DataNode, BindFacts>,
): boolean {
	const bind = binds.get(node);
	if (
		!node.name.startsWith("nova_instant_") ||
		bind === undefined ||
		bind.type !== undefined ||
		bind.logic.calculate === undefined
	)
		return false;
	return (
		matchesTemplate(
			bind.logic.calculate,
			typedInstantValue(w.context([w.step(HOLE)])),
			HOLE,
		) !== undefined
	);
}

/** The query nodes a selected-cases wrapper in the count placement holds. */
function selectedCasesQueryNode(
	node: DataNode,
	binds: ReadonlyMap<DataNode, BindFacts>,
	setvalues: readonly SetvalueFacts[],
): boolean {
	const wrapper =
		node.parent !== null && node.parent.name === "item"
			? node.parent.parent
			: node.parent;
	if (wrapper === null || !isAllocatedName(wrapper.name, SELECTED_CASES))
		return false;
	const row = wrapper.children.find((child) => child.name === "item");
	if (row === undefined) return false;
	const parts = readQueryPlacement(wrapper, row, binds, setvalues);
	return (
		parts !== undefined &&
		[parts.ids, parts.count, parts.id, parts.index].includes(node)
	);
}

export interface CaseRegionInput {
	readonly order: readonly DataNode[];
	readonly binds: ReadonlyMap<DataNode, BindFacts>;
	readonly setvalues: readonly SetvalueFacts[];
	/** The control of each node one names. */
	readonly controlOf: ReadonlyMap<DataNode, ControlNode>;
	/** Nodes another role already holds, a refusal's among them. */
	readonly taken: (node: DataNode) => boolean;
}

/** Whether a node's control, where it has one, is a group with no label and no appearance, or
 *  the repeat of a group with no label and no appearance. */
function scaffoldingControl(control: ControlNode | undefined): boolean {
	if (control === undefined) return true;
	const bare = (one: ControlNode) =>
		one.appearance === undefined &&
		!(one.element.children.filter(isTag) as Element[]).some(
			(child) => splitName(child.name).local === "label",
		);
	if (control.tag === "group") return bare(control);
	if (control.tag === "repeat")
		return (
			bare(control) &&
			control.parent !== null &&
			control.parent.tag === "group" &&
			bare(control.parent)
		);
	return false;
}

/**
 * The case region: every data node that is case scaffolding, with the container its name and
 * shape tell. A node is scaffolding where every leaf at or under it lies in a Save to Case
 * element, is a keyed create's count node, an operation's clock node, or a selected-cases
 * wrapper's query node, and every control naming it or a node under it is a group with no
 * label and no appearance or such a group's repeat. The outermost such node takes the region
 * with everything under it.
 */
export function readCaseRegion(
	input: CaseRegionInput,
): ReadonlyMap<DataNode, CaseRegionContainer> {
	const region = new Map<DataNode, CaseRegionContainer>();
	const leaves = (node: DataNode): DataNode[] =>
		node.children.length === 0 ? [node] : node.children.flatMap(leaves);
	const subtree = (node: DataNode): DataNode[] => [
		node,
		...node.children.flatMap(subtree),
	];
	const scaffolding = (node: DataNode): boolean =>
		leaves(node).every(
			(leaf) =>
				inSaveToCase(leaf) ||
				keyedCountNode(leaf, input.binds) ||
				clockNode(leaf, input.binds) ||
				selectedCasesQueryNode(leaf, input.binds, input.setvalues),
		) &&
		subtree(node).every(
			(at) => inSaveToCase(at) || scaffoldingControl(input.controlOf.get(at)),
		);
	for (const node of input.order) {
		if (region.has(node) || input.taken(node)) continue;
		if (node.role === "SaveToCase") {
			for (const at of subtree(node))
				if (!input.taken(at))
					region.set(at, at === node ? containerOf(node) : undefined);
			continue;
		}
		// A leaf is scaffolding only inside a container; a node another plugin owns is not.
		if (node.children.length === 0) continue;
		if (node.role !== undefined && node.role !== "Repeat") continue;
		if (!scaffolding(node)) continue;
		// A node another role holds, a refused block among them, takes none from the region.
		for (const at of subtree(node))
			if (!input.taken(at)) region.set(at, containerOf(at));
	}
	return region;
}
