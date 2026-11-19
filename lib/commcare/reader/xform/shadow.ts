/**
 * Vellum's shadows and the form's hashtag metadata. HQ's form builder reads
 * `vellum:<name>` in preference to `<name>` wherever it reads a path or an
 * expression, while every device reads `<name>`
 * (`parser.js::parseVellumAttrs`), and its next save writes the real
 * attribute from the shadow. So each shadow must expand to the tree of its
 * real attribute, or the form changes under the next person who opens it:
 * that difference is `shadow-disagrees`. A form saved with rich text off has
 * shadows the form builder does not read, and they are inert.
 *
 * The head's hashtag metadata is `vellum:hashtags`, a JSON object from a
 * hashtag to the path it stands for or `null`, and `vellum:hashtagTransforms`,
 * whose `prefixes` map a hashtag prefix to a path prefix. JSON Vellum cannot
 * read is an empty map, as `parser.js::initHashtags` treats it.
 */

import type { Element } from "domhandler";
import { isTag } from "domhandler";
import type { HqPlace } from "@/lib/publish/hqFindings";
import surface from "../../surface/surface.json";
import {
	isElement,
	JAVAROSA_NS,
	type NamespaceScope,
	scopeOf,
	splitName,
	VELLUM_NS,
	XFORMS_NS,
} from "../../xmlNamespaces";
import type { FormSyntax } from "../../xpath/formSyntax";
import type { Accounting } from "../accounting";
import { account, type Claim, defineClaims, drop, refuse } from "../claims";
import { sameSyntax } from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";
import { ownText, type XmlCursor } from "../xmlCursor";
import type { HashtagMetadata, ParsedXForm } from "./parse";

function jsonObject(text: string): Readonly<Record<string, unknown>> {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** The head's two maps as written; unreadable JSON reads as empty maps. */
export function readHashtagMetadata(
	head: Element,
	scope: NamespaceScope,
): HashtagMetadata {
	const hashtags: Record<string, string | null> = {};
	const transforms: Record<string, string> = {};
	for (const child of head.children) {
		if (!isTag(child)) continue;
		const own = scopeOf(child, scope);
		if (isElement(child, own, VELLUM_NS, "hashtags")) {
			for (const [tag, path] of Object.entries(jsonObject(ownText(child))))
				if (typeof path === "string" || path === null) hashtags[tag] = path;
		} else if (isElement(child, own, VELLUM_NS, "hashtagTransforms")) {
			const prefixes = jsonObject(ownText(child)).prefixes;
			if (typeof prefixes === "object" && prefixes !== null)
				for (const [prefix, path] of Object.entries(prefixes))
					if (typeof path === "string") transforms[prefix] = path;
		}
	}
	return { hashtags, transforms };
}

/** The case management plugin's mapping in the head (`caseManagement.js`,
 *  `<vellum:case_mappings>`), which Vellum writes only when a form's source is copied and which
 *  says what HQ's form builder knew when it last saved; Nova writes none. */
export const CASE_MAPPINGS = defineClaims("xform", {
	"vellum-case-mappings-head": drop(
		"questions/vellum-case-mappings-head",
		"vellum-plugin:caseManagement",
	),
})["vellum-case-mappings-head"];

// ── Which attributes have shadows ────────────────────────────────────────

/** The `vellum:` attributes of the `vellum-markup:` family that are no shadow of a real
 *  attribute: markers HQ's form builder reads for themselves. */
const NOT_SHADOWS: ReadonlySet<string> = new Set([
	"lock",
	"requiredCondition",
	"role",
	"case_type",
	"comment",
	"ignore",
]);

const SHADOW_KEY_PREFIX = "vellum-markup:";

/** Each shadow's surface key, by element local name and shadow local name. */
function shadowKeys(): readonly {
	readonly element: string;
	readonly shadow: string;
	readonly key: string;
}[] {
	const keys: { element: string; shadow: string; key: string }[] = [];
	for (const key of Object.keys(
		(surface as { readonly items: Record<string, unknown> }).items,
	)) {
		if (!key.startsWith(SHADOW_KEY_PREFIX)) continue;
		const rest = key.slice(SHADOW_KEY_PREFIX.length);
		const at = rest.indexOf("@vellum:");
		if (at < 0) continue;
		const element = rest.slice(0, at);
		const shadow = rest.slice(at + "@vellum:".length);
		if (element.includes("/") || element.includes(":")) continue;
		if (NOT_SHADOWS.has(shadow)) continue;
		keys.push({ element, shadow, key });
	}
	return keys;
}

const KEYS = shadowKeys();

/** By element local name: each real attribute that has a shadow, with the shadow's name. The
 *  shadow's name is Vellum's spelling of the real one, a `:` written `__` (`jr:count` is
 *  `vellum:jr__count`). */
export const SHADOWED_ATTRIBUTES: Readonly<
	Record<string, readonly { readonly real: string; readonly shadow: string }[]>
> = (() => {
	const table: Record<string, { real: string; shadow: string }[]> = {};
	for (const { element, shadow } of KEYS) {
		const list = table[element] ?? [];
		list.push({ real: shadow.replaceAll("__", ":"), shadow });
		table[element] = list;
	}
	return table;
})();

/** The drop each shadow attribute takes, by its surface key. */
const SHADOW_CLAIMS: ReadonlyMap<string, Claim<"drop">> = (() => {
	const entry = "questions/vellum-hashtag-shadow-attributes";
	const claims = new Map<string, Claim<"drop">>();
	const named: Record<string, Claim<"drop">> = {};
	for (const { key } of KEYS) {
		const claim = drop(entry, key);
		claims.set(key, claim);
		named[`vellum-hashtag-shadow-attributes@${key}`] = claim;
	}
	defineClaims("xform", named);
	return claims;
})();

const REQUIRED_KEY = "vellum-markup:bind@vellum:requiredCondition";

/** The claims of a bind's `requiredCondition` (Vellum's, or the bare one it also writes) and of
 *  `jr:requiredMsg`. */
export const REQUIRED_CONDITION = defineClaims("xform", {
	"required-condition-without-required": drop(
		"questions/required-condition-without-required",
		REQUIRED_KEY,
	),
	"vellum-requiredcondition-expr-vellum-requiredcondition-equal-to": drop(
		"questions/vellum-requiredcondition-expr-vellum-requiredcondition-equal-to",
		REQUIRED_KEY,
	),
	"requiredcondition-differing-from-a-present-non-false-required": refuse(
		"questions/requiredcondition-differing-from-a-present-non-false-required",
		REQUIRED_KEY,
	),
	"jr-requiredmsg": account("questions/jr-requiredmsg", null),
});

// ── The comparison ───────────────────────────────────────────────────────

/** A form's bindings of `null` hashtags so far, by hashtag: the subtree each first met. */
export type HashtagBindings = Map<string, FormSyntax>;

type Expansion =
	| { readonly kind: "tree"; readonly tree: FormSyntax }
	| { readonly kind: "null"; readonly hashtag: string }
	| { readonly kind: "none" };

const AT = { from: 0, to: 0 } as const;

/** The absolute path `/root/a/b` as a tree. */
function absoluteTree(steps: readonly string[]): FormSyntax {
	let tree: FormSyntax | undefined;
	for (const step of steps) {
		const name: FormSyntax = {
			...AT,
			kind: "name",
			name: step,
			wildcard: false,
		};
		tree =
			tree === undefined
				? { ...AT, kind: "child", step: name, descendant: false }
				: { ...AT, kind: "child", left: tree, step: name, descendant: false };
	}
	if (tree === undefined)
		throw new Error("An absolute path holds at least the data root's name.");
	return tree;
}

/** A hashtag's spelling, `#ns/a/b`, as the head's maps key it. */
function hashtagText(node: Extract<FormSyntax, { kind: "hashtag" }>): string {
	return `#${node.namespace}/${node.segments.join("/")}`;
}

function parsed(text: string): FormSyntax | undefined {
	const read = readFormSyntax(text);
	return read.ok ? read.node : undefined;
}

/**
 * What a hashtag stands for: `#form/…` the path under the data root; another hashtag the
 * path the head's `hashtags` map gives it, else the head's transform of exactly the prefix up
 * to its last slash followed by its last segment (`parser.js::initHashtags`,
 * `transformHashtag`); else, where the map holds it as `null`, the subtree it meets in the real
 * attribute; else nothing, and HQ's form builder would write it back as itself.
 */
function expand(
	node: Extract<FormSyntax, { kind: "hashtag" }>,
	head: HashtagMetadata,
	root: string,
): Expansion {
	if (node.namespace === "form")
		return { kind: "tree", tree: absoluteTree([root, ...node.segments]) };
	const text = hashtagText(node);
	const mapped = Object.hasOwn(head.hashtags, text)
		? head.hashtags[text]
		: undefined;
	if (typeof mapped === "string") {
		const tree = parsed(mapped);
		return tree === undefined ? { kind: "none" } : { kind: "tree", tree };
	}
	const slash = text.lastIndexOf("/");
	const prefix = text.slice(0, slash + 1);
	const last = text.slice(slash + 1);
	if (slash > 1 && last.length > 0 && Object.hasOwn(head.transforms, prefix)) {
		const tree = parsed(`${head.transforms[prefix]}${last}`);
		return tree === undefined ? { kind: "none" } : { kind: "tree", tree };
	}
	if (mapped === null) return { kind: "null", hashtag: text };
	return { kind: "none" };
}

function strip(node: FormSyntax): FormSyntax {
	if (node.kind === "group") return strip(node.value);
	if (node.kind === "axis" && node.axis === "child") return strip(node.value);
	return node;
}

function holdsHashtag(node: FormSyntax): boolean {
	switch (node.kind) {
		case "hashtag":
			return true;
		case "group":
		case "negative":
		case "axis":
			return holdsHashtag(node.value);
		case "child":
			return (
				(node.left !== undefined && holdsHashtag(node.left)) ||
				holdsHashtag(node.step)
			);
		case "filter":
			return holdsHashtag(node.base) || holdsHashtag(node.where);
		case "binary":
			return holdsHashtag(node.left) || holdsHashtag(node.right);
		case "call":
			return node.args.some(holdsHashtag);
		default:
			return false;
	}
}

/** Whether a tree is a location path that starts from the context node. */
function isRelativePath(node: FormSyntax): boolean {
	switch (node.kind) {
		case "group":
			return isRelativePath(node.value);
		case "child":
			return node.left !== undefined && isRelativePath(node.left);
		case "filter":
			return isRelativePath(node.base);
		case "name":
		case "self":
		case "parent":
			return true;
		case "axis":
			return node.axis === "child" || node.axis === "attribute";
		default:
			return false;
	}
}

/** A relative location path made absolute from `base`, as `parser.js::processPath` and
 *  `getPathFromControlElement` make a path absolute. */
function rebase(node: FormSyntax, base: readonly string[]): FormSyntax {
	switch (node.kind) {
		case "group":
			return rebase(node.value, base);
		case "child":
			return node.left === undefined
				? node
				: { ...node, left: rebase(node.left, base) };
		case "filter":
			return { ...node, base: rebase(node.base, base) };
		default:
			return {
				...AT,
				kind: "child",
				left: absoluteTree(base),
				step: node,
				descendant: false,
			};
	}
}

/**
 * Whether the shadow, expanded, and the real attribute are one tree. `base` is the path a
 * relative path is taken from, the data root's name first; empty, where the attribute holds
 * an expression rather than a path, no relative path is rebased. A `null` hashtag met for the
 * first time is bound in `bindings` where the two agree.
 */
export function shadowAgrees(
	real: string,
	shadow: string,
	metadata: {
		readonly head: HashtagMetadata;
		readonly bindings: HashtagBindings;
		readonly root: string;
	},
	base: readonly string[],
): "agrees" | "disagrees" | "shadow-unparseable" | "real-unparseable" {
	const shadowRead = readFormSyntax(shadow);
	if (!shadowRead.ok) return "shadow-unparseable";
	const realRead = readFormSyntax(real);
	if (!realRead.ok) return "real-unparseable";
	if (shadowRead.node === undefined || realRead.node === undefined)
		return shadowRead.node === realRead.node ? "agrees" : "disagrees";
	let shadowTree = shadowRead.node;
	let realTree = realRead.node;
	if (base.length > 0) {
		if (isRelativePath(shadowTree)) shadowTree = rebase(shadowTree, base);
		if (isRelativePath(realTree)) realTree = rebase(realTree, base);
	}
	const pending = new Map<string, FormSyntax>();
	const same = (a: FormSyntax, b: FormSyntax) =>
		sameSyntax(a, b, { ruleSet: "form" });
	const compare = (s: FormSyntax, r: FormSyntax): boolean => {
		const a = strip(s);
		const b = strip(r);
		if (a.kind === "hashtag") {
			const expansion = expand(a, metadata.head, metadata.root);
			if (expansion.kind === "none") return false;
			if (expansion.kind === "tree") return same(expansion.tree, b);
			const bound =
				metadata.bindings.get(expansion.hashtag) ??
				pending.get(expansion.hashtag);
			if (bound !== undefined) return same(bound, b);
			pending.set(expansion.hashtag, b);
			return true;
		}
		if (!holdsHashtag(a)) return same(a, b);
		switch (a.kind) {
			case "binary":
				return (
					b.kind === "binary" &&
					a.op === b.op &&
					compare(a.left, b.left) &&
					compare(a.right, b.right)
				);
			case "call":
				return (
					b.kind === "call" &&
					a.name === b.name &&
					a.args.length === b.args.length &&
					a.args.every((arg, index) =>
						compare(arg, b.args[index] as FormSyntax),
					)
				);
			case "negative":
				return b.kind === "negative" && compare(a.value, b.value);
			case "filter":
				return (
					b.kind === "filter" &&
					compare(a.base, b.base) &&
					compare(a.where, b.where)
				);
			case "child":
				return (
					b.kind === "child" &&
					a.descendant === b.descendant &&
					(a.left === undefined) === (b.left === undefined) &&
					(a.left === undefined || compare(a.left, b.left as FormSyntax)) &&
					compare(a.step, b.step)
				);
			case "axis":
				return (
					b.kind === "axis" && a.axis === b.axis && compare(a.value, b.value)
				);
			default:
				return false;
		}
	};
	if (!compare(shadowTree, realTree)) return "disagrees";
	for (const [hashtag, tree] of pending) metadata.bindings.set(hashtag, tree);
	return "agrees";
}

// ── Judging a form's shadows ─────────────────────────────────────────────

/** The attribute of `element` in `uri` named `local`, by the name the source wrote. */
function attributeIn(
	element: Element,
	scope: NamespaceScope,
	uri: string,
	local: string,
): string | undefined {
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

/** The real attribute's name as written: `jr:count` in the JavaRosa namespace, any other with
 *  no prefix. */
function realName(
	element: Element,
	scope: NamespaceScope,
	real: string,
): string | undefined {
	if (real.startsWith("jr:"))
		return attributeIn(element, scope, JAVAROSA_NS, real.slice("jr:".length));
	return Object.hasOwn(element.attribs, real) ? real : undefined;
}

const PATH_ATTRIBUTES = new Set(["nodeset", "ref", "bind"]);
const CONTROL_ELEMENTS = new Set([
	"input",
	"secret",
	"select",
	"select1",
	"trigger",
	"upload",
	"group",
	"repeat",
]);

export interface JudgeShadowsInput {
	readonly parsed: ParsedXForm;
	readonly cursor: XmlCursor;
	readonly accounting: Accounting;
	/** The question an element stands for, else the form. */
	readonly placeOf: (element: Element) => HqPlace;
	/** The data path of the node an enclosing control names, from the data root down with the
	 *  root left out; undefined where no control encloses the element. */
	readonly enclosingControlPath: (
		element: Element,
	) => readonly string[] | undefined;
}

/**
 * Judges every shadow of the form, in document order, and each bind's
 * `requiredCondition` and `jr:requiredMsg`. Each shadow is dropped under the shadow
 * entry; one that does not agree with its real attribute raises `shadow-disagrees` at its
 * question, named by the real attribute.
 */
export function judgeShadows(input: JudgeShadowsInput): void {
	const { parsed, cursor, accounting } = input;
	const root = parsed.dataRoot.name;
	const richTextOff = parsed.ignore.includes("richText");
	const metadata = {
		head: parsed.hashtags,
		bindings: new Map<string, FormSyntax>() as HashtagBindings,
		root,
	};
	const visit = (element: Element) => {
		const scope = parsed.scope(element);
		const { local } = splitName(element.name);
		const pairs = SHADOWED_ATTRIBUTES[local];
		const inXForms = scope.get(splitName(element.name).prefix) === XFORMS_NS;
		if (pairs !== undefined && inXForms) {
			for (const pair of pairs) {
				const shadow = attributeIn(element, scope, VELLUM_NS, pair.shadow);
				if (shadow === undefined) continue;
				judge(element, scope, local, pair, shadow);
			}
		}
		if (local === "bind" && inXForms) judgeRequired(element, scope);
		for (const child of element.children) if (isTag(child)) visit(child);
	};
	const judge = (
		element: Element,
		scope: NamespaceScope,
		local: string,
		pair: { readonly real: string; readonly shadow: string },
		shadow: string,
	) => {
		const key = `${SHADOW_KEY_PREFIX}${local}@vellum:${pair.shadow}`;
		const claim = SHADOW_CLAIMS.get(key);
		if (claim === undefined) return;
		const node = { element, attribute: shadow };
		cursor.drop(node, claim);
		if (richTextOff) return;
		const real = realName(element, scope, pair.real);
		const disagree = () =>
			accounting.circumstance("shadow-disagrees", input.placeOf(element), {
				name: pair.real,
			});
		if (real === undefined) {
			disagree();
			return;
		}
		const base = !PATH_ATTRIBUTES.has(pair.real)
			? []
			: CONTROL_ELEMENTS.has(local)
				? [root, ...(input.enclosingControlPath(element) ?? [])]
				: [root];
		const verdict = shadowAgrees(
			element.attribs[real] ?? "",
			element.attribs[shadow] ?? "",
			metadata,
			base,
		);
		if (verdict === "disagrees" || verdict === "shadow-unparseable") disagree();
	};
	const judgeRequired = (element: Element, scope: NamespaceScope) => {
		const message = attributeIn(element, scope, JAVAROSA_NS, "requiredMsg");
		if (message !== undefined)
			cursor.account(
				{ element, attribute: message },
				REQUIRED_CONDITION["jr-requiredmsg"],
				input.placeOf(element),
			);
		const conditions = [
			attributeIn(element, scope, VELLUM_NS, "requiredCondition"),
			Object.hasOwn(element.attribs, "requiredCondition")
				? "requiredCondition"
				: undefined,
		].filter((name): name is string => name !== undefined);
		if (conditions.length === 0) return;
		const required = element.attribs.required;
		for (const name of conditions) {
			const node = { element, attribute: name };
			if (required === undefined) {
				cursor.drop(
					node,
					REQUIRED_CONDITION["required-condition-without-required"],
				);
				continue;
			}
			const verdict = isFalse(required)
				? "agrees"
				: shadowAgrees(required, element.attribs[name] ?? "", metadata, []);
			if (verdict === "agrees" || verdict === "real-unparseable")
				cursor.drop(
					node,
					REQUIRED_CONDITION[
						"vellum-requiredcondition-expr-vellum-requiredcondition-equal-to"
					],
				);
			else
				cursor.refuse(
					node,
					REQUIRED_CONDITION[
						"requiredcondition-differing-from-a-present-non-false-required"
					],
					input.placeOf(element),
				);
		}
	};
	visit(parsed.html);
}

/** Whether a `required` is `false()`, by its tree. */
function isFalse(text: string): boolean {
	const tree = parsed(text);
	const node = tree === undefined ? undefined : strip(tree);
	return (
		node?.kind === "call" && node.name === "false" && node.args.length === 0
	);
}
