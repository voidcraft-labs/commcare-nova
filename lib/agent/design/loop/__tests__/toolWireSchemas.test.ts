/**
 * The provider-facing grammar of the handle-widened design tools.
 *
 * These tools ship `strict: true`, so under constrained decoding the model
 * can only emit what the wire schema admits. The server requires every NEW
 * design identity to be declared as a `{ handle }` object and refuses raw
 * UUID declarations and references, so every design-ID slot must offer the
 * handle arm beside the raw-UUID string — a bare uuid-pattern slot would
 * make the server's handle requirement unsatisfiable: the grammar forces a
 * raw UUID the server always rejects, and no compliant call can exist.
 *
 * `designIdSchema` emits an identity-domain marker. The strict projection
 * spells a formerly-optional slot as `type: ["string", "null"]`; the audit
 * proves every marked node becomes one widened slot and that the private
 * marker never reaches the provider. UUIDs in other domains remain strings.
 */

import { describe, expect, it } from "vitest";
import {
	designCollectionUpdateInputSchemas,
	inspectDesignInputSchema,
	setDesignRootInputSchema,
	updateFindingDispositionsInputSchema,
} from "@/lib/agent/design/artifactWorkspaceOperations";
import { DESIGN_IDENTITY_SCHEMA_MARKER } from "@/lib/agent/design/ids";
import {
	DESIGN_HANDLE_PATTERN,
	designToolWireSchema,
	inspectProjectDataInputSchema,
} from "@/lib/agent/design/loop/tools";
import { strictWireJsonSchema } from "@/lib/agent/strictStructuredOutput";
import { CANONICAL_UUID_PATTERN } from "@/lib/domain/uuid";

const HANDLE_ARM = {
	type: "object",
	properties: {
		handle: { type: "string", pattern: DESIGN_HANDLE_PATTERN.source },
	},
	required: ["handle"],
	additionalProperties: false,
};

const NULL_ARM = { type: "null" };

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequiredUuidString(node: unknown): boolean {
	return (
		isJsonObject(node) &&
		node.type === "string" &&
		node.pattern === CANONICAL_UUID_PATTERN.source
	);
}

/** A widened design-ID slot: `[uuid, handle]` for a required slot, or
 * `[uuid, handle, null]` where the slot was optional on the wire. */
function isWidenedIdSlot(node: unknown): boolean {
	if (!isJsonObject(node) || !Array.isArray(node.anyOf)) return false;
	const [uuid, handle, nullArm, ...rest] = node.anyOf;
	if (rest.length > 0) return false;
	if (!isRequiredUuidString(uuid)) return false;
	if (JSON.stringify(handle) !== JSON.stringify(HANDLE_ARM)) return false;
	return (
		nullArm === undefined ||
		JSON.stringify(nullArm) === JSON.stringify(NULL_ARM)
	);
}

function countDesignMarkers(node: unknown): number {
	if (Array.isArray(node)) {
		return node.reduce((total, entry) => total + countDesignMarkers(entry), 0);
	}
	if (!isJsonObject(node)) return 0;
	return (
		(node[DESIGN_IDENTITY_SCHEMA_MARKER] === true ? 1 : 0) +
		countDesignMarkers(Object.values(node))
	);
}

function countWidenedSlots(node: unknown): number {
	if (Array.isArray(node))
		return node.reduce((total, entry) => total + countWidenedSlots(entry), 0);
	if (!isJsonObject(node)) return 0;
	if (isWidenedIdSlot(node)) return 1;
	return countWidenedSlots(Object.values(node));
}

function collectionArm(schemaName: "actors" | "records") {
	return designToolWireSchema(
		designCollectionUpdateInputSchemas[schemaName],
	) as {
		properties: {
			upserts: { items: { properties: Record<string, unknown> } };
		};
	};
}

describe("design tool wire schemas", () => {
	it("keeps Project-data inspection on stable UUIDs and the shared row-page projection", () => {
		expect(inspectProjectDataInputSchema.safeParse({}).success).toBe(true);
		expect(
			inspectProjectDataInputSchema.safeParse({ cursor: "next-catalog-page" })
				.success,
		).toBe(true);
		expect(
			inspectProjectDataInputSchema.safeParse({
				tableId: "01998765-4321-7abc-8def-0123456789ab",
				choiceProjection: {
					valueColumnId: "01998765-4321-7abc-8def-0123456789ac",
					labelColumnId: "01998765-4321-7abc-8def-0123456789ad",
				},
				cursor: "next-page",
			}).success,
		).toBe(true);
		expect(
			inspectProjectDataInputSchema.safeParse({
				tableId: "01998765-4321-7abc-8def-0123456789ab",
				columnIds: ["01998765-4321-7abc-8def-0123456789ac"],
				choiceProjection: {
					valueColumnId: "01998765-4321-7abc-8def-0123456789ac",
					labelColumnId: "01998765-4321-7abc-8def-0123456789ad",
				},
			}).success,
		).toBe(false);
		expect(
			inspectProjectDataInputSchema.safeParse({ query: "active" }).success,
		).toBe(false);
		expect(
			inspectProjectDataInputSchema.safeParse({
				tableId: { handle: "@not_a_project_uuid" },
			}).success,
		).toBe(false);
	});

	it.each([
		["setDesignRoot", setDesignRootInputSchema],
		["updateActors", designCollectionUpdateInputSchemas.actors],
		["updateRecords", designCollectionUpdateInputSchemas.records],
		["updateWorkflows", designCollectionUpdateInputSchemas.workflows],
		["updateLookupTables", designCollectionUpdateInputSchemas.lookupTables],
		["updateFindingDispositions", updateFindingDispositionsInputSchema],
		["inspectDesign", inspectDesignInputSchema],
	] as const)(
		"%s widens every design-ID slot to uuid | { handle }",
		(_name, schema) => {
			const marked = countDesignMarkers(strictWireJsonSchema(schema));
			const wire = designToolWireSchema(schema);
			expect(marked).toBeGreaterThan(0);
			expect(countWidenedSlots(wire)).toBe(marked);
			expect(countDesignMarkers(wire)).toBe(0);
		},
	);

	it("keeps workspace bookkeeping out of every provider-facing schema", () => {
		for (const schema of [
			setDesignRootInputSchema,
			...Object.values(designCollectionUpdateInputSchemas),
			updateFindingDispositionsInputSchema,
			inspectDesignInputSchema,
		]) {
			const wire = JSON.stringify(designToolWireSchema(schema));
			expect(wire).not.toContain("expectedRevision");
			expect(wire).not.toContain("artifactKind");
		}
	});

	it("offers the exact handle arm on a required declaration slot", () => {
		const idSlot = collectionArm("actors").properties.upserts.items.properties
			.id as { anyOf: unknown[] };
		expect(isWidenedIdSlot(idSlot)).toBe(true);
		expect(idSlot.anyOf).toHaveLength(2);
		expect(idSlot.anyOf[1]).toEqual(HANDLE_ARM);
	});

	it("keeps the null arm on an optional reference slot", () => {
		/* `parentRecordId` is `designIdSchema.optional()`: the strict projection
		 * spells it `type: ["string", "null"]`, and the widening must keep the
		 * handle expressible WITHOUT losing the null spelling of absence. */
		const parentSlot = collectionArm("records").properties.upserts.items
			.properties.parentRecordId as { anyOf: unknown[] };
		expect(isWidenedIdSlot(parentSlot)).toBe(true);
		expect(parentSlot.anyOf).toHaveLength(3);
		expect(parentSlot.anyOf[1]).toEqual(HANDLE_ARM);
		expect(parentSlot.anyOf[2]).toEqual(NULL_ARM);
	});
});
