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
 * `designIdSchema` emits its admission rule as the canonical UUID `pattern`
 * (never `format`), and the strict projection spells a formerly-optional
 * slot as `type: ["string", "null"]` — the audit here counts EVERY node
 * carrying the canonical pattern, whatever its type spelling, so an
 * unwidened slot cannot hide behind a null union.
 */

import { describe, expect, it } from "vitest";
import {
	inspectDesignWorkspaceInputSchema,
	stageContractInputSchema,
	stageRevisionInputSchema,
} from "@/lib/agent/design/artifactWorkspaceOperations";
import {
	DESIGN_HANDLE_PATTERN,
	designToolWireSchema,
} from "@/lib/agent/design/loop/tools";
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

/** Every canonical-uuid-pattern node in the schema, split into slots the
 * model can satisfy with a handle (widened) and slots pinned to raw UUIDs
 * (bare). Bare deliberately matches ANY type spelling — `"string"`,
 * `["string", "null"]`, or anything future — so no emission variant can
 * escape the audit. */
function auditUuidSlots(node: unknown): { widened: number; bare: number } {
	if (Array.isArray(node)) {
		return node
			.map(auditUuidSlots)
			.reduce(
				(a, b) => ({ widened: a.widened + b.widened, bare: a.bare + b.bare }),
				{ widened: 0, bare: 0 },
			);
	}
	if (!isJsonObject(node)) return { widened: 0, bare: 0 };
	if (isWidenedIdSlot(node)) return { widened: 1, bare: 0 };
	if (node.pattern === CANONICAL_UUID_PATTERN.source) {
		return { widened: 0, bare: 1 };
	}
	return auditUuidSlots(Object.values(node));
}

function collectionArm(schemaName: "actors" | "records") {
	const wire = designToolWireSchema(stageContractInputSchema) as {
		properties: {
			collections: { items: { anyOf: Record<string, unknown>[] } };
		};
	};
	return wire.properties.collections.items.anyOf.find(
		(arm) =>
			isJsonObject(arm.properties) &&
			isJsonObject(arm.properties.collection) &&
			arm.properties.collection.const === schemaName,
	) as {
		properties: {
			upserts: { items: { properties: Record<string, unknown> } };
		};
	};
}

describe("design tool wire schemas", () => {
	it.each([
		["stageContract", stageContractInputSchema],
		["stageRevision", stageRevisionInputSchema],
		["inspectDesignWorkspace", inspectDesignWorkspaceInputSchema],
	] as const)(
		"%s widens every design-ID slot to uuid | { handle }",
		(_name, schema) => {
			const audit = auditUuidSlots(designToolWireSchema(schema));
			expect(audit.bare).toBe(0);
			expect(audit.widened).toBeGreaterThan(0);
		},
	);

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
