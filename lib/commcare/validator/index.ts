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
import { buildConnectSlugMap } from "../connectSlugs";
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

	// Wire-final Connect ids per form (capped, deduped). Reading from the
	// same resolver the expander uses keeps the valid-path set in lockstep
	// with the ids the XForm builder actually emits — a user XPath that
	// references a Connect data path resolves against the real node, not an
	// uncapped one that the wire would never produce. Empty for
	// non-Connect apps and forms without a Connect block.
	const connectSlugs = buildConnectSlugMap(doc);

	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		const caseProps = collectCaseProperties(doc, mod.caseType);

		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			const tree = buildFieldTree(formUuid, doc.fields, doc.fieldOrder);
			if (tree.length === 0) continue;

			const validPaths = collectValidPaths(doc, formUuid);

			// The resolved Connect config (capped, deduped ids), or
			// `undefined` when this form has no wire-emitted Connect block —
			// the map entry exists only when `connectType` is set AND the form
			// carries connect wiring, so its presence replaces the prior
			// explicit gate.
			const connect = connectSlugs.get(formUuid);

			// Expose Connect data paths so XPath expressions can reference them.
			if (connect) {
				if (connect.learn_module) {
					validPaths.add(`/data/${connect.learn_module.id}`);
				}
				if (connect.assessment) {
					validPaths.add(
						`/data/${connect.assessment.id}/assessment/user_score`,
					);
				}
				if (connect.deliver_unit) {
					const duId = connect.deliver_unit.id;
					validPaths.add(`/data/${duId}/deliver/entity_id`);
					validPaths.add(`/data/${duId}/deliver/entity_name`);
				}
			}

			// Per-field XPath validation — recursive walk over the tree.
			validateTreeXPath(tree, validPaths, caseProps, form.name, errors);

			// Connect-block XPath expressions. The expressions themselves
			// (`user_score`, `entity_id`, `entity_name`) are id-independent, so
			// reading them off the resolved config matches the raw doc value.
			if (connect) {
				const connectXPaths: Array<[string, string]> = [];
				if (connect.assessment?.user_score) {
					connectXPaths.push([
						"Connect assessment user_score",
						connect.assessment.user_score,
					]);
				}
				if (connect.deliver_unit?.entity_id) {
					connectXPaths.push([
						"Connect deliver entity_id",
						connect.deliver_unit.entity_id,
					]);
				}
				if (connect.deliver_unit?.entity_name) {
					connectXPaths.push([
						"Connect deliver entity_name",
						connect.deliver_unit.entity_name,
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
		// Repeat-mode XPath fields. `repeat_count` lives only on the
		// count_bound variant of the discriminated repeat union, and
		// `data_source.ids_query` only on query_bound — neither fits the
		// flat `XPATH_FIELDS` reader (one is variant-specific, the other
		// is nested). Discriminated-union narrowing handles both. Empty
		// values are caught by `EMPTY_REPEAT_COUNT` / `EMPTY_IDS_QUERY`
		// at the field-rule layer; the length check here skips them so
		// the SA doesn't see double-reporting on a single empty value.
		// Error keys stay flat (`repeat_count`, `ids_query`) so the
		// runner's `\w+` decode regex matches; the human-friendly key →
		// label map in `runner.ts` translates them for the user.
		if (node.field.kind === "repeat") {
			// Both branches use `typeof === "string" && trim().length > 0`
			// to match the empty-rule layer's defensive shape exactly:
			// trim catches whitespace-only inputs the same way the empty
			// rule does (so the SA never sees double-reporting on
			// whitespace), and the typeof guard defends against partial
			// or hand-built docs that bypass Zod — fixture builders, the
			// replay hydrator, recovery scripts — and could land here
			// with `repeat_mode` set but the matching XPath field
			// undefined. Without the typeof guard, `.trim()` on
			// undefined throws and kills `validateBlueprintDeep`
			// mid-walk, dropping every error already collected.
			if (node.field.repeat_mode === "count_bound") {
				const repeatCount = node.field.repeat_count;
				if (typeof repeatCount === "string" && repeatCount.trim().length > 0) {
					const xpathErrors = validateXPath(
						repeatCount,
						validPaths,
						caseProperties,
					);
					for (const err of xpathErrors) {
						errors.push(
							`Field "${node.field.id}" in "${formName}": repeat_count expression error — ${err.message}`,
						);
					}
				}
			} else if (node.field.repeat_mode === "query_bound") {
				const idsQuery = node.field.data_source?.ids_query;
				if (typeof idsQuery === "string" && idsQuery.trim().length > 0) {
					const xpathErrors = validateXPath(
						idsQuery,
						validPaths,
						caseProperties,
					);
					for (const err of xpathErrors) {
						errors.push(
							`Field "${node.field.id}" in "${formName}": ids_query expression error — ${err.message}`,
						);
					}
				}
			}
		}
		if (node.children) {
			validateTreeXPath(
				node.children,
				validPaths,
				caseProperties,
				formName,
				errors,
			);
		}
	}
}
