import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { replaceFieldOptionsSourceMutation } from "@/lib/doc/lookupOptionsSourceMutations";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import { asUuid, mutationSchema } from "@/lib/doc/types";
import type { LookupOptionsSource } from "@/lib/domain/lookupCarriers";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import type { LookupRevision } from "@/lib/lookup/types";

const fieldUuid = asUuid("44444444-4444-4444-4444-444444444444");

const source: LookupOptionsSource = {
	kind: "lookup",
	tableId: lookupTableIdSchema.parse("01912d68-783e-7000-8000-00000000a001"),
	valueColumnId: lookupColumnIdSchema.parse(
		"01912d68-783e-7000-8000-00000000c001",
	),
	labelColumnId: lookupColumnIdSchema.parse(
		"01912d68-783e-7000-8000-00000000c002",
	),
};
const inlineSource = {
	kind: "inline" as const,
	options: [
		{
			uuid: asUuid("26a5c50b-3832-4669-a929-d155e8b5af0d"),
			value: "clinic",
			label: "Clinic",
		},
		{
			uuid: asUuid("4fe7a686-ee21-4dc5-a12f-f0c288dcacc4"),
			value: "hospital",
			label: "Hospital",
		},
	],
};

function inlineSelectDoc() {
	return buildDoc({
		appName: "Lookup source gate",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								uuid: fieldUuid,
								kind: "single_select",
								id: "facility",
								label: "Facility",
								optionsSource: inlineSource,
							}),
						],
					},
				],
			},
		],
	});
}

const availableContext: LookupValidationContext = {
	kind: "available",
	projectId: "project-a",
	projectRevision: "7" as LookupRevision,
	definitions: [
		{
			id: source.tableId,
			name: "Facilities",
			tag: "facilities",
			definitionRevision: "6" as LookupRevision,
			columns: [
				{
					id: source.valueColumnId,
					wireName: "code",
					label: "Code",
					dataType: "text",
				},
				{
					id: source.labelColumnId,
					wireName: "name",
					label: "Name",
					dataType: "text",
				},
			],
		},
	],
};

describe("replaceFieldOptionsSourceMutation", () => {
	it("replaces the complete source with a lookup arm", () => {
		const mutation = replaceFieldOptionsSourceMutation(
			fieldUuid,
			"single_select",
			source,
		);
		expect(mutation).toEqual({
			kind: "updateField",
			uuid: fieldUuid,
			targetKind: "single_select",
			patch: { optionsSource: source },
		});
	});

	it("replaces lookup choices with a complete inline arm", () => {
		const mutation = replaceFieldOptionsSourceMutation(
			fieldUuid,
			"multi_select",
			inlineSource,
		);
		const wire = JSON.parse(JSON.stringify(mutation)) as Record<
			string,
			unknown
		>;
		expect(wire).toHaveProperty("patch.optionsSource", inlineSource);
	});

	it("carries a set source through the same round trip", () => {
		const mutation = replaceFieldOptionsSourceMutation(
			fieldUuid,
			"single_select",
			source,
		);
		const wire = JSON.parse(JSON.stringify(mutation));
		expect(wire).toEqual(mutation);
	});

	it("produces mutations the canonical external envelope accepts", () => {
		// Both directions are ordinary canonical `updateField` events with the
		// complete nested field patch shape.
		for (const next of [source, inlineSource]) {
			const parsed = mutationSchema.safeParse(
				JSON.parse(
					JSON.stringify(
						replaceFieldOptionsSourceMutation(fieldUuid, "single_select", next),
					),
				),
			);
			expect(parsed.success).toBe(true);
		}
	});

	it("requires the loaded table definition before the client gate can bind it", () => {
		const doc = inlineSelectDoc();
		const mutation = replaceFieldOptionsSourceMutation(
			fieldUuid,
			"single_select",
			source,
		);

		const unavailable = mutationCommitVerdict(
			doc,
			[mutation],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(unavailable.ok).toBe(false);
		if (!unavailable.ok) {
			expect(unavailable.introduced.map((finding) => finding.code)).toContain(
				"LOOKUP_CONTEXT_UNAVAILABLE",
			);
		}

		const available = mutationCommitVerdict(doc, [mutation], availableContext);
		expect(available.ok).toBe(true);
		if (available.ok) {
			expect(available.nextDoc.fields[fieldUuid]).toMatchObject({
				optionsSource: source,
			});
		}
	});
});
