import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { z } from "zod";
import type { CaseRow } from "@/lib/case-store";
import { type BlueprintDoc, materializableCaseTypes } from "@/lib/domain";
import { caseTypeToJsonSchema } from "@/lib/domain/predicate/jsonSchema";
import { FormEvaluationInputError } from "@/lib/preview/engine/formEvaluationTypes";
import type { CaseDatabaseSnapshot } from "@/lib/preview/engine/xpathInstances";

const identity = z
	.string()
	.min(1)
	.max(200)
	.refine((value) => value.trim().length > 0);
const timestamp = z.iso.datetime({ offset: true }).optional();
export const evaluationScenarioSchema = z
	.object({
		records: z
			.array(
				z
					.object({
						id: identity,
						caseType: identity,
						name: z.string().min(1).max(1000).optional(),
						parentId: identity.optional(),
						properties: z
							.record(
								z.string().min(1).max(200),
								z.union([
									z.string().max(10_000),
									z.number(),
									z.array(z.string().max(10_000)).max(100),
								]),
							)
							.optional(),
						openedOn: timestamp,
						modifiedOn: timestamp,
						closedOn: timestamp,
						externalId: identity.optional(),
					})
					.strict(),
			)
			.max(200),
	})
	.strict()
	.refine(
		(value) => JSON.stringify(value).length <= 1_000_000,
		"Test records exceed the evaluation size limit.",
	)
	.describe(
		"Test records available to this form, replacing actual records for this evaluation only. IDs are your own labels; parentId refers to another supplied record. Properties use the app's declared names and types. Nothing is saved.",
	);

export type EvaluationScenario = z.infer<typeof evaluationScenarioSchema>;

/** An explicit test population, never combined with the worker's real rows.
 * Property admission uses the same derived schema as stored cases. */
export function evaluationScenarioCases(
	doc: BlueprintDoc,
	ownerId: string,
	scenario: EvaluationScenario,
): CaseDatabaseSnapshot {
	const ajv = new Ajv2020({ strict: false, strictNumbers: true });
	addFormats(ajv);
	const types = new Map(
		materializableCaseTypes(doc).map((type) => [type.name, type]),
	);
	const validators = new Map(
		[...types].map(([name, type]) => [
			name,
			ajv.compile(caseTypeToJsonSchema(type)),
		]),
	);
	const records = new Map(
		scenario.records.map((record) => [record.id, record]),
	);
	if (records.size !== scenario.records.length)
		throw new FormEvaluationInputError("Each test record needs a distinct ID.");
	const rows: CaseRow[] = [];
	const indices: CaseDatabaseSnapshot["indices"][number][] = [];
	for (const record of scenario.records) {
		const type = types.get(record.caseType);
		const validate = validators.get(record.caseType);
		if (!type || !validate)
			throw new FormEvaluationInputError(
				`Test record ${record.id} uses an unknown case type: ${record.caseType}.`,
			);
		const properties = record.properties ?? {};
		if (!validate(properties))
			throw new FormEvaluationInputError(
				`Test record ${record.id} has invalid properties: ${ajv.errorsText(validate.errors)}.`,
			);
		if (record.parentId !== undefined) {
			const parent = records.get(record.parentId);
			if (
				!parent ||
				parent.id === record.id ||
				type.parent_type !== parent.caseType
			)
				throw new FormEvaluationInputError(
					`Test record ${record.id} needs a supplied parent of its declared parent type.`,
				);
			indices.push({
				case_id: record.id,
				ancestor_id: parent.id,
				target_case_type: parent.caseType,
				identifier: "parent",
				relationship: type.relationship ?? "child",
				depth: 1,
			});
		}
		rows.push({
			case_id: record.id,
			app_id: doc.appId,
			case_type: record.caseType,
			owner_id: ownerId,
			case_name: record.name ?? record.id,
			status: record.closedOn ? "closed" : "open",
			opened_on: record.openedOn ? new Date(record.openedOn) : null,
			modified_on: record.modifiedOn ? new Date(record.modifiedOn) : null,
			closed_on: record.closedOn ? new Date(record.closedOn) : null,
			external_id: record.externalId ?? null,
			parent_case_id: record.parentId ?? null,
			properties,
		});
	}
	for (const record of records.values()) {
		const seen = new Set<string>();
		let current: typeof record | undefined = record;
		while (current) {
			if (seen.has(current.id))
				throw new FormEvaluationInputError(
					"Test records contain a parent cycle.",
				);
			seen.add(current.id);
			current = current.parentId ? records.get(current.parentId) : undefined;
		}
	}
	return { rows, indices };
}
