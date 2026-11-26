import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { retainedSourceBody } from "@/lib/commcare/reader/__tests__/readerInput";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { birthAdoptedApp } from "@/lib/deployment/__tests__/adoptedBirth";
import {
	checkSearchResultsSourceFacts,
	searchResultsSourceFacts,
} from "../lib/searchResultsAdoption";
import { convertSearchResults } from "../migrations/step7-search-results.mjs";

const harness = setupAppStateTestDb("search_name_cutover_", {
	authSchema: "migrated",
});

it("carries an inactive adopted search by retained menu identity and stops a stale cutover", async () => {
	const actor = "bringer",
		projectId = "project-clinic",
		appId = testUuid("adopted-search");
	await harness.seedProjectMember(actor, projectId, "owner");
	await harness.seedProjectMember("another-actor", projectId, "editor");
	const birth = await birthAdoptedApp(harness, {
		appId,
		projectId,
		actorUserId: actor,
		target: { server: "production", domain: "clinic" },
		remoteAppId: "c".repeat(32),
	});
	const source = {
		...retainedSourceBody("shell/app-source"),
		modules: [
			{
				doc_type: "Module",
				unique_id: "a".repeat(32),
				name: { en: "Former title" },
				case_type: "patient",
				forms: [],
				search_config: { instance_name: "Région2", inline_search: false },
			},
		],
	};
	const bytes = Buffer.from(JSON.stringify(source));
	const db = harness.db();
	await db
		.updateTable("app_deployment_baselines")
		.set({
			source_gzip: gzipSync(bytes),
			source_bytes: bytes.length,
			source_digest: createHash("sha256").update(bytes).digest("hex"),
		})
		.where("deployment_id", "=", birth.deployment.deployment.id)
		.execute();
	const facts = await db.transaction().execute(searchResultsSourceFacts);
	expect(facts.targets).toHaveLength(1);
	expect(facts.targets[0].menus).toEqual([
		{ menu: birth.moduleUuid, uniqueId: "a".repeat(32), name: "Région2" },
	]);
	const old = {
		appId,
		modules: {
			[birth.moduleUuid]: { name: "Current title" },
			unrelated: { name: "Former title" },
		},
	};
	const address = { appId, projectId, purpose: "head" };
	const converted = convertSearchResults(
		old,
		{ searchResults: facts },
		address,
	);
	expect(converted.modules).toEqual({
		[birth.moduleUuid]: { name: "Current title", searchResultsName: "Région2" },
		unrelated: { name: "Former title" },
	});
	expect(
		convertSearchResults(converted, { searchResults: facts }, address),
	).toBe(converted);
	expect(
		convertSearchResults(
			old,
			{ searchResults: facts },
			{ ...address, projectId: "other-project" },
		),
	).toBe(old);
	await db
		.transaction()
		.execute((tx) => checkSearchResultsSourceFacts(tx, facts));
	await db
		.updateTable("app_deployment_baselines")
		.set({ observed_by: "another-actor" })
		.where("deployment_id", "=", birth.deployment.deployment.id)
		.execute();
	await expect(
		db.transaction().execute(searchResultsSourceFacts),
	).rejects.toThrow("verified source");
	await db
		.updateTable("app_deployment_baselines")
		.set({ observed_by: actor })
		.where("deployment_id", "=", birth.deployment.deployment.id)
		.execute();
	await db
		.updateTable("app_deployment_resources")
		.set({ remote_missing_at: new Date() })
		.where("deployment_id", "=", birth.deployment.deployment.id)
		.execute();
	await expect(
		db.transaction().execute((tx) => checkSearchResultsSourceFacts(tx, facts)),
	).rejects.toThrow("Freeze the current targets again");
	expect(await db.transaction().execute(searchResultsSourceFacts)).toEqual({
		targets: [],
	});
});
