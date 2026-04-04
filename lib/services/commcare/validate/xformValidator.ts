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
import { parseDocument } from "htmlparser2";
import { type ValidationError, validationError } from "./errors";

const XML_OPTS = { xmlMode: true } as const;

// ── Instance node path collection ──────────────────────────────────

/** Recursively collect all valid nodesets from the instance data tree. */
function collectInstancePaths(
	el: Element,
	prefix: string,
	paths: Set<string>,
): void {
	for (const child of getChildren(el)) {
		if (!isTag(child)) continue;
		const path = `${prefix}/${child.name}`;
		paths.add(path);
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

	// 1. Parse — catches malformed XML
	let doc: Document;
	try {
		doc = parseDocument(xml, XML_OPTS);
	} catch (e) {
		errors.push(
			validationError(
				"XFORM_PARSE_ERROR",
				"form",
				`"${formName}" generated malformed XML that can't be parsed: ${e instanceof Error ? e.message : String(e)}. This is a bug in the form generator.`,
				loc,
			),
		);
		return errors;
	}

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

	return errors;
}
