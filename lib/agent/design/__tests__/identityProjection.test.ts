import { describe, expect, it } from "vitest";
import { z } from "zod";
import { designCollectionUpdateInputSchemas } from "../artifactWorkspaceOperations";
import {
	appDesignContractBaseSchema,
	designLookupChoiceSourceSchema,
} from "../contract";
import { projectDesignIdentityHandles } from "../identityProjection";
import { designIdSchema } from "../ids";
import {
	collectDesignReferenceBindings,
	designReservedReferenceIssue,
	resolveDesignWorkspaceHandles,
} from "../loop/tools";
import { makeContract } from "./fixtures";

const session = "00000000-0000-4000-8000-000000000002";
const id = "00000000-0000-4000-8000-000000000010";
const binding = { designId: id, handle: "@patient" };

describe("design names at the authoring boundary", () => {
	it("leaves literal names and UUID text intact in both directions", () => {
		const record = {
			...makeContract().records[0],
			id: "@patient",
			name: "@f1",
			purpose: id,
		};
		const schema = designCollectionUpdateInputSchemas.records;
		const authored = { upserts: [record], removeIds: [] };
		const canonical = schema.parse(
			resolveDesignWorkspaceHandles(schema, authored, session),
		);
		expect(canonical.upserts[0]).toMatchObject({ name: "@f1", purpose: id });
		expect(canonical.upserts[0].id).not.toBe("@patient");
		expect(
			projectDesignIdentityHandles(schema, canonical, [
				{ ...binding, designId: canonical.upserts[0].id },
				{ designId: id, handle: "@literal_uuid" },
			]),
		).toEqual(authored);
	});

	it("distinguishes Project lookup UUIDs from identically named design references", () => {
		const source = { tableId: id, valueColumnId: id, labelColumnId: id };
		const existing = { ...source, kind: "existing-project-lookup" };
		expect(
			projectDesignIdentityHandles(designLookupChoiceSourceSchema, existing, [
				binding,
			]),
		).toEqual(existing);
		expect(
			projectDesignIdentityHandles(
				designLookupChoiceSourceSchema,
				{
					...source,
					kind: "designed-project-lookup",
				},
				[binding],
			),
		).toEqual({
			kind: "designed-project-lookup",
			tableId: "@patient",
			valueColumnId: "@patient",
			labelColumnId: "@patient",
		});
	});

	it("tracks placement references and ignores reserved names in prose", () => {
		const stage = {
			placements: [{ moduleId: "@visits", parentModuleId: "@patients" }],
			collections: [],
		};
		expect(
			collectDesignReferenceBindings(stage, [], session).map(
				(entry) => entry.handle,
			),
		).toEqual(["@visits", "@patients"]);
		expect(
			designReservedReferenceIssue({
				...stage,
				placements: [{ moduleId: "@f1" }],
			}),
		).toContain("@f1");
		expect(
			designReservedReferenceIssue({
				collections: [
					{ collection: "actors", upserts: [{ id: "@worker", name: "@f1" }] },
				],
			}),
		).toBeNull();
	});

	it("projects incomplete workspace state without turning literal root text into references", () => {
		const partial = { id, charter: { purpose: id, includedWorkflowIds: [id] } };
		expect(
			projectDesignIdentityHandles(appDesignContractBaseSchema, partial, [
				binding,
			]),
		).toEqual({
			id: "@patient",
			charter: { purpose: id, includedWorkflowIds: ["@patient"] },
		});
	});

	it("resolves an identity once when schemas share the same leaf", () => {
		const schema = z.intersection(
			z.object({ id: designIdSchema }),
			z.object({ id: designIdSchema }),
		);
		const resolved = resolveDesignWorkspaceHandles(
			schema,
			{ id: "@patient" },
			session,
		);
		expect(schema.parse(resolved)).toEqual({
			id: resolveDesignWorkspaceHandles(designIdSchema, "@patient", session),
		});
	});
});
