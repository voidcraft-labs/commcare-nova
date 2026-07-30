/**
 * Full-text search across a `BlueprintDoc`.
 *
 * Pure query — consumed by both the chat sidebar's search hook
 * (`useSearchBlueprint`) and the SA's `searchBlueprint` tool. Lives under
 * `lib/doc/` because that's the canonical home for `BlueprintDoc`-reading
 * queries that both client and server callers share; placing it in
 * `lib/agent/` (server-only) would pull a client hook's import across the
 * server/client boundary.
 */

import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	expressionSource,
	expressionSourceEntries,
	isContainer,
} from "@/lib/domain";
import {
	orderedFieldUuids,
	orderedFormUuids,
	orderedModuleUuids,
} from "./fieldWalk";

interface SearchMatch {
	/** Which property matched (e.g. 'label', 'case_property_on', 'id', 'name'). */
	field: string;
	/** The matched value. */
	value: string;
	/** Human-readable projection of the current names and immutable identities. */
	context: string;
}

/**
 * A single match from `searchBlueprint`.
 *
 * Each arm exposes exactly the stable UUIDs required to address that entity.
 * Result order follows the current visual order, but display positions, paths,
 * and generic identity keys are deliberately absent: callers can pass these
 * type-specific handles directly to the matching read or mutation tool without
 * translating a mutable projection back into identity.
 */
export type SearchResult =
	| (SearchMatch & { type: "module"; moduleUuid: Uuid })
	| (SearchMatch & {
			type: "form";
			moduleUuid: Uuid;
			formUuid: Uuid;
	  })
	| (SearchMatch & {
			type: "field";
			moduleUuid: Uuid;
			formUuid: Uuid;
			fieldUuid: Uuid;
	  })
	| (SearchMatch & {
			type: "case_list_column";
			moduleUuid: Uuid;
			columnUuid: Uuid;
	  })
	| (SearchMatch & {
			type: "search_input";
			moduleUuid: Uuid;
			searchInputUuid: Uuid;
	  });

/**
 * Full-text search across the entire blueprint.
 *
 * Walks modules → forms → fields in current display order, plus case-list
 * columns and search inputs. Each hit records the type-specific immutable
 * identities a follow-up call needs and current names as display context.
 */
export function searchBlueprint(
	doc: BlueprintDoc,
	query: string,
): SearchResult[] {
	const results: SearchResult[] = [];
	const q = query.toLowerCase();

	// Display order controls only result ordering. Stable UUIDs identify hits.
	const moduleUuids = orderedModuleUuids(doc);
	for (const moduleUuid of moduleUuids) {
		const mod = doc.modules[moduleUuid];
		if (!mod) continue;

		if (mod.name.toLowerCase().includes(q)) {
			results.push({
				type: "module",
				moduleUuid,
				field: "name",
				value: mod.name,
				context: `Module "${mod.name}" [uuid ${moduleUuid}]`,
			});
		}
		if (mod.caseType?.toLowerCase().includes(q)) {
			results.push({
				type: "module",
				moduleUuid,
				field: "case_type",
				value: mod.caseType,
				context: `Module "${mod.name}" [uuid ${moduleUuid}] case_type`,
			});
		}

		/* Case-list columns + search inputs. Module-level strings the
		 * SA searches when looking up a case-property reference or a
		 * search-input handle. Each column carries `header` + (for
		 * non-calc kinds) `field`; calc columns carry only `header`,
		 * so the search shape branches on `kind`. */
		const config = mod.caseListConfig;
		for (const col of config?.columns ?? []) {
			const headerMatch = col.header.toLowerCase().includes(q);
			const fieldMatch =
				col.kind !== "calculated" && col.field.toLowerCase().includes(q);
			if (headerMatch || fieldMatch) {
				const value =
					col.kind === "calculated"
						? `(calculated) ${col.header}`
						: `${col.field} (${col.header})`;
				results.push({
					type: "case_list_column",
					moduleUuid,
					columnUuid: col.uuid,
					field: "column",
					value,
					context: `Module "${mod.name}" [uuid ${moduleUuid}] column "${col.header}" [uuid ${col.uuid}]`,
				});
			}
		}
		for (const input of config?.searchInputs ?? []) {
			const labelMatch = input.label.toLowerCase().includes(q);
			const nameMatch = input.name.toLowerCase().includes(q);
			const propertyMatch =
				input.kind === "simple" && input.property.toLowerCase().includes(q);
			if (labelMatch || nameMatch || propertyMatch) {
				const value =
					input.kind === "simple"
						? `${input.name} → ${input.property} (${input.label})`
						: `${input.name} (advanced) (${input.label})`;
				results.push({
					type: "search_input",
					moduleUuid,
					searchInputUuid: input.uuid,
					field: "search_input",
					value,
					context: `Module "${mod.name}" [uuid ${moduleUuid}] search input "${input.label}" [uuid ${input.uuid}]`,
				});
			}
		}

		const formUuids = orderedFormUuids(doc, moduleUuid);
		for (const formUuid of formUuids) {
			const form = doc.forms[formUuid];
			if (!form) continue;
			if (form.name.toLowerCase().includes(q)) {
				results.push({
					type: "form",
					moduleUuid,
					formUuid,
					field: "name",
					value: form.name,
					context: `Module "${mod.name}" [uuid ${moduleUuid}] form "${form.name}" [uuid ${formUuid}] (${form.type})`,
				});
			}
			searchFields(
				doc,
				moduleUuid,
				formUuid,
				formUuid,
				q,
				results,
				mod.name,
				form.name,
			);
		}
	}

	return results;
}

/** Recursive field-tree search used by `searchBlueprint`. Walks in visual
 *  (ordered) sequence so the result list matches form layout. */
function searchFields(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formUuid: Uuid,
	parentUuid: Uuid,
	query: string,
	results: SearchResult[],
	moduleName: string,
	formName: string,
): void {
	// Visual (display) sequence, so the surfaced result list matches form
	// layout and any reported field ordering agrees with the wire/preview.
	const order = orderedFieldUuids(doc, parentUuid);
	for (const uuid of order) {
		const field = doc.fields[uuid];
		if (!field) continue;
		const matchFields: Array<{ field: string; value: string }> = [];

		if (field.id.toLowerCase().includes(query)) {
			matchFields.push({ field: "id", value: field.id });
		}
		const label = expressionSource(field, "label", doc);
		if (label?.toLowerCase().includes(query)) {
			matchFields.push({ field: "label", value: label });
		}
		const anyField = field as Record<string, unknown>;
		if (
			typeof anyField.case_property_on === "string" &&
			field.id.toLowerCase().includes(query)
		) {
			matchFields.push({
				field: "case_property_on",
				value: `${field.id}→${anyField.case_property_on}`,
			});
		}
		// The expression slots this search surface covers — a UX choice of
		// which slots are worth surfacing, not a slot-resolution list (the
		// accessor owns that).
		for (const key of [
			"validate",
			"relevant",
			"calculate",
			"default_value",
			"validate_msg",
			"hint",
		] as const) {
			const v = expressionSource(field, key, doc);
			if (v?.toLowerCase().includes(query)) {
				matchFields.push({ field: key, value: v });
			}
		}
		// Option labels read through the fan-out accessor; each entry's
		// index pairs the label with its option's sibling `value` literal
		// (a data literal, not an expression slot — read directly).
		const opts =
			(field.kind === "single_select" || field.kind === "multi_select") &&
			field.optionsSource.kind === "inline"
				? field.optionsSource.options
				: undefined;
		if (opts !== undefined) {
			const labelByOption = new Map<number, string>();
			for (const entry of expressionSourceEntries(field, "option_label", doc)) {
				const index = entry.indices[0];
				if (index !== undefined) labelByOption.set(index, entry.text);
			}
			for (let i = 0; i < opts.length; i++) {
				const o = opts[i];
				const optLabel = labelByOption.get(i);
				if (
					(typeof o.value === "string" &&
						o.value.toLowerCase().includes(query)) ||
					optLabel?.toLowerCase().includes(query)
				) {
					matchFields.push({
						field: "option",
						value: `${String(o.value)}: ${optLabel}`,
					});
					break;
				}
			}
		}

		for (const match of matchFields) {
			const caseTag =
				typeof anyField.case_property_on === "string"
					? `, case_property_on:${anyField.case_property_on}`
					: "";
			results.push({
				type: "field",
				moduleUuid,
				formUuid,
				fieldUuid: uuid,
				field: match.field,
				value: match.value,
				context: `Module "${moduleName}" [uuid ${moduleUuid}] form "${formName}" [uuid ${formUuid}] field "${field.id}" [uuid ${uuid}] (${field.kind}${caseTag})`,
			});
		}

		if (isContainer(field)) {
			searchFields(
				doc,
				moduleUuid,
				formUuid,
				uuid,
				query,
				results,
				moduleName,
				formName,
			);
		}
	}
}
