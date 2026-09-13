import { allocateCreationIdentities } from "@/lib/agent/authoring/creations";
import type { StagedInputPreparation } from "@/lib/agent/change-set/workspace";
import {
	factDataShapeCarriers,
	type RecordConcept,
} from "@/lib/agent/design/contract";
import type { DesignId } from "@/lib/agent/design/ids";
import { generateSchemaInputSchema } from "@/lib/agent/tools/generateSchema";
import { MAX_AUTHORED_CASE_PROPERTY_NAME_LENGTH } from "@/lib/domain/casePropertyName";
import { slugifyId } from "@/lib/domain/idSlug";
import { proseText } from "@/lib/domain/prose";
import {
	CASE_SCALAR_PROPERTY_NAMES,
	FORBIDDEN_CASE_WRITE_PROPERTIES,
	WRITABLE_STANDARD_CASE_PROPERTIES,
} from "@/lib/domain/standardCaseProperties";
import type { SliceExecutionBrief } from "./executionBrief";

/** Name the complete accepted property set before selecting a workflow's
 * subset. Collisions include generated names and resolve independently of
 * property order. Only the explicit canonical scalar names retain that role. */
export function deriveAcceptedPropertyNames(
	record: RecordConcept,
): ReadonlyMap<DesignId, string> {
	const bases = record.properties.map((property) => {
		if (WRITABLE_STANDARD_CASE_PROPERTIES.has(property.name))
			return property.name;
		let key = slugifyId(property.name, "property");
		if (!/^[a-z]/.test(key)) key = `property_${key}`;
		if (
			FORBIDDEN_CASE_WRITE_PROPERTIES.has(key) ||
			CASE_SCALAR_PROPERTY_NAMES.has(key)
		)
			key = `property_${key}`;
		return key;
	});
	const suffixed = new Set<DesignId>();
	const names = new Map<DesignId, string>();
	for (;;) {
		const owners = new Map<string, DesignId[]>();
		for (const [index, property] of record.properties.entries()) {
			const suffix = suffixed.has(property.id)
				? `_${property.id.replaceAll("-", "")}`
				: "";
			const key = `${bases[index].slice(0, MAX_AUTHORED_CASE_PROPERTY_NAME_LENGTH - suffix.length)}${suffix}`;
			names.set(property.id, key);
			owners.set(key, [...(owners.get(key) ?? []), property.id]);
		}
		let changed = false;
		for (const ids of owners.values()) {
			if (ids.length < 2) continue;
			for (const id of ids)
				if (!suffixed.has(id)) {
					suffixed.add(id);
					changed = true;
				}
		}
		if (!changed) return names;
	}
}

/** Accepted structure needs no model translation. Contextual requirements,
 * validation and lookup binding remain on the forms that use these values. */
export function acceptedRecordCatalogInput(brief: SliceExecutionBrief) {
	return {
		caseTypes: brief.records.map((record) => {
			const realization = brief.recordRealizations.find(
				(item) => item.recordId === record.id,
			);
			if (!realization)
				throw new Error(`Missing accepted record mapping for ${record.id}.`);
			return {
				name: realization.blueprintCaseType,
				...(realization.parentBlueprintCaseType === undefined
					? {}
					: {
							parent_type: realization.parentBlueprintCaseType,
							relationship: "child",
						}),
				properties: record.properties
					.filter(
						(property) =>
							!CASE_SCALAR_PROPERTY_NAMES.has(property.blueprintProperty) ||
							property.blueprintProperty === "case_name",
					)
					.map((property) => {
						if (
							property.dataShape === "unknown" ||
							property.dataShape === "attachment"
						)
							throw new Error(
								`Accepted property ${property.id} has no record storage type.`,
							);
						return {
							name: property.blueprintProperty,
							label: property.name,
							data_type:
								factDataShapeCarriers[property.dataShape].caseDataShapes[0],
							...(property.choices === undefined
								? {}
								: {
										options: property.choices.map(({ value, label }) => ({
											value,
											label,
										})),
									}),
						};
					}),
			};
		}),
	};
}

/** Runs after receipt lookup. A later workflow may use a property whose
 * label or defaults were refined earlier; keep that authored definition.
 * Shared catalog tools and the ordinary private workspace own all writes. */
export const prepareAcceptedRecordCatalog: StagedInputPreparation = async (
	ctx,
	input,
) => {
	const authored = input as ReturnType<typeof acceptedRecordCatalogInput>;
	const caseTypes = authored.caseTypes.map((record) => {
		const existing = ctx.snapshot.doc.caseTypes?.find(
			(item) => item.name === record.name,
		);
		if (!existing) return record;
		if (existing.parent_type !== record.parent_type)
			throw new Error(
				`Accepted record ${record.name} has a different parent in the current app.`,
			);
		const existingNames = new Set(
			existing.properties.map((property) => property.name),
		);
		return {
			...record,
			properties: record.properties.filter(
				(property) => !existingNames.has(property.name),
			),
		};
	});
	const canonical = {
		caseTypes: caseTypes.map((record) => ({
			...record,
			properties: record.properties.map((property) => ({
				...property,
				label: proseText(property.label),
				...(property.options === undefined
					? {}
					: {
							options: property.options.map((option) => ({
								...option,
								label: proseText(option.label),
							})),
						}),
			})),
		})),
	};
	allocateCreationIdentities("generateSchema", canonical);
	return { input: generateSchemaInputSchema.parse(canonical) };
};
