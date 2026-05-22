/**
 * Post-expansion XForm XML validator.
 *
 * Parses generated XForm XML and checks that all internal references resolve:
 * - Bind nodesets point to existing instance nodes
 * - Body control refs point to existing instance nodes
 * - SetValue targets point to existing instance nodes
 * - itext references in labels/hints resolve to defined text IDs
 * - Output tags have valid ref/value attributes
 *
 * Uses htmlparser2 (already in project) with xmlMode for DOM parsing.
 * This catches bugs in our XForm generator that would cause FormPlayer
 * to reject the form during a CommCare HQ build.
 */

import type { Document, Element } from "domhandler";
import { findAll, getAttributeValue, getChildren, isTag } from "domutils";
import { XMLValidator } from "fast-xml-parser";
import { parseDocument } from "htmlparser2";
import {
	type ValidationError,
	type ValidationLocation,
	validationError,
} from "./errors";

const XML_OPTS = { xmlMode: true } as const;

// ── Instance node path collection ──────────────────────────────────

/** Recursively collect all valid nodesets from the instance data tree —
 *  both element paths and the `@attribute` paths attached to each
 *  element. Setvalue / bind refs may target any attribute slot (e.g.
 *  query-bound repeats write `@ids`, `@count`, `@current_index`, per-
 *  iteration `@index` and `@id`); excluding any subset here would
 *  false-positive on legitimate refs. Namespace prefixes (`jr:template`,
 *  `vellum:role`, etc.) are kept verbatim because the prefix is part
 *  of the attribute name in the parsed DOM. */
function collectInstancePaths(
	el: Element,
	prefix: string,
	paths: Set<string>,
): void {
	for (const child of getChildren(el)) {
		if (!isTag(child)) continue;
		const path = `${prefix}/${child.name}`;
		paths.add(path);
		for (const attrName of Object.keys(child.attribs)) {
			paths.add(`${path}/@${attrName}`);
		}
		collectInstancePaths(child, path, paths);
	}
}

// ── itext ID collection ────────────────────────────────────────────

function collectItextIds(doc: Document): Set<string> {
	const ids = new Set<string>();
	const textEls = findAll((el) => el.name === "text", doc.children);
	for (const el of textEls) {
		const id = getAttributeValue(el, "id");
		if (id) ids.add(id);
	}
	return ids;
}

// ── itext duplicate-definition detection ──────────────────────────

/** Direct element children of `el` with the given tag name. Used where the
 *  check must mirror Core's direct-child iteration rather than a subtree
 *  search (`findAll` recurses; Core's itext parser does not). */
function directChildElementsNamed(el: Element, name: string): Element[] {
	return getChildren(el).filter(
		(c): c is Element => isTag(c) && c.name === name,
	);
}

/**
 * Detect duplicate itext (id, form) definitions within each translation.
 *
 * JavaRosa (XFormParser.java::parseTextHandle) rejects any form where the
 * same (id, form) key appears twice in a single <translation> block. The
 * dedup key mirrors Core's textID formula: `id` for the default form (when
 * `form` is absent or empty), `id + ";" + form` for named forms. Empty
 * `form=""` normalizes to the default, exactly as Core does.
 *
 * Uniqueness is scoped per-translation — the same id legitimately appears
 * in every locale's <translation> block. Nova emits both <value> (default)
 * and <value form="markdown"> under each <text id="...">; those are distinct
 * keys and must not be flagged.
 *
 * Each <translation> gets its own key set, which assumes one <translation>
 * per language — the shape Nova emits (a single `<translation lang="en">`).
 * Core additionally rejects two <translation> blocks for the same language
 * (XFormParser.java::parseTranslations); Nova never emits that, so this
 * oracle doesn't separately guard it. If multi-locale emission ever lands,
 * collapse the key set per language rather than per <translation> element.
 *
 * The <text>/<value> walks use DIRECT children (not a subtree search) to
 * mirror Core's `text.getElement(k)` direct-child iteration exactly: a
 * <value> nested deeper than a direct child is not a text-handle definition
 * to Core and must not be counted here. Non-<value> direct children of <text>
 * (which Core's parseTextHandle rejects outright) are simply skipped — this
 * check is scoped to duplicate definitions, and the emitter never emits any
 * other child kind, so guarding it here would be dead defense.
 */
function findDuplicateItextDefinitions(
	doc: Document,
	formName: string,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const translationEls = findAll(
		(el) => el.name === "translation",
		doc.children,
	);

	for (const translation of translationEls) {
		const lang = getAttributeValue(translation, "lang") ?? "unknown";
		const seenKeys = new Set<string>();

		const textEls = directChildElementsNamed(translation, "text");
		for (const textEl of textEls) {
			const id = getAttributeValue(textEl, "id");
			if (!id) continue;

			// Walk each direct <value> child and check the (id, form) dedup key.
			const valueEls = directChildElementsNamed(textEl, "value");
			for (const valueEl of valueEls) {
				const rawForm = getAttributeValue(valueEl, "form") ?? "";
				// Normalize empty form="" to the default key shape, matching Core.
				const dedupKey = rawForm === "" ? id : `${id};${rawForm}`;

				if (seenKeys.has(dedupKey)) {
					const formDesc = rawForm === "" ? "" : ` (form="${rawForm}")`;
					errors.push(
						validationError(
							"XFORM_DUPLICATE_ITEXT",
							"form",
							`"${formName}" defines itext id "${id}"${formDesc} more than once in the "${lang}" translation. FormPlayer will reject this form. This is a bug in the form generator.`,
							loc,
						),
					);
				} else {
					seenKeys.add(dedupKey);
				}
			}
		}
	}

	return errors;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Validate a generated XForm XML string.
 * Returns structured errors for any reference mismatches found.
 */
export function validateXFormXml(
	xml: string,
	formName: string,
	moduleName: string,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const loc = { formName, moduleName };

	// 1a. Strict well-formedness gate — the only parse-failure path.
	//
	// htmlparser2 (used for the DOM walk below) is an HTML-recovery parser: it
	// silently heals malformed XML (unescaped `<` in label text, bare `&`,
	// unclosed tags) instead of throwing, so it can't be relied on to reject a
	// malformed form. fast-xml-parser's XMLValidator is a strict XML 1.0
	// validator that returns an error object for any well-formedness violation,
	// matching how JavaRosa's XFormParser rejects the form at parse time.
	const xmlValidation = XMLValidator.validate(xml);
	if (xmlValidation !== true) {
		errors.push(
			validationError(
				"XFORM_PARSE_ERROR",
				"form",
				`"${formName}" generated malformed XML that FormPlayer will reject: ${xmlValidation.err.msg}. This is a bug in the form generator.`,
				loc,
			),
		);
		return errors;
	}

	// 1b. Parse with htmlparser2 for the DOM walk. The strict gate above already
	// proved the input well-formed, and htmlparser2 recovers rather than throws
	// regardless, so no parse-failure handling is needed here.
	const doc = parseDocument(xml, XML_OPTS);

	// 2. Find the instance data root
	const instances = findAll(
		(el) => el.name === "instance" && !getAttributeValue(el, "src"),
		doc.children,
	);
	if (instances.length === 0) {
		errors.push(
			validationError(
				"XFORM_NO_INSTANCE",
				"form",
				`"${formName}" is missing the main <instance> element. This is a bug in the form generator.`,
				loc,
			),
		);
		return errors;
	}

	const mainInstance = instances[0];
	const dataEl = getChildren(mainInstance).find((c) => isTag(c)) as
		| Element
		| undefined;
	if (!dataEl) {
		errors.push(
			validationError(
				"XFORM_NO_INSTANCE",
				"form",
				`"${formName}" has an empty <instance> with no data element. This is a bug in the form generator.`,
				loc,
			),
		);
		return errors;
	}

	// Collect all valid paths from instance tree
	const validPaths = new Set<string>();
	const rootPath = `/${dataEl.name}`;
	validPaths.add(rootPath);
	collectInstancePaths(dataEl, rootPath, validPaths);

	// 3. Validate bind nodesets
	const binds = findAll((el) => el.name === "bind", doc.children);
	for (const bind of binds) {
		const nodeset = getAttributeValue(bind, "nodeset");
		if (!nodeset) {
			errors.push(
				validationError(
					"XFORM_BIND_NO_NODESET",
					"form",
					`"${formName}" has a <bind> element with no nodeset attribute. FormPlayer requires every bind to have a nodeset. This is a bug in the form generator.`,
					loc,
				),
			);
			continue;
		}
		// Skip binds to secondary instances (they reference external data)
		if (!nodeset.startsWith(`/${dataEl.name}`)) continue;
		if (!validPaths.has(nodeset)) {
			errors.push(
				validationError(
					"XFORM_DANGLING_BIND",
					"form",
					`"${formName}" has a <bind> pointing to "${nodeset}" but that node doesn't exist in the form's data model. FormPlayer will reject this form. This is a bug in the form generator.`,
					loc,
				),
			);
		}
	}

	// 4. Validate body control refs
	const controlTags = [
		"input",
		"select",
		"select1",
		"trigger",
		"upload",
		"group",
		"repeat",
	];
	const controls = findAll((el) => controlTags.includes(el.name), doc.children);
	for (const ctrl of controls) {
		const ref =
			getAttributeValue(ctrl, "ref") || getAttributeValue(ctrl, "nodeset");
		if (!ref) continue;
		if (!ref.startsWith(`/${dataEl.name}`)) continue;
		if (!validPaths.has(ref)) {
			errors.push(
				validationError(
					"XFORM_DANGLING_REF",
					"form",
					`"${formName}" has a <${ctrl.name}> control pointing to "${ref}" but that node doesn't exist in the form's data model. FormPlayer will reject this form. This is a bug in the form generator.`,
					loc,
				),
			);
		}
	}

	// 5. Validate setvalue targets
	const setvalues = findAll((el) => el.name === "setvalue", doc.children);
	for (const sv of setvalues) {
		const ref = getAttributeValue(sv, "ref");
		if (!ref) {
			errors.push(
				validationError(
					"XFORM_SETVALUE_NO_TARGET",
					"form",
					`"${formName}" has a <setvalue> with no target ref attribute. FormPlayer requires setvalue elements to target a node. This is a bug in the form generator.`,
					loc,
				),
			);
			continue;
		}
		if (!ref.startsWith(`/${dataEl.name}`)) continue;
		if (!validPaths.has(ref)) {
			errors.push(
				validationError(
					"XFORM_DANGLING_REF",
					"form",
					`"${formName}" has a <setvalue> targeting "${ref}" but that node doesn't exist in the form's data model. FormPlayer will reject this form. This is a bug in the form generator.`,
					loc,
				),
			);
		}
	}

	// 6. Validate itext references
	const itextIds = collectItextIds(doc);
	if (itextIds.size > 0) {
		const itextRefs = findAll((el) => {
			const ref = getAttributeValue(el, "ref");
			return !!ref && ref.startsWith("jr:itext('");
		}, doc.children);

		for (const el of itextRefs) {
			const ref = getAttributeValue(el, "ref");
			if (!ref) continue;
			const match = ref.match(/^jr:itext\('([^']+)'\)$/);
			if (!match) continue;
			const textId = match[1];
			if (!itextIds.has(textId)) {
				errors.push(
					validationError(
						"XFORM_MISSING_ITEXT",
						"form",
						`"${formName}" references itext ID "${textId}" but no <text id="${textId}"> exists in the translations. FormPlayer will fail to display this label. This is a bug in the form generator.`,
						loc,
					),
				);
			}
		}
	}

	// 7. Check for duplicate itext (id, form) definitions within each translation.
	errors.push(...findDuplicateItextDefinitions(doc, formName, loc));

	return errors;
}
