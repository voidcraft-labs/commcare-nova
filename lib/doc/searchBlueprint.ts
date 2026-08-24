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
	childModuleUuids,
	expressionInspectionSource,
	expressionSurfaceReads,
	fieldCaseWrite,
	isContainer,
	projectedModulePreorder,
} from "@/lib/domain";
import { orderedFieldUuids, orderedFormUuids } from "./fieldWalk";

interface SearchMatch {
	/** Which property matched (e.g. 'label', 'caseWrite', 'id', 'name'). */
	field: string;
	/** The matched value. */
	value: string;
	/** Human-readable projection of the current names. */
	context: string;
}

/**
 * A single match from `searchBlueprint`.
 *
 * Each arm carries exactly the stable UUIDs needed to address that entity, so
 * a caller passes them straight to the matching read or mutation tool. Result
 * order follows current display order, but positions, paths, and a generic
 * identity key are deliberately absent: a machine-facing address is a UUID
 * named for what it addresses, never a position that a peer's reorder moves.
 */
export type SearchResult =
	| (SearchMatch & {
			type: "module";
			moduleUuid: Uuid;
			parentModuleUuid: Uuid | null;
			childModuleUuids: Uuid[];
	  })
	| (SearchMatch & { type: "form"; moduleUuid: Uuid; formUuid: Uuid })
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
 * Walks modules → forms → fields plus case-list and case-detail columns. Each
 * hit records display-order context for readability and stable UUID identity
 * for every follow-up mutation.
 */
export function searchBlueprint(
	doc: BlueprintDoc,
	query: string,
): SearchResult[] {
	const results: SearchResult[] = [];
	const q = query.toLowerCase();

	// Display order controls only result ordering. Stable UUIDs identify hits.
	const moduleUuids = projectedModulePreorder(doc);
	for (let mIdx = 0; mIdx < moduleUuids.length; mIdx++) {
		const moduleUuid = moduleUuids[mIdx];
		const mod = doc.modules[moduleUuid];
		if (!mod) continue;
		const menuPath = moduleMenuPath(doc, moduleUuid);

		if (mod.name.toLowerCase().includes(q)) {
			results.push({
				type: "module",
				moduleUuid,
				parentModuleUuid: mod.parentModuleUuid ?? null,
				childModuleUuids: childModuleUuids(doc, moduleUuid),
				field: "name",
				value: mod.name,
				context: `Menu ${menuPath}`,
			});
		}
		if (mod.caseType?.toLowerCase().includes(q)) {
			results.push({
				type: "module",
				moduleUuid,
				parentModuleUuid: mod.parentModuleUuid ?? null,
				childModuleUuids: childModuleUuids(doc, moduleUuid),
				field: "case_type",
				value: mod.caseType,
				context: `Menu ${menuPath} case_type`,
			});
		}

		/* Case-list columns + search inputs. Module-level strings the
		 * SA searches when looking up a case-property reference or a
		 * search-input handle. Each column carries `header` + (for
		 * non-calc kinds) `field`; calc columns carry only `header`,
		 * so the search shape branches on `kind`. A column match
		 * carries `columnUuid` and a search-input match `searchInputUuid`,
		 * each alongside the owning `moduleUuid`. */
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
					context: `Menu ${menuPath} > column "${col.header}"`,
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
					context: `Menu ${menuPath} > search input "${input.label}"`,
				});
			}
		}

		const formUuids = orderedFormUuids(doc, moduleUuid);
		for (let fIdx = 0; fIdx < formUuids.length; fIdx++) {
			const formUuid = formUuids[fIdx];
			const form = doc.forms[formUuid];
			if (!form) continue;
			if (form.name.toLowerCase().includes(q)) {
				results.push({
					type: "form",
					moduleUuid,
					formUuid,
					field: "name",
					value: form.name,
					context: `Menu ${menuPath} > Form "${form.name}" (${form.type})`,
				});
			}
			searchFields(
				doc,
				formUuid,
				q,
				moduleUuid,
				formUuid,
				`Menu ${menuPath} > Form "${form.name}"`,
				results,
			);
		}
	}

	return results;
}

function moduleMenuPath(doc: BlueprintDoc, moduleUuid: Uuid): string {
	const module = doc.modules[moduleUuid];
	if (module === undefined) return `"${moduleUuid}"`;
	const parent =
		module.parentModuleUuid === undefined
			? undefined
			: doc.modules[module.parentModuleUuid];
	return parent === undefined
		? `"${module.name}"`
		: `"${parent.name}" > "${module.name}"`;
}

/** Recursive field-tree search used by `searchBlueprint`. Walks in visual
 *  (ordered) sequence so the result list matches form layout. */
function searchFields(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	query: string,
	moduleUuid: Uuid,
	formUuid: Uuid,
	formContext: string,
	results: SearchResult[],
): void {
	// Visual (display) sequence, so the surfaced result list matches form
	// layout and any reported field ordering agrees with the wire/preview.
	const order = orderedFieldUuids(doc, parentUuid);
	for (const fieldUuid of order) {
		const field = doc.fields[fieldUuid];
		if (!field) continue;
		const matchFields: Array<{ field: string; value: string }> = [];

		if (field.id.toLowerCase().includes(query)) {
			matchFields.push({ field: "id", value: field.id });
		}
		const label = expressionInspectionSource(field, "label", doc);
		if (label?.toLowerCase().includes(query)) {
			matchFields.push({ field: "label", value: label });
		}
		const caseWrite = fieldCaseWrite(field);
		const savesTo =
			caseWrite === undefined
				? undefined
				: `${caseWrite.caseType}/${caseWrite.property}`;
		if (savesTo?.toLowerCase().includes(query)) {
			matchFields.push({
				field: "caseWrite",
				value: savesTo,
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
			const v = expressionInspectionSource(field, key, doc);
			if (v?.toLowerCase().includes(query)) {
				matchFields.push({ field: key, value: v });
			}
		}
		// Option labels read through the fan-out accessor; each entry's
		// index pairs the label with its option's sibling `value` literal
		// (a data literal, not an expression slot — read directly).
		const opts =
			"optionsSource" in field && field.optionsSource.kind === "inline"
				? field.optionsSource.options
				: [];
		if (opts.length > 0) {
			const labelByOption = new Map<number, string>();
			for (const entry of expressionSurfaceReads(field, "prose", doc)) {
				if (entry.slot !== "option_label") continue;
				const index = entry.indices[0];
				if (index !== undefined) labelByOption.set(index, entry.text);
			}
			for (let i = 0; i < opts.length; i++) {
				const o = opts[i];
				const optLabel = labelByOption.get(i);
				if (
					o.value.toLowerCase().includes(query) ||
					optLabel?.toLowerCase().includes(query)
				) {
					matchFields.push({
						field: "option",
						value: `${o.value}: ${optLabel}`,
					});
					break;
				}
			}
		}

		for (const match of matchFields) {
			const caseTag = savesTo === undefined ? "" : `, saves-to:${savesTo}`;
			results.push({
				type: "field",
				moduleUuid,
				formUuid,
				fieldUuid,
				field: match.field,
				value: match.value,
				context: `${formContext} > Field "${field.id}" (${field.kind}${caseTag})`,
			});
		}

		if (isContainer(field)) {
			searchFields(
				doc,
				fieldUuid,
				query,
				moduleUuid,
				formUuid,
				formContext,
				results,
			);
		}
	}
}
