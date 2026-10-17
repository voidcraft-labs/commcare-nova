/**
 * The no-write lines `behavior.ts` reads from the migrated document, over the
 * frozen fixtures: which entities each reason names, and that reading them
 * changes nothing in the document.
 */

import { describe, expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import {
	BEHAVIOR_SELECTIONS,
	behaviorChanges,
	localArchiveChanges,
	validationNowEnforced,
} from "../behavior";
import {
	migratedFixtureDocument,
	readFixtureManifest,
} from "./fixtures/preStep";

const fixtures = readFixtureManifest().fixtures.map((fixture) => fixture.id);

function fieldsOf(doc: BlueprintDoc) {
	return Object.values(doc.fields);
}

describe("validation-now-enforced", () => {
	it("names each barcode and secret question that holds a validation, with its form and kind", () => {
		const doc = migratedFixtureDocument("hand-validated-barcode-secret");
		const validated = fieldsOf(doc).filter(
			(field) =>
				(field.kind === "barcode" || field.kind === "secret") &&
				field.validate !== undefined,
		);
		expect(validated.map((field) => field.kind).sort()).toEqual([
			"barcode",
			"secret",
		]);
		const lines = validationNowEnforced.select(doc);
		expect(lines).toHaveLength(validated.length);
		for (const field of validated) {
			const form = Object.values(doc.forms).find((candidate) =>
				JSON.stringify(doc.fieldOrder[candidate.uuid] ?? []).includes(
					field.uuid,
				),
			);
			expect(lines).toContainEqual({
				reason: "validation-now-enforced",
				entity: { type: "field", uuid: field.uuid, nameAtMigration: field.id },
				detail: { form: form?.name, kind: field.kind },
			});
		}
	});

	it.each(["xml-unicode", "localization-optional", "hand-media-slots"])(
		"names no validated question of another kind in %s",
		(id) => {
			const doc = migratedFixtureDocument(id);
			expect(
				fieldsOf(doc).some((field) => "validate" in field && field.validate),
			).toBe(true);
			expect(validationNowEnforced.select(doc)).toEqual([]);
		},
	);
});

describe("local-archive-changes", () => {
	it.each(fixtures.filter((id) => id !== "hand-target-parse"))(
		"names %s once, as the app, with no detail",
		(id) => {
			const doc = migratedFixtureDocument(id);
			expect(localArchiveChanges.select(doc)).toEqual([
				{
					reason: "local-archive-changes",
					entity: { type: "app", nameAtMigration: doc.appName },
				},
			]);
		},
	);
});

describe("the no-write lines", () => {
	it("are selected in the enum's order", () => {
		expect(BEHAVIOR_SELECTIONS.map((selection) => selection.reason)).toEqual([
			"validation-now-enforced",
			"local-archive-changes",
		]);
		expect(
			behaviorChanges(
				migratedFixtureDocument("hand-validated-barcode-secret"),
			).map((change) => change.reason),
		).toEqual([
			"validation-now-enforced",
			"validation-now-enforced",
			"local-archive-changes",
		]);
	});

	it("change nothing in the document they read", () => {
		const doc = migratedFixtureDocument("hand-validated-barcode-secret");
		const before = structuredClone(doc);
		behaviorChanges(doc);
		expect(doc).toEqual(before);
	});
});
