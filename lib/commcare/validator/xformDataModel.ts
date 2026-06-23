/**
 * Shared structural model of a parsed XForm — the single DOM walk both
 * the XForm parse-time oracle and the binding-resolution oracle read off.
 *
 * `buildXFormDataModel` parses the XML, locates the main `<instance>` (the
 * one without a `src` — secondary instances declare `src` and reference
 * external data), and walks the data subtree once to collect:
 *
 *   - every reachable instance path (element + `@attribute` slots),
 *   - the subset of those paths whose element carries `jr:template` (the
 *     wire-space equivalent of Core's repeatable-set template marker),
 *   - the set of every `<text id>` defined under any `<translation>`,
 *   - every `<instance id="..."/>` declared in `<model>` (the set the
 *     binding-resolution oracle checks `instance('X')` references against).
 *
 * Lives in its own file so the binding-resolution oracle can reuse the
 * model without depending on the XForm parse-time oracle's contract. Both
 * oracles run against the same parsed form during `compileCcz`; sharing
 * the walk avoids the second DOM traversal.
 */

import { type Document, type Element, isTag } from "domhandler";
import { findAll, getAttributeValue, getChildren } from "domutils";
import { XMLValidator } from "fast-xml-parser";
import { parseDocument } from "htmlparser2";
import { type ValidationError, validationError } from "./errors";

/**
 * The local (unprefixed) part of a parsed element name. htmlparser2 keeps
 * the namespace prefix in `Element.name` (`orx:meta`, not `meta`), and
 * JavaRosa resolves nodesets by local name, so paths in the data model are
 * keyed by the local name. Shared with the XForm parse-time oracle.
 */
export function localName(name: string): string {
	const colon = name.indexOf(":");
	return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * Direct `<instance>` element children of `<model>`. The XForm spec scopes
 * `<instance>` declarations to the model block; an element named `instance`
 * appearing deeper in the document is a data-tree node, not a declaration,
 * and reading its `id` attribute as a declared instance would suppress
 * legitimate "undeclared instance" errors. Searching descendant `<model>`
 * elements covers both the typical `h:head > model` layout and any future
 * deviation. JavaRosa's `XFormParser` is structurally equivalent — its
 * `parseInstance` call sites all root from the model element.
 */
function findInstanceDeclarations(doc: Document): Element[] {
	const out: Element[] = [];
	for (const model of findAll((e) => e.name === "model", doc.children)) {
		for (const child of getChildren(model)) {
			if (isTag(child) && child.name === "instance") {
				out.push(child);
			}
		}
	}
	return out;
}

const XML_OPTS = { xmlMode: true } as const;

/**
 * Parsed XForm shape every invariant reads off.
 */
export interface XFormDataModel {
	/** Parsed document (well-formedness already proven by the strict gate). */
	readonly doc: Document;
	/** The main `<instance>`'s data root element (`<data>`). */
	readonly dataEl: Element;
	/** Root path of the main instance (`/data`, or whatever the root is named). */
	readonly rootPath: string;
	/**
	 * Every reachable instance path — element paths AND the `@attribute` paths
	 * attached to each element. Setvalue / bind refs may target any attribute
	 * slot (query-bound repeats write `@ids`/`@count`/`@current_index` on the
	 * outer node, `@index`/`@id` on the per-iteration `<item>`); excluding any
	 * subset would false-positive on legitimate refs.
	 */
	readonly instancePaths: ReadonlySet<string>;
	/**
	 * Instance paths whose element carries `jr:template` — i.e. the template
	 * node of a repeatable set. Wire-space equivalent of Core's
	 * `TreeElement.isRepeatable()` (Core marks a node repeatable when it sees
	 * the `jr:template` multiplicity at `XFormParser.java::saveInstanceNode`).
	 */
	readonly repeatablePaths: ReadonlySet<string>;
	/** Every `<text id>` defined in any `<translation>`. */
	readonly itextIds: ReadonlySet<string>;
	/**
	 * Every `<instance id="...">` declaration in `<model>` — the set of
	 * instance ids the binding-resolution oracle treats as available for
	 * `instance('X')` references. The main `<instance>` has no `id` by
	 * emission convention and is intentionally excluded; callers compare its
	 * data tree against `instancePaths` rather than treating it as a declared
	 * external instance.
	 */
	readonly declaredInstanceIds: ReadonlySet<string>;
}

/**
 * Recursively collect element paths, `@attr` paths, and repeatable-node paths
 * from the instance data tree. Namespace prefixes (`jr:template`,
 * `vellum:role`, etc.) are kept verbatim on attribute paths because the prefix
 * is part of the attribute name in the parsed DOM.
 *
 * A node is repeatable when it carries the `jr:template` attribute — that is
 * how the wire encodes Core's repeatable-set template node.
 */
function walkInstance(
	el: Element,
	prefix: string,
	paths: Set<string>,
	repeatable: Set<string>,
): void {
	for (const child of getChildren(el)) {
		if (!isTag(child)) continue;
		// Path steps are LOCAL names: JavaRosa resolves a nodeset by local
		// name (`TreeElement::getChild`), so a namespaced element like the
		// `<orx:meta>` metadata block is addressed as `/data/meta/...`, not
		// `/data/orx:meta/...`. Building the model with the local name keeps it
		// in lockstep with the refs the emitter writes (and with how the
		// canonical CCHQ form addresses its own `<orx:meta>`).
		const path = `${prefix}/${localName(child.name)}`;
		paths.add(path);
		for (const attrName of Object.keys(child.attribs)) {
			paths.add(`${path}/@${attrName}`);
		}
		if (getAttributeValue(child, "jr:template") !== undefined) {
			repeatable.add(path);
		}
		walkInstance(child, path, paths, repeatable);
	}
}

/** Collect every `<text id>` defined under any `<translation>`. */
function collectItextIds(doc: Document): Set<string> {
	const ids = new Set<string>();
	for (const el of findAll((e) => e.name === "text", doc.children)) {
		const id = getAttributeValue(el, "id");
		if (id) ids.add(id);
	}
	return ids;
}

/**
 * Collect every `<instance id="...">` declaration in `<model>`. The main
 * instance is intentionally excluded — it has no `id` attribute by emission
 * convention, and callers compare its data tree against `instancePaths`
 * rather than checking it as a declared external instance.
 */
function collectDeclaredInstanceIds(doc: Document): Set<string> {
	const ids = new Set<string>();
	for (const el of findInstanceDeclarations(doc)) {
		const id = getAttributeValue(el, "id");
		if (id) ids.add(id);
	}
	return ids;
}

/**
 * Build the shared model. Returns either the model on success, or a single
 * fatal `ValidationError` (well-formedness, missing main instance, or empty
 * main instance) — the caller short-circuits the rest of its invariants in
 * that case rather than throwing.
 */
export function buildXFormDataModel(
	xml: string,
	formName: string,
	moduleName: string,
): { model: XFormDataModel } | { fatal: ValidationError } {
	const loc = { formName, moduleName };

	const xmlValidation = XMLValidator.validate(xml);
	if (xmlValidation !== true) {
		return {
			fatal: validationError(
				"XFORM_PARSE_ERROR",
				"form",
				`"${formName}" generated malformed XML that FormPlayer will reject: ${xmlValidation.err.msg}. This is a bug in the form generator.`,
				loc,
			),
		};
	}

	const doc = parseDocument(xml, XML_OPTS);

	const instances = findInstanceDeclarations(doc).filter(
		(el) => !getAttributeValue(el, "src"),
	);
	if (instances.length === 0) {
		return {
			fatal: validationError(
				"XFORM_NO_INSTANCE",
				"form",
				`"${formName}" is missing the main <instance> element. This is a bug in the form generator.`,
				loc,
			),
		};
	}

	const dataEl = getChildren(instances[0]).find((c) => isTag(c)) as
		| Element
		| undefined;
	if (!dataEl) {
		return {
			fatal: validationError(
				"XFORM_NO_INSTANCE",
				"form",
				`"${formName}" has an empty <instance> with no data element. This is a bug in the form generator.`,
				loc,
			),
		};
	}

	const rootPath = `/${localName(dataEl.name)}`;
	const instancePaths = new Set<string>([rootPath]);
	const repeatablePaths = new Set<string>();
	walkInstance(dataEl, rootPath, instancePaths, repeatablePaths);

	return {
		model: {
			doc,
			dataEl,
			rootPath,
			instancePaths,
			repeatablePaths,
			itextIds: collectItextIds(doc),
			declaredInstanceIds: collectDeclaredInstanceIds(doc),
		},
	};
}
