/**
 * The refusals a form's reading made, kept beside its cursor. A refused thing
 * is refused whole: what belongs to it and stands elsewhere in the source (the
 * itext a refused control's label names, the binds of a refused question) is
 * claimed under the refusal that covers its owner, so one cause is one
 * finding. `refusingCursor` wraps the form's cursor and remembers each
 * refusal it makes, by the node or the subtree it covers, and each node it
 * claims at all, so a later claim of what a refusal covers never claims a
 * node twice.
 */

import type { Element } from "domhandler";
import type { FindingDetail, HqPlace } from "@/lib/publish/hqFindings";
import type { Claim } from "../claims";
import type { XmlCursor, XmlNode } from "../xmlCursor";

/** A refusal as it stands over what it covers: its claim, place and detail, which claim what
 *  belongs to the refused thing under the same finding. */
export interface StandingRefusal {
	readonly claim: Claim<"refuse">;
	readonly place: HqPlace;
	readonly detail?: FindingDetail;
	/** The node whose value makes the class, where the refusal's record stands, where that is
	 *  not the refused element itself (`XmlCursor.refuseSubtreeAt`). */
	readonly at?: XmlNode;
}

export interface FormRefusals {
	/** The refusal a node stands under: its own, else the nearest refusal of a subtree that
	 *  holds it. */
	over(node: XmlNode): StandingRefusal | undefined;
	/** Whether the form's cursor claimed the node, or a subtree that holds it. */
	claimed(node: XmlNode): boolean;
}

function parentElement(element: Element): Element | null {
	const parent = element.parent;
	return parent !== null && parent.type === "tag" ? (parent as Element) : null;
}

/** The form's cursor, remembering what it refuses and claims, and the refusals' account. */
export function refusingCursor(cursor: XmlCursor): {
	readonly cursor: XmlCursor;
	readonly refusals: FormRefusals;
} {
	const own = new Map<Element, Map<string, StandingRefusal>>();
	const subtrees = new Map<Element, StandingRefusal>();
	const claimedNodes = new Map<Element, Set<string>>();
	const covered = new Set<Element>();
	const note = (node: XmlNode) => {
		const known = claimedNodes.get(node.element);
		if (known === undefined)
			claimedNodes.set(node.element, new Set([node.attribute ?? ""]));
		else known.add(node.attribute ?? "");
	};
	const refused = (node: XmlNode, refusal: StandingRefusal) => {
		note(node);
		const known = own.get(node.element) ?? new Map<string, StandingRefusal>();
		own.set(node.element, known);
		if (!known.has(node.attribute ?? ""))
			known.set(node.attribute ?? "", refusal);
	};
	const subtree = (element: Element, refusal?: StandingRefusal) => {
		covered.add(element);
		if (refusal !== undefined && !subtrees.has(element))
			subtrees.set(element, refusal);
	};
	const standing = (
		claim: Claim<"refuse">,
		place: HqPlace,
		detail: FindingDetail | undefined,
	): StandingRefusal =>
		detail === undefined ? { claim, place } : { claim, place, detail };

	const wrapped: XmlCursor = {
		artifact: cursor.artifact,
		take(node, claim) {
			note(node);
			return cursor.take(node, claim);
		},
		derived(node, claim) {
			note(node);
			cursor.derived(node, claim);
		},
		drop(node, claim) {
			note(node);
			cursor.drop(node, claim);
		},
		refuse(node, claim, place, detail) {
			refused(node, standing(claim, place, detail));
			cursor.refuse(node, claim, place, detail);
		},
		account(node, claim, place, detail) {
			note(node);
			cursor.account(node, claim, place, detail);
		},
		partOf(node, claim) {
			note(node);
			cursor.partOf(node, claim);
		},
		within(node, claim, keys) {
			cursor.within(node, claim, keys);
		},
		takeSubtree(element, claim) {
			subtree(element);
			return cursor.takeSubtree(element, claim);
		},
		derivedSubtree(element, claim) {
			subtree(element);
			cursor.derivedSubtree(element, claim);
		},
		dropSubtree(element, claim) {
			subtree(element);
			cursor.dropSubtree(element, claim);
		},
		refuseSubtree(element, claim, place, detail) {
			subtree(element, standing(claim, place, detail));
			cursor.refuseSubtree(element, claim, place, detail);
		},
		refuseSubtreeAt(element, at, claim, place, detail) {
			subtree(element, { ...standing(claim, place, detail), at });
			cursor.refuseSubtreeAt(element, at, claim, place, detail);
		},
		accountSubtree(element, claim, place, detail) {
			subtree(element);
			cursor.accountSubtree(element, claim, place, detail);
		},
		handOff(node, to, subject, key) {
			note(node);
			cursor.handOff(node, to, subject, key);
		},
		handOffSubtree(element, to, subject, key) {
			subtree(element);
			cursor.handOffSubtree(element, to, subject, key);
		},
		placeUnclaimed(resolve) {
			cursor.placeUnclaimed(resolve);
		},
		expressionAttributes: () => cursor.expressionAttributes(),
	};

	const refusals: FormRefusals = {
		over(node) {
			const mine = own.get(node.element)?.get(node.attribute ?? "");
			if (mine !== undefined) return mine;
			for (
				let at: Element | null = node.element;
				at !== null;
				at = parentElement(at)
			) {
				const around = subtrees.get(at);
				if (around !== undefined) return around;
				if (covered.has(at)) return undefined;
			}
			return undefined;
		},
		claimed(node) {
			if (claimedNodes.get(node.element)?.has(node.attribute ?? "") === true)
				return true;
			for (
				let at: Element | null = node.element;
				at !== null;
				at = parentElement(at)
			)
				if (covered.has(at)) return true;
			return false;
		},
	};
	return { cursor: wrapped, refusals };
}

/** The attributes of a bind that say what its node does: each belongs to the node's question. */
const BIND_LOGIC = [
	"relevant",
	"required",
	"constraint",
	"calculate",
	"readonly",
	"type",
] as const;

/** Refuses each attribute of a bind that says what its node does and that no claim holds yet,
 *  under the refusal of what the node belongs to. */
export function refuseBindLogic(
	cursor: XmlCursor,
	refusals: FormRefusals,
	bind: Element,
	refusal: StandingRefusal,
): void {
	for (const attribute of BIND_LOGIC)
		if (
			Object.hasOwn(bind.attribs, attribute) &&
			!refusals.claimed({ element: bind, attribute })
		)
			cursor.refuse(
				{ element: bind, attribute },
				refusal.claim,
				refusal.place,
				refusal.detail,
			);
}
