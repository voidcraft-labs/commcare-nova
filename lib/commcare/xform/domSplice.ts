/**
 * Shared DOM-splice mechanics for the two build-time XForm post-processors:
 * `caseBlocks.ts::addCaseBlocks` and `metaBlock.ts::addMetaBlock`.
 *
 * Both mirror one CCHQ server-side build step (`xform.py::add_case_and_meta`):
 * they take the clean XForm the expander emits, re-parse it, splice in the wire
 * artifacts CCHQ injects at build time — the `<case>` transaction blocks and the
 * OpenRosa `<meta>` block — and re-serialize. The HQ-upload source (the expander
 * output) carries NEITHER, because CCHQ regenerates both when it renders the app;
 * these post-processors run only on the local `.ccz` path, where there is no CCHQ
 * build step to do it. So the shared splicing contract lives here, in one place
 * both callers consume, rather than duplicated across the two.
 *
 * The single invariant every helper upholds: every structural edit keeps the
 * `children` array AND the `prev`/`next` linked-list pointers in lockstep.
 * `dom-serializer` walks both in parallel, so a stale pointer on either side
 * corrupts the serialized bytes. `relinkSiblings` re-seats the pointers after
 * each edit; no caller touches `prev`/`next` directly.
 */

import render from "dom-serializer";
import { type ChildNode, Element } from "domhandler";
import { findOne, getChildren } from "domutils";
import { parseDocument } from "htmlparser2";
import { el, RENDER_OPTS } from "@/lib/commcare/elementBuilders";

/**
 * Parse contract for the round-trip. Mirrors `validator/xformDataModel.ts`'s
 * parse options — the post-injection XForm oracle re-parses what these
 * post-processors emit under the same options, so the byte-level round-trip is
 * the contract on both sides.
 */
export const PARSE_OPTS = { xmlMode: true } as const;

/**
 * Re-parse a serialized XForm into a mutable DOM the splice helpers operate on.
 * The parsed document carries the input's `<?xml ...?>` processing instruction,
 * which `serializeXForm` renders back verbatim.
 */
export function parseXForm(xform: string) {
	return parseDocument(xform, PARSE_OPTS);
}

/**
 * Serialize a spliced DOM back to XForm bytes. `dom-serializer` is the single
 * XML-escaping authority, so every interpolated XPath body / identifier flows
 * through one structural pass with no hand-escaping.
 *
 * Unlike the from-scratch `buildXForm` emitter — which prepends the XML
 * declaration because the serializer doesn't emit one — these post-processors
 * serialize a tree the parser already populated with the input's `<?xml ...?>`
 * PI. The serializer renders that PI verbatim, so prepending another declaration
 * would produce two and trip the XML well-formedness gate ("XML declaration
 * allowed only at the start of the document").
 */
export function serializeXForm(doc: ReturnType<typeof parseXForm>): string {
	return render(doc, RENDER_OPTS);
}

/**
 * Resolve the form's primary `<data>` instance node. The emitter
 * (`xform/builder.ts`) emits exactly one `<data>` element under the only
 * `<instance>` with no `id` attribute, so the match against the document tree is
 * unambiguous. A missing `<data>` is a compiler-bug invariant (the emitter would
 * have failed first), not a fixable authoring state — `caller` names the
 * post-processor so the thrown message points at the right splice site.
 */
export function findDataElement(
	doc: ReturnType<typeof parseXForm>,
	caller: string,
): Element {
	const dataEl = findOne((elem) => elem.name === "data", doc.children, true);
	if (dataEl === null) {
		throw new Error(
			`${caller} could not find a <data> element in the XForm. The form ` +
				`emitter guarantees exactly one top-level <data> per form, so a ` +
				`missing one means the form bytes were corrupted between buildXForm ` +
				`and ${caller}. Re-run the compile from a clean expandDoc.`,
		);
	}
	return dataEl;
}

/**
 * Resolve the form's `<model>` element — where `<bind>`, `<setvalue>`, and
 * secondary `<instance>` declarations live. Same one-per-form invariant and
 * compiler-bug-on-miss contract as `findDataElement`.
 */
export function findModelElement(
	doc: ReturnType<typeof parseXForm>,
	caller: string,
): Element {
	const modelEl = findOne((elem) => elem.name === "model", doc.children, true);
	if (modelEl === null) {
		throw new Error(
			`${caller} could not find a <model> element in the XForm. The form ` +
				`emitter guarantees exactly one <model> per form, so a missing one ` +
				`means the form bytes were corrupted between buildXForm and ` +
				`${caller}. Re-run the compile from a clean expandDoc.`,
		);
	}
	return modelEl;
}

/**
 * Append each child element to the parent, re-seating sibling pointers once
 * after all appends.
 */
export function appendChildren(parent: Element, children: Element[]): void {
	for (const child of children) child.parent = parent;
	parent.children.push(...children);
	relinkSiblings(parent.children);
}

/**
 * Append one node at the end of `parent.children`. Used by the `<itext>`-absent
 * fallback in `insertBeforeItext`. Same pointer-relinking contract as
 * `appendChildren`.
 */
export function appendNode(parent: Element, node: ChildNode): void {
	node.parent = parent;
	parent.children.push(node);
	relinkSiblings(parent.children);
}

/**
 * Insert a node list into `<model>` just before its `<itext>` child (when
 * present) so the model preserves the canonical child order: instance /
 * secondary instances / binds / setvalues / itext. With no `<itext>` (a shape
 * Nova never actually emits, but tolerated defensively), the nodes are appended
 * at the end.
 */
export function insertBeforeItext(model: Element, nodes: ChildNode[]): void {
	const itextIndex = getChildren(model).findIndex(
		(child) => child instanceof Element && child.name === "itext",
	);
	if (itextIndex === -1) {
		for (const node of nodes) appendNode(model, node);
		return;
	}
	// Splice the nodes at the `<itext>` slot — pushing `<itext>` (and anything
	// after it) one position rightward — then re-seat every sibling pointer from
	// the freshly ordered array.
	model.children.splice(itextIndex, 0, ...nodes);
	for (const node of nodes) node.parent = model;
	relinkSiblings(model.children);
}

/**
 * Declare a secondary `<instance src id>` on `<model>` if it isn't already
 * present, inserted immediately after the last existing `<instance>` so it joins
 * the secondary-instance group (the canonical model child order is instance /
 * secondary instances / binds / setvalues / itext).
 *
 * Idempotent by `id`: a form that already declares the instance (because a field
 * XPath referenced it, so `buildXForm`'s instance scan emitted it) is left
 * untouched, and the element shape matches `buildXForm`'s own instance emission,
 * so whichever path declares it produces the identical element. Position among
 * sibling instances is JavaRosa-irrelevant.
 */
export function ensureInstance(model: Element, id: string, src: string): void {
	const children = getChildren(model);
	const already = children.some(
		(child) =>
			child instanceof Element &&
			child.name === "instance" &&
			child.attribs.id === id,
	);
	if (already) return;

	let lastInstanceIndex = -1;
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (child instanceof Element && child.name === "instance") {
			lastInstanceIndex = i;
		}
	}

	const instance = el("instance", { src, id });
	instance.parent = model;
	// After the last instance when one exists (always — the primary data
	// instance); fall back to the front otherwise.
	model.children.splice(lastInstanceIndex + 1, 0, instance);
	relinkSiblings(model.children);
}

/**
 * Walk an ordered children list and re-seat every `prev` / `next` pointer to
 * match the array's index order. Cheaper than tracking adjacency at every splice
 * site, and `dom-serializer` walks both the array and the linked-list pointers,
 * so leaving the pointers stale would corrupt the serialized output.
 */
export function relinkSiblings(children: ChildNode[]): void {
	for (let i = 0; i < children.length; i++) {
		const node = children[i];
		node.prev = i > 0 ? children[i - 1] : null;
		node.next = i < children.length - 1 ? children[i + 1] : null;
	}
}
