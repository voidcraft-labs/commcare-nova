import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { runXPathCarrierCompatibilityVerification } from "../xpathCarrierCompatibilityRepair";

const h = setupAppStateTestDb();
function fixture(calculate = "1 + 1") {
	return buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [f({ kind: "hidden", id: "computed", calculate })],
					},
				],
			},
		],
	});
}

describe("persisted XPath carrier deployment verification", () => {
	it("verifies the exact selected set, including restorable deleted apps, without writes", async () => {
		const active = await h.seedAppWithBlueprint(fixture(), { id: "active" });
		const deleted = await h.seedAppWithBlueprint(fixture(), { id: "deleted" });
		await h
			.db()
			.updateTable("apps")
			.set({ deleted_at: new Date("2026-08-01T00:00:00Z") })
			.where("id", "=", deleted)
			.execute();
		await h.seedAppWithBlueprint(fixture("here()"), { id: "not-selected" });
		const before = await h
			.db()
			.selectFrom("apps")
			.selectAll()
			.orderBy("id")
			.execute();
		expect(
			await runXPathCarrierCompatibilityVerification([deleted, active, active]),
		).toEqual({
			scannedApps: 2,
			verifiedApps: 2,
			expressions: 2,
			errorFindings: 0,
			unreadableApps: 0,
		});
		expect(
			await h.db().selectFrom("apps").selectAll().orderBy("id").execute(),
		).toEqual(before);
		expect(
			await h.db().selectFrom("app_changes").selectAll().execute(),
		).toEqual([]);
	});

	it("refuses a selected app that no longer exists", async () => {
		const active = await h.seedAppWithBlueprint(fixture());
		await expect(
			runXPathCarrierCompatibilityVerification([active, "missing"]),
		).rejects.toThrow("could not read every selected app");
	});

	it("refuses an incompatible carrier even when its app is deleted", async () => {
		const id = await h.seedAppWithBlueprint(fixture("here()"));
		await h
			.db()
			.updateTable("apps")
			.set({ deleted_at: new Date("2026-08-01T00:00:00Z") })
			.where("id", "=", id)
			.execute();
		await expect(runXPathCarrierCompatibilityVerification()).rejects.toThrow(
			/[1-9]\d* compatibility error\(s\) and 0 unreadable app\(s\)/,
		);
	});

	it("refuses schema-unreadable persisted state instead of treating it as a clean app", async () => {
		const id = await h.seedAppWithBlueprint(fixture());
		await h
			.db()
			.updateTable("blueprint_entities")
			.set({ data: JSON.stringify({ kind: "not-a-field" }) })
			.where("app_id", "=", id)
			.where("kind", "=", "field")
			.execute();
		await expect(runXPathCarrierCompatibilityVerification()).rejects.toThrow(
			"0 compatibility error(s) and 1 unreadable app(s)",
		);
	});
});
