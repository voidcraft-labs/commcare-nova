import type { z } from "zod";
import { strictWireJsonSchema } from "@/lib/agent/strictStructuredOutput";
import { lookupRevisionSchema } from "@/lib/lookup/schema";
import { designArtifactWorkspaceOperationSchema } from "./artifactWorkspaceOperations";
import type { DesignArtifactWorkspaceState } from "./artifactWorkspaceStore";
import {
	appDesignContractBaseSchema,
	type ExistingLookupChoiceSource,
	existingLookupChoiceSourceSchema,
} from "./contract";
import {
	mapDesignSchemaSlots,
	projectDesignIdentityHandles,
} from "./identityProjection";
import { EXISTING_LOOKUP_CHOICE_SCHEMA_MARKER } from "./lookupChoiceAttestation";
import type {
	DesignLoopToolDeps,
	DesignProjectDataInspectionResult,
} from "./loop/tools";

export function projectDesignDataInspection(
	result: DesignProjectDataInspectionResult,
) {
	if (result.kind !== "rows" || result.choiceProjection === undefined)
		return result;
	const { inspection, ...projection } = result.choiceProjection;
	return {
		...result,
		choiceProjection: {
			...projection,
			rowCount: inspection.rowCount,
			distinctValueCount: inspection.distinctValueCount,
			invalidValueCount: inspection.invalidValueCount,
			blankLabelCount: inspection.blankLabelCount,
			duplicateValueCount: inspection.duplicateValueCount,
		},
	};
}

/** The author selects data, not the evidence that proves its contents. */
export const authoredLookupChoiceSourceSchema = existingLookupChoiceSourceSchema
	.omit({ inspection: true })
	.extend({ tableRevision: lookupRevisionSchema });
type AuthoredSource = z.infer<typeof authoredLookupChoiceSourceSchema>;

function authoredSource(source: ExistingLookupChoiceSource): AuthoredSource {
	const { inspection, ...reference } = source;
	return { ...reference, tableRevision: inspection.tableRevision };
}

function sourceKey(source: AuthoredSource): string {
	return JSON.stringify([
		source.tableId,
		source.valueColumnId,
		source.labelColumnId,
		source.tableRevision,
	]);
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function lookupChoiceAuthoringWireSchema(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(lookupChoiceAuthoringWireSchema);
	if (!object(node)) return node;
	if (node[EXISTING_LOOKUP_CHOICE_SCHEMA_MARKER] === true) {
		const { [EXISTING_LOOKUP_CHOICE_SCHEMA_MARKER]: _marker, ...wire } =
			strictWireJsonSchema(authoredLookupChoiceSourceSchema) as Record<
				string,
				unknown
			>;
		return wire;
	}
	return Object.fromEntries(
		Object.entries(node).map(([key, value]) => [
			key,
			lookupChoiceAuthoringWireSchema(value),
		]),
	);
}

export function projectDesignAuthoringValues(
	schema: z.ZodType,
	value: unknown,
	bindings: Parameters<typeof projectDesignIdentityHandles>[2],
): unknown {
	const names = projectDesignIdentityHandles(schema, value, bindings);
	return mapDesignSchemaSlots(
		schema,
		names,
		EXISTING_LOOKUP_CHOICE_SCHEMA_MARKER,
		(entry) => authoredSource(existingLookupChoiceSourceSchema.parse(entry)),
	);
}

/** Reuse authoritative snapshots from the existing operation history so a
 * replay still resolves after another update removes a source. Fresh sources
 * bind through the authorized Project reader. Finalization and acceptance
 * retain their independent checks against current data. */
export async function bindDesignLookupEvidence(args: {
	schema: z.ZodType;
	input: unknown;
	workspace: Pick<
		DesignArtifactWorkspaceState,
		"candidate" | "sourceContract" | "operations"
	>;
	inspectProjectData: DesignLoopToolDeps["inspectProjectData"];
}): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
	const requests = new Map<string, AuthoredSource>();
	let invalid: string | undefined;
	mapDesignSchemaSlots(
		args.schema,
		args.input,
		EXISTING_LOOKUP_CHOICE_SCHEMA_MARKER,
		(entry, path) => {
			const parsed = authoredLookupChoiceSourceSchema.safeParse(entry);
			if (!parsed.success)
				invalid ??= `${path.join(".")}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`;
			else requests.set(sourceKey(parsed.data), parsed.data);
			return entry;
		},
	);
	if (invalid !== undefined) return { ok: false, error: invalid };
	if (requests.size === 0) return { ok: true, value: args.input };
	const evidence = new Map<string, ExistingLookupChoiceSource>();
	const collect = (schema: z.ZodType, value: unknown) => {
		mapDesignSchemaSlots(
			schema,
			value,
			EXISTING_LOOKUP_CHOICE_SCHEMA_MARKER,
			(entry) => {
				const source = existingLookupChoiceSourceSchema.parse(entry);
				evidence.set(sourceKey(authoredSource(source)), source);
				return entry;
			},
		);
	};
	collect(appDesignContractBaseSchema, args.workspace.sourceContract);
	for (const operation of args.workspace.operations)
		collect(designArtifactWorkspaceOperationSchema, operation);
	collect(appDesignContractBaseSchema, args.workspace.candidate);
	for (const [key, request] of requests) {
		if (evidence.has(key)) continue;
		const result = await args.inspectProjectData({
			tableId: request.tableId,
			choiceProjection: {
				valueColumnId: request.valueColumnId,
				labelColumnId: request.labelColumnId,
			},
		});
		if (result.kind === "error") return { ok: false, error: result.error };
		if (result.kind !== "rows" || result.choiceProjection === undefined)
			return {
				ok: false,
				error: "The selected table and columns could not be inspected.",
			};
		const inspection = result.choiceProjection.inspection;
		if (inspection.tableRevision !== request.tableRevision)
			return {
				ok: false,
				error:
					"This Project data table changed. Inspect its current revision before using it in the design.",
			};
		const { tableRevision: _revision, ...reference } = request;
		evidence.set(
			key,
			existingLookupChoiceSourceSchema.parse({ ...reference, inspection }),
		);
	}
	return {
		ok: true,
		value: mapDesignSchemaSlots(
			args.schema,
			args.input,
			EXISTING_LOOKUP_CHOICE_SCHEMA_MARKER,
			(entry) =>
				evidence.get(sourceKey(authoredLookupChoiceSourceSchema.parse(entry))),
		),
	};
}
