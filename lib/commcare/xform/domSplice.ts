/**
 * Shared DOM-splice mechanics for the source XForm builder and the two
 * build-time post-processors: `builder.ts`, `caseBlocks.ts::addCaseBlocks`,
 * and `metaBlock.ts::addMetaBlock`.
 *
 * Both mirror one CCHQ server-side build step (`xform.py::add_case_and_meta`):
 * they take the clean XForm the expander emits, re-parse it, splice in the wire
 * artifacts CCHQ injects at build time — the `<case>` transaction blocks and the
 * OpenRosa `<meta>` block — and re-serialize. The HQ-upload source (the expander
 * output) carries NEITHER, because CCHQ regenerates both when it renders the app;
 * these post-processors run only on the local `.ccz` path, where there is no CCHQ
 * build step to do it. The source builder also uses the same pointer-safe
 * append/prepend helpers when it places authored case-operation groups. The
 * shared splicing contract therefore lives here rather than being duplicated
 * across emitter and post-processors.
 *
 * The single invariant every helper upholds: every structural edit keeps the
 * `children` array AND the `prev`/`next` linked-list pointers in lockstep.
 * DOM traversal utilities use both representations. `relinkSiblings` re-seats the pointers after
 * each edit; no caller touches `prev`/`next` directly.
 */

import { type ChildNode, Element } from "domhandler";
import { findOne, getChildren } from "domutils";
import { el } from "@/lib/commcare/elementBuilders";
import { serializeXml } from "@/lib/commcare/serializeXml";
import { parseXml } from "../xmlParse";
import { InstanceSink } from "../xpath/wire/instances";

/**
 * The XForm declaration `buildXForm` prepends. Held out of the parse→serialize
 * round-trip (see `parseXForm`) and re-emitted by `serializeXForm`.
 */
const XML_DECLARATION = '<?xml version="1.0"?>';

/** Parse once with XML namespace, character, and attribute-normalization rules.
 * XML declarations stay outside the DOM; serializeXForm emits Nova's fixed
 * declaration after the structural case/meta edits. */
export function parseXForm(xform: string) {
	return parseXml(xform);
}

/**
 * Serialize a spliced DOM back to XForm bytes. `serializeXml` is the single
 * XML-escaping authority, so every interpolated XPath body / identifier flows
 * through one structural pass with no hand-escaping.
 *
 * Re-prepends the `<?xml ...?>` declaration `parseXForm` strips — the same
 * build-without-PI-then-prepend shape `buildXForm` uses.
 */
export function serializeXForm(doc: ReturnType<typeof parseXForm>): string {
	return `${XML_DECLARATION}\n${serializeXml(doc)}`;
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
 * Prepend each child element to the parent, preserving the supplied order and
 * re-seating sibling pointers once after the splice.
 *
 * Case-operation emission uses this for the singular operation group at
 * `/data`: JavaRosa processes submitted case blocks in document order, so the
 * singular scope must precede every operation group nested in a repeat. Repeat
 * groups still append to their exact template after its authored fields.
 */
export function prependChildren(parent: Element, children: Element[]): void {
	for (const child of children) child.parent = parent;
	parent.children.unshift(...children);
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

/** Merge one generated read's instance declaration into the parsed model.
 * The same sink contract as source emission rejects conflicting sources and
 * orders casedb, session, then all other ids together. Existing nodes retain
 * their contents; only their secondary-instance order is normalized. */
export function ensureInstance(model: Element, id: string, src: string): void {
	const byId = new Map<string, Element>();
	const declarations = new InstanceSink();
	for (const child of model.children) {
		if (
			!(child instanceof Element) ||
			child.name !== "instance" ||
			!child.attribs.id
		)
			continue;
		declarations.addOne({ id: child.attribs.id, src: child.attribs.src });
		byId.set(child.attribs.id, child);
	}
	declarations.addOne({ id, src });
	if (!byId.has(id)) byId.set(id, el("instance", { src, id }));
	const remaining = model.children.filter(
		(child) =>
			!(
				child instanceof Element &&
				child.name === "instance" &&
				child.attribs.id
			),
	);
	const primaryIndex = remaining.findIndex(
		(child) => child instanceof Element && child.name === "instance",
	);
	const ordered = declarations.declarations().map((declaration) => {
		const instance = byId.get(declaration.id);
		if (instance === undefined)
			throw new Error("A declared instance has no XML element to splice.");
		instance.parent = model;
		return instance;
	});
	remaining.splice(primaryIndex + 1, 0, ...ordered);
	model.children = remaining;
	relinkSiblings(model.children);
}

/**
 * Walk an ordered children list and re-seat every `prev` / `next` pointer to
 * match the array's index order. Cheaper than tracking adjacency at every splice
 * site. DOM traversal must see the same order as the serialized children.
 */
export function relinkSiblings(children: ChildNode[]): void {
	for (let i = 0; i < children.length; i++) {
		const node = children[i];
		node.prev = i > 0 ? children[i - 1] : null;
		node.next = i < children.length - 1 ? children[i + 1] : null;
	}
}
