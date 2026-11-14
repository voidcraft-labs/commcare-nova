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

/** The cursor `Accounting.xml` makes. */
export class XmlCursorImpl implements XmlCursor {
	readonly artifact: string;
	resolvePlace: (element: Element) => HqPlace;

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

	site(node: XmlNode): LedgerSite {
		return {
			owner: node.element,
			sub: node.attribute ?? "",
			artifact: this.artifact,
			where: () => elementWhere(node, this.scope),
			name: this.nodeName(node),
		};
	}

	private present(node: XmlNode): boolean {
		return (
			node.attribute === undefined ||
			Object.hasOwn(node.element.attribs, node.attribute)
		);
	}

	take(node: XmlNode, claim: Claim<"take">): Admitted<string> {
		const value =
			node.attribute === undefined
				? ownText(node.element)
				: (node.element.attribs[node.attribute] ?? "");
		if (!this.present(node)) return this.ledger.unrecorded(value);
		const site = this.site(node);
		const place = this.resolvePlace(node.element);
		if (!this.ledger.claim(site, claim, place))
			return this.ledger.unrecorded(value);
		if (node.attribute === undefined) this.ledger.claimText(node.element);
		return this.ledger.admit(value, site, claim, place);
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
		if (this.present(node))
			this.ledger.claim(this.site(node), claim, place, detail);
	}

	private subtree(
		element: Element,
		claim: Claim,
		place: HqPlace,
		detail?: FindingDetail,
	): boolean {
		const recorded = this.ledger.claim(
			this.site({ element }),
			claim,
			place,
			detail,
		);
		this.ledger.coverSubtree(element);
		return recorded;
	}

	takeSubtree(element: Element, claim: Claim<"take">): Admitted<Element> {
		const site = this.site({ element });
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
		const site = this.site({ element });
		this.ledger.handOff(site, key ?? site.name, to, subject);
		this.ledger.coverSubtree(element);
	}

	placeUnclaimed(resolve: (element: Element) => HqPlace): void {
		this.resolvePlace = resolve;
	}
}
