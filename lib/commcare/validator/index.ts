/**
 * Deep XPath validation — Lezer-based syntax, semantics, and reference checking.
 *
 * Operates directly on the normalized `BlueprintDoc`. Validates every XPath
 * expression on every field via a Lezer tree walk (syntax + semantics),
 * detects dependency cycles, and checks case-property references.
 *
 * Called by `runner.ts`, which wraps the string output into structured
 * `ValidationError` objects.
 */

import type { BlueprintDoc, Field, Uuid } from "@/lib/domain";
import {
	buildFieldTree,
	type FieldTreeNode,
} from "@/lib/preview/engine/fieldTree";
import { TriggerDag } from "@/lib/preview/engine/triggerDag";
import { validateXPath } from "./xpathValidator";

/**
 * Keys on a `Field` that hold XPath expressions. Narrowed to known string
 * properties; we read via an index access below which safely returns
 * `undefined` for kinds that don't carry a given key.
 */
const XPATH_FIELDS = [
	"relevant",
	"validate",
	"calculate",
	"default_value",
	"required",
] as const;

type XPathFieldKey = (typeof XPATH_FIELDS)[number];

/**
 * Safely read an XPath-bearing property off a Field union member without
 * having to narrow the discriminant first. Returns the string if the
 * variant carries the key AND the value is a non-empty string, else
 * `undefined`.
 */
function readXPath(field: Field, key: XPathFieldKey): string | undefined {
	const value = (field as unknown as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Walk a field subtree (rooted at `parentUuid`) and collect every valid
 * `/data/...` path that XPath expressions may reference. The prefix is
 * extended by each container's `id` as the walk recurses.
 */
export function collectValidPaths(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	prefix = "/data",
): Set<string> {
	const paths = new Set<string>();
	const order = doc.fieldOrder[parentUuid] ?? [];
	for (const uuid of order) {
		const field = doc.fields[uuid];
		if (!field) continue;
		const path = `${prefix}/${field.id}`;
		paths.add(path);
		// Container kinds (group, repeat) carry a fieldOrder entry — recurse
		// under their semantic `id` segment.
		if (doc.fieldOrder[uuid] !== undefined) {
			for (const p of collectValidPaths(doc, uuid, path)) paths.add(p);
		}
	}
	return paths;
}

/**
 * Collect case-property names saved to a given case type across the whole
 * app. Walks modules with the target case type AND any parent module whose
 * case type is the parent of the target (child-case creation lives on the
 * parent module's fields via a non-matching `case_property_on`).
 *
 * The per-field filter (`field.case_property_on === caseType`) ensures only
 * properties targeting the requested type are collected, even when walking
 * a parent module whose own fields save to its primary type.
 */
export function collectCaseProperties(
	doc: BlueprintDoc,
	moduleCaseType: string | undefined,
): Set<string> | undefined {
	if (!moduleCaseType) return undefined;
	const props = new Set<string>();

	// Which module caseTypes to walk: the target + its parent (if any).
	const moduleTypes = new Set([moduleCaseType]);
	const ct = doc.caseTypes?.find((c) => c.name === moduleCaseType);
	if (ct?.parent_type) moduleTypes.add(ct.parent_type);

	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (!mod.caseType || !moduleTypes.has(mod.caseType)) continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			collectFromTree(doc, formUuid, moduleCaseType, props);
		}
	}
	return props.size > 0 ? props : undefined;
}

function collectFromTree(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	moduleCaseType: string,
	props: Set<string>,
): void {
	const order = doc.fieldOrder[parentUuid] ?? [];
	for (const uuid of order) {
		const field = doc.fields[uuid];
		if (!field) continue;
		const casePropertyOf = (field as { case_property_on?: string })
			.case_property_on;
		if (casePropertyOf === moduleCaseType) props.add(field.id);
		if (doc.fieldOrder[uuid] !== undefined) {
			collectFromTree(doc, uuid, moduleCaseType, props);
		}
	}
}

/**
 * Deep validation: walks every form, builds the valid path set + case
 * property set per form, validates every XPath expression, and runs cycle
 * detection via `TriggerDag`. Returns a flat array of human-readable error
 * strings — `runner.ts` parses these back into structured `ValidationError`s.
 */
export function validateBlueprintDeep(doc: BlueprintDoc): string[] {
	const errors: string[] = [];

	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		const caseProps = collectCaseProperties(doc, mod.caseType);

		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			const tree = buildFieldTree(formUuid, doc.fields, doc.fieldOrder);
			if (tree.length === 0) continue;

			const validPaths = collectValidPaths(doc, formUuid);

			// Expose Connect data paths so XPath expressions can reference them
			// (only when app-level connect_type is set and the form has connect wiring).
			if (doc.connectType && form.connect) {
				const c = form.connect;
				if (c.learn_module) {
					validPaths.add(`/data/${c.learn_module.id || "connect_learn"}`);
				}
				if (c.assessment) {
					validPaths.add(
						`/data/${c.assessment.id || "connect_assessment"}/assessment/user_score`,
					);
				}
				if (c.deliver_unit) {
					const duId = c.deliver_unit.id || "connect_deliver";
					validPaths.add(`/data/${duId}/deliver/entity_id`);
					validPaths.add(`/data/${duId}/deliver/entity_name`);
				}
			}

			// Per-field XPath validation — recursive walk over the tree.
			validateTreeXPath(
				tree,
				validPaths,
				caseProps,
				form.name,
				mod.name,
				errors,
			);

			// Connect-block XPath expressions (only when app-level connect_type is set).
			if (doc.connectType && form.connect) {
				const connectXPaths: Array<[string, string]> = [];
				if (form.connect.assessment?.user_score) {
					connectXPaths.push([
						"Connect assessment user_score",
						form.connect.assessment.user_score,
					]);
				}
				if (form.connect.deliver_unit?.entity_id) {
					connectXPaths.push([
						"Connect deliver entity_id",
						form.connect.deliver_unit.entity_id,
					]);
				}
				if (form.connect.deliver_unit?.entity_name) {
					connectXPaths.push([
						"Connect deliver entity_name",
						form.connect.deliver_unit.entity_name,
					]);
				}
				for (const [label, expr] of connectXPaths) {
					const xpathErrors = validateXPath(expr, validPaths, caseProps);
					for (const err of xpathErrors) {
						errors.push(
							`"${form.name}" in "${mod.name}" ${label}: ${err.message}`,
						);
					}
				}
			}

			// Cycle detection runs on the engine's `FieldTreeNode` shape — the
			// same rose tree we already built.
			const dag = new TriggerDag();
			const cycles = dag.reportCycles(tree);
			for (const cycle of cycles) {
				const cyclePath = cycle.join(" → ");
				errors.push(
					`"${form.name}" in "${mod.name}" has a circular dependency: ${cyclePath}`,
				);
			}
		}
	}

	return errors;
}

/**
 * Recursively validate every XPath expression on every field in the
 * provided rose tree. Errors are formatted as the human-readable strings
 * the runner's regex-driven decoder expects — any format change here must
 * be mirrored in `runner.ts`'s parser.
 */
function validateTreeXPath(
	nodes: FieldTreeNode[],
	validPaths: Set<string>,
	caseProperties: Set<string> | undefined,
	formName: string,
	moduleName: string,
	errors: string[],
): void {
	for (const node of nodes) {
		for (const key of XPATH_FIELDS) {
			const expr = readXPath(node.field, key);
			if (!expr) continue;
			const xpathErrors = validateXPath(expr, validPaths, caseProperties);
			for (const err of xpathErrors) {
				errors.push(
					`Field "${node.field.id}" in "${formName}": ${key} expression error — ${err.message}`,
				);
			}
		}
		if (node.children) {
			validateTreeXPath(
				node.children,
				validPaths,
				caseProperties,
				formName,
				moduleName,
				errors,
			);
		}
	}
}
