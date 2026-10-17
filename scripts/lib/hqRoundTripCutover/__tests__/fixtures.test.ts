/**
 * The frozen pre-step fixtures and the legacy upload bodies are what they
 * were when they were captured, every fixture holds what its row says it
 * holds, and every registered step, blocker code and notice reason names at
 * least one fixture that witnesses it, so a pull request that registers one
 * with no witness fails here.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEPLOYMENT_NOTICE_REASONS,
	DOCUMENT_NOTICE_REASONS,
} from "@/lib/notices/migrationNotice";
import { readRawDocument } from "../oldShape";
import { CUTOVER_BLOCKER_CODES, PROJECT_BLOCKER_CODES } from "../plan";
import { CUTOVER_STEPS } from "../transform";
import { FIXTURE_DOCUMENTS, HISTORIES } from "./fixtures/fixtureDocuments";
import { HAND_BUILT_FIXTURES } from "./fixtures/handBuilt";
import {
	LEGACY_DIRECTORY,
	readFixtureCarriers,
	readFixtureHistory,
	readFixtureManifest,
	readLegacyManifest,
} from "./fixtures/preStep";

function sha256(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function filesUnder(directory: string): string[] {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		return statSync(path).isDirectory() ? filesUnder(path) : [path];
	});
}

const manifest = readFixtureManifest();

describe("the legacy upload bodies", () => {
	it("are exactly the files the legacy manifest names, each at its digest", () => {
		const recorded = readLegacyManifest();
		const present = filesUnder(LEGACY_DIRECTORY)
			.map((path) => relative(LEGACY_DIRECTORY, path))
			.filter((path) => path.split("/")[1] === "legacy")
			.sort();
		expect(present).toEqual(Object.keys(recorded).sort());
		for (const path of present) {
			expect(sha256(readFileSync(join(LEGACY_DIRECTORY, path))), path).toBe(
				recorded[path],
			);
		}
	});

	it("hold each corpus fixture's create and republish, its archive and its configurations", () => {
		const recorded = readLegacyManifest();
		for (const fixture of FIXTURE_DOCUMENTS) {
			for (const name of [
				"create.body",
				"create.json",
				"republish.body",
				"republish.json",
				"local.ccz",
				"configurations.json",
			]) {
				expect(recorded, `${fixture.id}/legacy/${name}`).toHaveProperty([
					`${fixture.id}/legacy/${name}`,
				]);
			}
		}
	});
});

describe("the frozen fixtures", () => {
	it("are the corpus rows and the hand-built fixtures, each at its digest", () => {
		expect(manifest.fixtures.map((fixture) => fixture.id)).toEqual([
			...FIXTURE_DOCUMENTS.map((fixture) => fixture.id),
			...HAND_BUILT_FIXTURES.map((fixture) => fixture.id),
		]);
		for (const fixture of manifest.fixtures) {
			expect(
				sha256(JSON.stringify(readFixtureCarriers(fixture.id))),
				fixture.id,
			).toBe(fixture.digest);
		}
	});

	it.each(FIXTURE_DOCUMENTS.map((fixture) => [fixture.id, fixture]))(
		"%s holds what its row names",
		(id, fixture) => {
			expect(
				fixture.check(readRawDocument(id, readFixtureCarriers(id))),
				`${id} should hold ${fixture.holds}`,
			).toBe(true);
		},
	);

	it.each(HAND_BUILT_FIXTURES.map((fixture) => [fixture.id, fixture]))(
		"%s holds what it was built to hold",
		(id, fixture) => {
			expect(
				fixture.check(readRawDocument(id, readFixtureCarriers(id))),
				`${id} should hold ${fixture.holds}`,
			).toBe(true);
		},
	);

	it("retains each history with one row per batch", () => {
		for (const history of HISTORIES) {
			const retained = readFixtureHistory(history.document, history.name);
			expect(retained.baseline.seq).toBe(1);
			expect(retained.rows.map((row) => row.seq)).toEqual(
				retained.rows.map((_, index) => index + 2),
			);
		}
	});

	it("names a witness for every registered step, every blocker code and every notice reason", () => {
		const witnessed = (
			pick: (fixture: (typeof manifest.fixtures)[number]) => readonly string[],
		) => new Set(manifest.fixtures.flatMap(pick));
		const steps = witnessed((fixture) => fixture.steps);
		const blockers = witnessed((fixture) => fixture.blockers);
		const reasons = witnessed((fixture) => fixture.reasons);
		expect(
			CUTOVER_STEPS.map((step) => step.id).filter((id) => !steps.has(id)),
		).toEqual([]);
		expect(
			[...CUTOVER_BLOCKER_CODES, ...PROJECT_BLOCKER_CODES].filter(
				(code) => !blockers.has(code),
			),
		).toEqual([]);
		expect(
			[...DOCUMENT_NOTICE_REASONS, ...DEPLOYMENT_NOTICE_REASONS].filter(
				(reason) => !reasons.has(reason),
			),
		).toEqual([]);
	});
});
