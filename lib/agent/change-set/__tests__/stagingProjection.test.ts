/**
 * The staging projection is the REVIEWED decision surface: which identity
 * families a private change set may address with a handle, and which stay
 * canonical because the resource lives outside the candidate.
 *
 * What this pins:
 *
 *   - the classification is TOTAL over `AuthorableIdentityFamily` — a new
 *     family must be classified deliberately, not inherited by default;
 *   - every identity pointer a stageable shared tool actually exposes falls
 *     under a classification;
 *   - handle eligibility and the durable entity-kind vocabulary are one
 *     relation, in both directions;
 *   - and the structural spelling is collision-free: no canonical tool input
 *     schema owns a property named `handle`, anywhere in its shape, so
 *     `{ handle }` can only ever mean a change-set reference.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type StagedEntityKind,
	stagedEntityKindSchema,
} from "@/lib/agent/change-set/schemas";
import {
	familyIsHandleEligible,
	HANDLE_ENTITY_KIND_BY_FAMILY,
	STAGING_PROJECTION_DECISIONS,
} from "@/lib/agent/change-set/stagingProjection";
import {
	AUTHORABLE_IDENTITY_POINTER_REGISTRY,
	type AuthorableIdentityFamily,
} from "@/lib/agent/identityPointerRegistry";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";

/**
 * The complete union, restated as a record so TypeScript refuses the file
 * when a family is added or removed. The runtime comparison below then proves
 * the projection map moved with it.
 */
const EVERY_FAMILY: Readonly<Record<AuthorableIdentityFamily, true>> = {
	"entry-point": true,
	module: true,
	form: true,
	field: true,
	"select-option": true,
	"case-list-column": true,
	"search-input": true,
	"worker-property": true,
	"user-type": true,
	persona: true,
	"organization-level": true,
	"location-property": true,
	location: true,
	"case-operation": true,
	"form-link": true,
	automation: true,
	"automation-criterion": true,
	"automation-setup-criterion": true,
	"automation-update": true,
	"automation-recipient": true,
	"automation-event": true,
	"automation-user-data-filter": true,
	"media-asset": true,
	"lookup-table": true,
	"lookup-column": true,
	"lookup-row": true,
};

/** Adding an identity family is a REVIEW DUTY: classify it in
 *  `STAGING_PROJECTION_DECISIONS` (and, if handle-eligible, give it a staged
 *  entity kind), then move this count. */
const REVIEWED_FAMILY_COUNT = 26;

function walkJson(
	node: unknown,
	visit: (object: Record<string, unknown>) => void,
): void {
	if (Array.isArray(node)) {
		for (const entry of node) walkJson(entry, visit);
		return;
	}
	if (node === null || typeof node !== "object") return;
	const record = node as Record<string, unknown>;
	visit(record);
	for (const value of Object.values(record)) walkJson(value, visit);
}

describe("STAGING_PROJECTION_DECISIONS", () => {
	it("classifies every authorable identity family exactly once", () => {
		expect(Object.keys(STAGING_PROJECTION_DECISIONS).sort()).toEqual(
			Object.keys(EVERY_FAMILY).sort(),
		);
	});

	it("holds the reviewed family count — a growing union must be classified deliberately", () => {
		expect(Object.keys(STAGING_PROJECTION_DECISIONS)).toHaveLength(
			REVIEWED_FAMILY_COUNT,
		);
	});

	it("classifies every identity pointer a stageable shared tool exposes", () => {
		const stageableTools = new Set<string>(
			SHARED_TOOL_REGISTRY.filter(
				(entry) => entry.policy.staging !== "forbidden",
			).map((entry) => entry.mcpName),
		);
		const pointers = AUTHORABLE_IDENTITY_POINTER_REGISTRY.filter((pointer) =>
			stageableTools.has(pointer.tool),
		);
		/* A vacuous pass would hide a broken registry derivation. */
		expect(pointers.length).toBeGreaterThan(50);

		const unclassified = pointers
			.filter(
				(pointer) => STAGING_PROJECTION_DECISIONS[pointer.family] === undefined,
			)
			.map((pointer) => `${pointer.tool}${pointer.schemaPointer}`);
		expect(unclassified).toEqual([]);
	});

	it("keeps every external identity canonical", () => {
		for (const family of [
			"location",
			"media-asset",
			"lookup-table",
			"lookup-column",
			"lookup-row",
		] as const) {
			expect(STAGING_PROJECTION_DECISIONS[family]).toBe("canonical-only");
		}
	});

	it("familyIsHandleEligible reads the same map", () => {
		for (const family of Object.keys(
			EVERY_FAMILY,
		) as AuthorableIdentityFamily[]) {
			expect(familyIsHandleEligible(family)).toBe(
				STAGING_PROJECTION_DECISIONS[family] === "handle-eligible",
			);
		}
	});
});

describe("HANDLE_ENTITY_KIND_BY_FAMILY", () => {
	const eligible = Object.entries(STAGING_PROJECTION_DECISIONS)
		.filter(([, decision]) => decision === "handle-eligible")
		.map(([family]) => family)
		.sort();

	it("names an entity kind for exactly the handle-eligible families", () => {
		expect(Object.keys(HANDLE_ENTITY_KIND_BY_FAMILY).sort()).toEqual(eligible);
		for (const kind of Object.values(HANDLE_ENTITY_KIND_BY_FAMILY)) {
			expect(kind).toBeDefined();
		}
	});

	it("covers the whole durable staged-entity-kind vocabulary, one kind per family", () => {
		const kinds = Object.values(HANDLE_ENTITY_KIND_BY_FAMILY).filter(
			(kind): kind is StagedEntityKind => kind !== undefined,
		);
		expect([...kinds].sort()).toEqual(
			[...stagedEntityKindSchema.options].sort(),
		);
	});
});

describe("structural handle references are collision-free", () => {
	it("no canonical tool input schema owns a property named `handle`", () => {
		const offenders: string[] = [];
		for (const entry of SHARED_TOOL_REGISTRY) {
			const json = z.toJSONSchema(entry.tool.inputSchema, {
				target: "draft-7",
				io: "input",
			});
			walkJson(json, (node) => {
				const properties = node.properties;
				if (
					properties === null ||
					typeof properties !== "object" ||
					Array.isArray(properties)
				) {
					return;
				}
				if (Object.hasOwn(properties, "handle")) offenders.push(entry.mcpName);
			});
		}
		expect(offenders).toEqual([]);
	});
});
