/**
 * The cursor over one parsed form source. Every element and attribute a reader
 * stage reads past goes through one of its claims, by itself or by a claim on
 * a subtree that holds it; what no claim reaches is left for
 * `Accounting.close` to report, at the place `placeUnclaimed` gives.
 *
 * A node is spelled for the claim log as the proof lane spells it
 * (`proof/checks/manifest_usage.py::_element_path`), so the lane's judge joins
 * the reader's records with its own uses at one `(artifact, where)`.
 */

import { type Document, type Element, isTag } from "domhandler";
import type { FindingDetail, HqPlace } from "@/lib/publish/hqFindings";
import surface from "../surface/surface.json";
import {
	attributeNamespace,
	elementNamespace,
	type NamespaceScope,
	qualifiedName,
	splitName,
} from "../xmlNamespaces";
import type { Admitted, ClaimLedger, LedgerSite } from "./accounting";
import type { Claim } from "./claims";
import type { HandOffKind } from "./jsonCursor";
import { appearanceKeysMatching } from "./xform/appearances";

/** An element, or one attribute of it by the name the source wrote. */
export interface XmlNode {
	readonly element: Element;
	readonly attribute?: string;
}

export interface XmlCursor {
	readonly artifact: string;
	/** An attribute's value, or an element's own text (its direct text, without its children's). */
	take(node: XmlNode, claim: Claim<"take">): Admitted<string>;
	derived(node: XmlNode, claim: Claim<"derived">): void;
	drop(node: XmlNode, claim: Claim<"drop">): void;
	refuse(
		node: XmlNode,
		claim: Claim<"refuse">,
		place: HqPlace,
		detail?: FindingDetail,
	): void;
	account(
		node: XmlNode,
		claim: Claim<"account">,
		place: HqPlace,
		detail?: FindingDetail,
	): void;
	/** Claim a node that holds no surface key's value as part of what `claim` reads, recording
	 *  nothing there (`ClaimLedger.partOf`): an XHTML wrapper, or an attribute Core copies into
	 *  the instance as answer data. */
	partOf(node: XmlNode, claim: Claim): void;
	/** Where a claim that covers a subtree also stands: a node inside it, recorded under the
	 *  claim's entry and the first of `keys` (the surface key the lane names the node by) the
	 *  entry names (`ClaimLedger.within`). */
	within(node: XmlNode, claim: Claim, keys: readonly string[]): void;
	/** Cover an element, its attributes and everything under it by one claim. */
	takeSubtree(element: Element, claim: Claim<"take">): Admitted<Element>;
	derivedSubtree(element: Element, claim: Claim<"derived">): void;
	dropSubtree(element: Element, claim: Claim<"drop">): void;
	refuseSubtree(
		element: Element,
		claim: Claim<"refuse">,
		place: HqPlace,
		detail?: FindingDetail,
	): void;
	/** Refuses an element, its attributes and everything under it as `refuseSubtree` does, with
	 *  the refusal's record standing at `at`, the node in it whose value makes the class (a
	 *  Save to Case block's attachment, a case block no role marks), rather than at the element. */
	refuseSubtreeAt(
		element: Element,
		at: XmlNode,
		claim: Claim<"refuse">,
		place: HqPlace,
		detail?: FindingDetail,
	): void;
	/** Accounts an element, its attributes and everything under it under one claim, as
	 *  `account` does a node: a finding where the entry's standing makes one. */
	accountSubtree(
		element: Element,
		claim: Claim<"account">,
		place: HqPlace,
		detail?: FindingDetail,
	): void;
	/** Hand a node to project data, as `JsonCursor.handOff` does. `key` is the
	 *  surface key a claim there would name; absent, the lane-style name of the
	 *  node stands for it. */
	handOff(node: XmlNode, to: HandOffKind, subject: string, key?: string): void;
	handOffSubtree(
		element: Element,
		to: HandOffKind,
		subject: string,
		key?: string,
	): void;
	/** Where an unclaimed node's finding is placed: the nearest question, else the form. */
	placeUnclaimed(resolve: (element: Element) => HqPlace): void;
	/** Each attribute a claim read whose surface key Core parses as XPath (the surface's
	 *  `parsedAs: xpath`), in the order the claims were made: a `take`, `derived` or `drop` of the
	 *  attribute, or a claim over a subtree recorded there (`within`). A claim that refuses reads
	 *  nothing. */
	expressionAttributes(): readonly ExpressionAttribute[];
}

/** An attribute a claim read whose value Core parses as XPath, with the surface key it is
 *  claimed under. */
export interface ExpressionAttribute {
	readonly node: XmlNode;
	readonly key: string;
}

/** Every item the surface holds, by its key. */
const SURFACE_ITEMS = (
	surface as unknown as { readonly items: Record<string, unknown> }
).items;

/** The XForm surface keys whose value Core's parser reads as XPath. */
const XPATH_KEYS: ReadonlySet<string> = new Set(
	Object.entries(
		(
			surface as unknown as {
				readonly items: Record<
					string,
					{ readonly parsedAs?: readonly string[] | null }
				>;
			}
		).items,
	)
		.filter(
			([key, item]) =>
				key.startsWith("xform:") && item.parsedAs?.includes("xpath") === true,
		)
		.map(([key]) => key),
);

/** Whether Core's parser reads the value of the XForm surface key `key` as XPath. */
export function parsedAsXPath(key: string): boolean {
	return XPATH_KEYS.has(key);
}

/** The claims whose use reads the value: every use but a refusal and an account. */
function reads(claim: Claim): boolean {
	return (
		claim.use === "take" || claim.use === "derived" || claim.use === "drop"
	);
}

/** The surface keys an attribute is named by through its value: a setvalue's `event` by the
 *  event (`jr-event:<event>`), an `appearance` by each runtime's reading of it. */
function valueKeys(attribute: string, value: string): readonly string[] {
	if (attribute === "event") return [`jr-event:${value}`];
	if (attribute === "appearance") return appearanceKeysMatching(value);
	return [];
}

/** The expanded name of an element, `{uri}local` or `local`. */
function expandedName(element: Element, scope: NamespaceScope): string {
	const namespace = elementNamespace(element, scope);
	const { local } = splitName(element.name);
	return namespace === null ? local : `{${namespace}}${local}`;
}

/** An element's name as the XForm vocabulary writes it. */
export function qualifiedElement(
	element: Element,
	scope: NamespaceScope,
): string {
	return qualifiedName(
		elementNamespace(element, scope),
		splitName(element.name).local,
	);
}

/** An attribute's name as the XForm vocabulary writes it. */
export function qualifiedAttribute(
	name: string,
	scope: NamespaceScope,
): string {
	return qualifiedName(attributeNamespace(name, scope), splitName(name).local);
}

function parentElement(element: Element): Element | null {
	const parent = element.parent;
	return parent !== null && parent.type !== "root" ? (parent as Element) : null;
}

/**
 * A node's `where`, a port of the lane's `_element_path`: from the root down,
 * each step the element's qualified name, and for every element but the root
 * `[n]`, its 1-based position among its parent's element children of the same
 * expanded name. An attribute is the element's `where`, `/@`, and the
 * attribute's qualified name; an element's default `xmlns` is the element's
 * `where` and `/namespace()`, which is how the lane records a namespace read.
 * `scope` is each element's namespace scope (`xmlNamespaces.ts::namespaceScopes`).
 */
export function elementWhere(
	node: XmlNode,
	scope: (element: Element) => NamespaceScope,
): string {
	const steps: string[] = [];
	for (
		let element: Element | null = node.element;
		element !== null;
		element = parentElement(element)
	) {
		const own = scope(element);
		const name = qualifiedElement(element, own);
		const parent = parentElement(element);
		if (parent === null) {
			steps.push(name);
			continue;
		}
		const expanded = expandedName(element, own);
		let n = 0;
		for (const sibling of parent.children) {
			if (!isTag(sibling)) continue;
			if (expandedName(sibling, scope(sibling)) !== expanded) continue;
			n += 1;
			if (sibling === element) break;
		}
		steps.push(`${name}[${n}]`);
	}
	const path = `/${steps.reverse().join("/")}`;
	if (node.attribute === undefined) return path;
	if (node.attribute === "xmlns") return `${path}/namespace()`;
	return `${path}/@${qualifiedAttribute(node.attribute, scope(node.element))}`;
}

/** The text directly under an element, its children's left out. */
export function ownText(element: Element): string {
	let text = "";
	for (const child of element.children)
		if (child.type === "text") text += child.data;
	return text;
}

/**
 * The node a claim on `node` is recorded at: where the value of the surface key
 * it names sits. That is the node itself, but for a claim on an element that
 * names one of its attributes (`xform:model/instance@id` refusing an inline
 * instance whole), which is recorded at that attribute, and a claim naming an
 * itext form (`itext-form:core/markdown`) on a `<value>` that names its form:
 * the form a value is read as is the value of its `form` attribute, so the
 * record stands there, as a hand-off of such a value under that key does; and
 * a claim on an attribute an extension parser reads, which stands at its
 * control.
 */
function recordedNode(
	node: XmlNode,
	key: string | null,
	scope: (element: Element) => NamespaceScope,
): XmlNode {
	// An extension parser's key names the control it parses
	// (`proof/checks/manifest_usage.py` records its use there), so a claim
	// on the attribute it reads stands at the control.
	if (node.attribute !== undefined && key?.startsWith("jr-extension:"))
		return { element: node.element };
	if (node.attribute !== undefined || key === null) return node;
	const { element } = node;
	if (key.startsWith("itext-form:"))
		return Object.hasOwn(element.attribs, "form")
			? { element, attribute: "form" }
			: node;
	const at = key.lastIndexOf("@");
	if (at === -1) return node;
	const named = key.slice(at + 1);
	const own = scope(element);
	for (const attribute of Object.keys(element.attribs))
		if (qualifiedAttribute(attribute, own) === named)
			return { element, attribute };
	return node;
}

/** The element's depth inside the instance that holds it (1 for the instance's own element, its
 *  data root), or 0 where no instance holds it. */
function instanceDepth(element: Element): number {
	let depth = 0;
	for (let at: Element | null = element; at !== null; at = parentElement(at)) {
		const parent = parentElement(at);
		depth += 1;
		if (parent !== null && splitName(parent.name).local === "instance")
			return depth;
	}
	return 0;
}

/** Whether a step of a surface key's element path names an element: a step holding `*` names any,
 *  a prefixed step the element of that qualified name, a bare one any element of that local name. */
function stepNames(step: string, element: Element, scope: NamespaceScope) {
	if (step.includes("*")) return true;
	return step.includes(":")
		? qualifiedElement(element, scope) === step
		: splitName(element.name).local === step;
}

/** Whether a surface key names a node of a form's source by where it stands (the XForm and Vellum
 *  markup families), rather than a value or a type read there. */
export function namesFormNodes(key: string): boolean {
	return key.startsWith("xform:") || key.startsWith("vellum-markup:");
}

/**
 * Whether the surface key `key` names `node` as the proof lane names a form's nodes
 * (`proof/checks/manifest_usage.py::xform_vocabulary`, `vellum_markup_key`). An XForm or Vellum
 * markup key names an attribute exactly where it ends in that attribute's name (`@xmlns` the
 * element's namespace; a Vellum key's `vellum:` name also the bare attribute of that name, which
 * Vellum's parser reads as the same value), an element inside an instance exactly where its path is the instance's
 * (an XForm key by the most specific path the node's depth matches that the surface holds with
 * the key's attribute: one `*` step the data root, two a child of it, `//*` any node deeper or one
 * no more specific item holds; Vellum's markup at any depth), and any other element by its last
 * step. A
 * key of another family names a value or a type, and stands wherever the value it names is read.
 */
export function keyNamesNode(
	key: string,
	node: XmlNode,
	scope: (element: Element) => NamespaceScope,
): boolean {
	if (!namesFormNodes(key)) return true;
	const colon = key.indexOf(":");
	const family = key.slice(0, colon);
	const body = key.slice(colon + 1);
	const at = body.lastIndexOf("@");
	const path = at === -1 ? body : body.slice(0, at);
	const attribute = at === -1 ? undefined : body.slice(at + 1);
	const { element } = node;
	const own = scope(element);
	if (node.attribute === undefined) {
		if (attribute !== undefined) return false;
	} else if (node.attribute === "xmlns") {
		if (attribute !== "xmlns") return false;
	} else {
		const named = qualifiedAttribute(node.attribute, own);
		// An attribute Core does not read named as a `vellum:` attribute Vellum asks of the element
		// is that attribute to Vellum's parser (`parser.js::parseVellumAttrs`), as the lane names it.
		const shadowed =
			family === "vellum-markup" &&
			!named.includes(":") &&
			attribute === `vellum:${named}`;
		if (attribute !== named && !shadowed) return false;
	}
	const depth = instanceDepth(element);
	if (family === "vellum-markup") {
		const content = path === "model/instance//*";
		if (content !== depth > 0) return false;
		if (content) return true;
	} else if (path.startsWith("model/instance/")) {
		const steps = path.slice("model/instance/".length);
		const suffix = attribute === undefined ? "" : `@${attribute}`;
		// The lane names the node by the most specific of the paths its depth matches that the
		// surface holds an item of, with the attribute where there is one.
		const candidates =
			depth === 1 ? ["*", "/*"] : depth === 2 ? ["*/*", "/*"] : ["/*"];
		const named = candidates.find((one) =>
			Object.hasOwn(SURFACE_ITEMS, `xform:model/instance/${one}${suffix}`),
		);
		return depth > 0 && named === steps;
	} else if (depth > 0) return false;
	const steps = path.split("/");
	return stepNames(steps[steps.length - 1] as string, element, own);
}

/** A node's site in the ledger. Its name is spelled only where a finding or a defect names the
 *  node, and its `where` only where the claim log keeps records. */
class XmlSite implements LedgerSite {
	readonly owner: Element;
	readonly sub: string;
	readonly artifact: string;
	readonly where: () => string;
	readonly names: (key: string) => boolean;

	constructor(
		private readonly cursor: XmlCursorImpl,
		private readonly node: XmlNode,
		at: XmlNode,
	) {
		this.owner = node.element;
		this.sub = node.attribute ?? "";
		this.artifact = cursor.artifact;
		this.where = () => elementWhere(at, cursor.scope);
		this.names = (key) => keyNamesNode(key, at, cursor.scope);
	}

	get name(): string {
		return this.cursor.nodeName(this.node);
	}
}

/** The cursor `Accounting.xml` makes. */
export class XmlCursorImpl implements XmlCursor {
	readonly artifact: string;
	resolvePlace: (element: Element) => HqPlace;
	readonly #expressionAttributes: ExpressionAttribute[] = [];

	constructor(
		private readonly ledger: ClaimLedger,
		readonly document: Document,
		readonly scope: (element: Element) => NamespaceScope,
		menu: number,
		form: number,
		readonly place: HqPlace,
	) {
		this.artifact = `form:${menu}.${form}`;
		this.resolvePlace = () => place;
		ledger.registerXml(this);
	}

	/** The surface name of a node, as an `unrecognized` finding names it. */
	nodeName(node: XmlNode): string {
		const scope = this.scope(node.element);
		const element = `xform:${qualifiedElement(node.element, scope)}`;
		if (node.attribute === undefined) return element;
		if (node.attribute === "xmlns") return `${element}@xmlns`;
		return `${element}@${qualifiedAttribute(node.attribute, scope)}`;
	}

	/** `node`'s site; `claim`, where given, is the claim recorded there, which decides where its
	 *  record stands (`recordedNode`). */
	site(node: XmlNode, claim?: Claim): LedgerSite {
		return new XmlSite(
			this,
			node,
			claim === undefined ? node : recordedNode(node, claim.key, this.scope),
		);
	}

	/** Whether the node is in the source: an element, an attribute it holds, or its namespace,
	 *  which every element has whether or not it declares one (`xmlns`, recorded at
	 *  `namespace()`, where a reader reads it). */
	private present(node: XmlNode): boolean {
		return (
			node.attribute === undefined ||
			node.attribute === "xmlns" ||
			Object.hasOwn(node.element.attribs, node.attribute)
		);
	}

	take(node: XmlNode, claim: Claim<"take">): Admitted<string> {
		const value =
			node.attribute === undefined
				? ownText(node.element)
				: (node.element.attribs[node.attribute] ?? "");
		if (!this.present(node)) return this.ledger.unrecorded(value);
		const site = this.site(node, claim);
		const place = this.resolvePlace(node.element);
		if (!this.ledger.claim(site, claim, place))
			return this.ledger.unrecorded(value);
		if (node.attribute === undefined) this.ledger.claimText(node.element);
		else this.noteExpression(node, claim, [claim.key]);
		return this.ledger.admit(value, site, claim, place);
	}

	/** Notes an attribute a reading claim read whose key, one of `keys`, Core parses as XPath. */
	private noteExpression(
		node: XmlNode,
		claim: Claim,
		keys: readonly (string | null)[],
	): void {
		if (node.attribute === undefined || !reads(claim)) return;
		const key = keys.find((one) => one !== null && XPATH_KEYS.has(one));
		if (key !== undefined && key !== null)
			this.#expressionAttributes.push({ node, key });
	}

	expressionAttributes(): readonly ExpressionAttribute[] {
		return this.#expressionAttributes;
	}

	derived(node: XmlNode, claim: Claim<"derived">): void {
		this.plain(node, claim, this.resolvePlace(node.element));
	}

	drop(node: XmlNode, claim: Claim<"drop">): void {
		this.plain(node, claim, this.resolvePlace(node.element));
	}

	refuse(
		node: XmlNode,
		claim: Claim<"refuse">,
		place: HqPlace,
		detail?: FindingDetail,
	): void {
		this.plain(node, claim, place, detail);
	}

	account(
		node: XmlNode,
		claim: Claim<"account">,
		place: HqPlace,
		detail?: FindingDetail,
	): void {
		this.plain(node, claim, place, detail);
	}

	private plain(
		node: XmlNode,
		claim: Claim,
		place: HqPlace,
		detail?: FindingDetail,
	): void {
		if (
			this.present(node) &&
			this.ledger.claim(this.site(node, claim), claim, place, detail)
		)
			this.noteExpression(node, claim, [claim.key]);
	}

	partOf(node: XmlNode, claim: Claim): void {
		if (this.present(node))
			this.ledger.partOf(
				this.site(node),
				claim,
				this.resolvePlace(node.element),
			);
	}

	within(node: XmlNode, claim: Claim, keys: readonly string[]): void {
		if (!this.present(node)) return;
		this.ledger.within(this.site(node), claim, keys);
		this.noteExpression(node, claim, keys);
	}

	/** Where a finding made of `node`'s value stands (`Accounting.findingAtNode`): the node, or
	 *  the attribute of it `key` names (`recordedNode`), under the claim's entry and `key`. */
	withinAt(node: XmlNode, claim: Claim, key: string): void {
		if (!this.present(node)) return;
		const at = recordedNode(node, key, this.scope);
		this.ledger.within(new XmlSite(this, at, at), claim, [key]);
	}

	private subtree(
		element: Element,
		claim: Claim,
		place: HqPlace,
		detail?: FindingDetail,
		at?: XmlNode,
	): boolean {
		const site =
			at === undefined
				? this.site({ element }, claim)
				: new XmlSite(
						this,
						{ element },
						recordedNode(at, claim.key, this.scope),
					);
		const recorded = this.ledger.claim(site, claim, place, detail);
		this.ledger.coverSubtree(
			element,
			claim.use === "take" || claim.use === "derived",
		);
		if (recorded) this.findingWithin(element, claim);
		return recorded;
	}

	/**
	 * A refusal or an account covering `element` stands also at each attribute under it whose
	 * surface key is spelled by its value (`valueKeys`) where its entry names that key: a
	 * setvalue's `event` (`jr-event:<event>`) and an `appearance` (`appearance:<runtime>/<value>`),
	 * which the entry's class is a fact about as much as the element it refuses.
	 */
	private findingWithin(element: Element, claim: Claim): void {
		if (claim.use !== "refuse" && claim.use !== "account") return;
		const visit = (at: Element) => {
			for (const [attribute, value] of Object.entries(at.attribs)) {
				const keys = valueKeys(
					qualifiedAttribute(attribute, this.scope(at)),
					value,
				);
				if (keys.length > 0)
					this.within({ element: at, attribute }, claim, keys);
			}
			for (const child of at.children) if (isTag(child)) visit(child);
		};
		visit(element);
	}

	takeSubtree(element: Element, claim: Claim<"take">): Admitted<Element> {
		const site = this.site({ element }, claim);
		const place = this.resolvePlace(element);
		return this.subtree(element, claim, place)
			? this.ledger.admit(element, site, claim, place)
			: this.ledger.unrecorded(element);
	}

	derivedSubtree(element: Element, claim: Claim<"derived">): void {
		this.subtree(element, claim, this.resolvePlace(element));
	}

	dropSubtree(element: Element, claim: Claim<"drop">): void {
		this.subtree(element, claim, this.resolvePlace(element));
	}

	refuseSubtree(
		element: Element,
		claim: Claim<"refuse">,
		place: HqPlace,
		detail?: FindingDetail,
	): void {
		this.subtree(element, claim, place, detail);
	}

	refuseSubtreeAt(
		element: Element,
		at: XmlNode,
		claim: Claim<"refuse">,
		place: HqPlace,
		detail?: FindingDetail,
	): void {
		this.subtree(element, claim, place, detail, at);
	}

	accountSubtree(
		element: Element,
		claim: Claim<"account">,
		place: HqPlace,
		detail?: FindingDetail,
	): void {
		this.subtree(element, claim, place, detail);
	}

	handOff(node: XmlNode, to: HandOffKind, subject: string, key?: string): void {
		if (!this.present(node)) return;
		this.ledger.handOff(
			this.site(node),
			key ?? this.nodeName(node),
			to,
			subject,
		);
	}

	handOffSubtree(
		element: Element,
		to: HandOffKind,
		subject: string,
		key?: string,
	): void {
		const plain = this.site({ element });
		const site =
			key === undefined
				? plain
				: {
						...plain,
						where: () =>
							elementWhere(
								recordedNode({ element }, key, this.scope),
								this.scope,
							),
					};
		this.ledger.handOff(site, key ?? plain.name, to, subject);
		this.ledger.coverSubtree(element, false);
	}

	placeUnclaimed(resolve: (element: Element) => HqPlace): void {
		this.resolvePlace = resolve;
	}
}
