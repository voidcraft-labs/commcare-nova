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
import { isContainer } from "@/lib/domain";

/**
 * A single match from `searchBlueprint`. The surface preserves the
 * positional index shape (`moduleIndex`, `formIndex`) so SA tool output
 * remains stable and human-readable; the `uuid` field lets callers
 * target follow-up mutations directly without re-resolving by index.
 *
 * For case-list matches (`case_list_column` and `search_input`), the
 * `uuid` is the entity's own uuid — the column or search input the
 * atomic-op tools consume directly. The `containerUuid` carries the
 * owning module's uuid so the caller has both handles in one record.
 */
export interface SearchResult {
	type: "module" | "form" | "field" | "case_list_column" | "search_input";
	moduleIndex: number;
	formIndex?: number;
	/** Slash-delimited path of field ids within the containing form.
	 *  Absent for module-level and form-level matches. */
	fieldPath?: string;
	/** Stable uuid of the matched entity — lets callers target
	 *  mutations. For columns / search inputs, this is the entry's own
	 *  uuid (consumed by `updateCaseListColumn` / `removeCaseListColumn` /
	 *  `updateSearchInput` / `removeSearchInput`). */
	uuid?: Uuid;
	/** Owning module's uuid — surfaced on case-list matches so callers
	 *  hold the (column-uuid, module-uuid) pair the atomic-op tools
	 *  need together. */
	containerUuid?: Uuid;
	/** Which property matched (e.g. 'label', 'case_property_on', 'id', 'name'). */
	field: string;
	/** The matched value. */
	value: string;
	/** Human-readable location string. */
	context: string;
}

/**
 * Full-text search across the entire blueprint.
 *
 * Walks modules → forms → fields (via the ordered indices) plus case-list
 * and case-detail columns. Each hit records the positional context
 * (moduleIndex / formIndex / fieldPath) so the result list is human-
 * readable, and also records the entity uuid so follow-up mutations can
 * target it directly.
 */
export function searchBlueprint(
	doc: BlueprintDoc,
	query: string,
): SearchResult[] {
	const results: SearchResult[] = [];
	const q = query.toLowerCase();

	for (let mIdx = 0; mIdx < doc.moduleOrder.length; mIdx++) {
		const moduleUuid = doc.moduleOrder[mIdx];
		const mod = doc.modules[moduleUuid];
		if (!mod) continue;

		if (mod.name.toLowerCase().includes(q)) {
			results.push({
				type: "module",
				moduleIndex: mIdx,
				uuid: moduleUuid,
				field: "name",
				value: mod.name,
				context: `Module ${mIdx} "${mod.name}"`,
			});
		}
		if (mod.caseType?.toLowerCase().includes(q)) {
			results.push({
				type: "module",
				moduleIndex: mIdx,
				uuid: moduleUuid,
				field: "case_type",
				value: mod.caseType,
				context: `Module ${mIdx} "${mod.name}" case_type`,
			});
		}

		/* Case-list columns + search inputs. Module-level strings the
		 * SA searches when looking up a case-property reference or a
		 * search-input handle. Each column carries `header` + (for
		 * non-calc kinds) `field`; calc columns carry only `header`,
		 * so the search shape branches on `kind`. The match's `uuid`
		 * is the entry's own uuid; the owning module is surfaced as
		 * `containerUuid` so the caller has both handles. */
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
					moduleIndex: mIdx,
					uuid: col.uuid,
					containerUuid: moduleUuid,
					field: "column",
					value,
					context: `Module ${mIdx} "${mod.name}" column "${col.header}"`,
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
					moduleIndex: mIdx,
					uuid: input.uuid,
					containerUuid: moduleUuid,
					field: "search_input",
					value,
					context: `Module ${mIdx} "${mod.name}" search input "${input.label}"`,
				});
			}
		}

		const formUuids = doc.formOrder[moduleUuid] ?? [];
		for (let fIdx = 0; fIdx < formUuids.length; fIdx++) {
			const formUuid = formUuids[fIdx];
			const form = doc.forms[formUuid];
			if (!form) continue;
			if (form.name.toLowerCase().includes(q)) {
				results.push({
					type: "form",
					moduleIndex: mIdx,
					formIndex: fIdx,
					uuid: formUuid,
					field: "name",
					value: form.name,
					context: `m${mIdx}-f${fIdx} "${form.name}" (${form.type})`,
				});
			}
			searchFields(doc, formUuid, q, mIdx, fIdx, results, "");
		}
	}

	return results;
}

/** Recursive field-tree search used by `searchBlueprint`. Walks in visual
 *  (ordered) sequence so the result list matches form layout. */
function searchFields(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	query: string,
	mIdx: number,
	fIdx: number,
	results: SearchResult[],
	pathPrefix: string,
): void {
	const order = doc.fieldOrder[parentUuid] ?? [];
	for (const uuid of order) {
		const field = doc.fields[uuid];
		if (!field) continue;
		const path = pathPrefix ? `${pathPrefix}/${field.id}` : field.id;
		const matchFields: Array<{ field: string; value: string }> = [];

		if (field.id.toLowerCase().includes(query)) {
			matchFields.push({ field: "id", value: field.id });
		}
		if ("label" in field && field.label?.toLowerCase().includes(query)) {
			matchFields.push({ field: "label", value: field.label });
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
		for (const key of [
			"validate",
			"relevant",
			"calculate",
			"default_value",
			"validate_msg",
			"hint",
		] as const) {
			const v = anyField[key];
			if (typeof v === "string" && v.toLowerCase().includes(query)) {
				matchFields.push({ field: key, value: v });
			}
		}
		const opts = anyField.options;
		if (Array.isArray(opts)) {
			for (const opt of opts) {
				const o = opt as { value?: unknown; label?: unknown };
				if (
					(typeof o.value === "string" &&
						o.value.toLowerCase().includes(query)) ||
					(typeof o.label === "string" && o.label.toLowerCase().includes(query))
				) {
					matchFields.push({
						field: "option",
						value: `${String(o.value)}: ${String(o.label)}`,
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
				moduleIndex: mIdx,
				formIndex: fIdx,
				fieldPath: path,
				uuid,
				field: match.field,
				value: match.value,
				context: `m${mIdx}-f${fIdx} field "${field.id}" (${field.kind}${caseTag})`,
			});
		}

		if (isContainer(field)) {
			searchFields(doc, uuid, query, mIdx, fIdx, results, path);
		}
	}
}
