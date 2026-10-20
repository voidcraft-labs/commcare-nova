/**
 * The emission census is a gate on unexplained differences (part 09 §7):
 * every file whose normalized bytes moved between the base half (pull
 * request 2's emitter over the stored app) and the head half (the head
 * emitter over the lifted target) must belong to an entity a named change
 * names. The plausible failures: a census that passes a moved file no change
 * explains (a defect of the stack would reach production unseen), one that
 * stops on a file a named change does explain (every app with the lowering
 * would stop the cutover), a file present in one half only that is not
 * counted, and a base input cut short that reads as a complete one.
 *
 * The base half here is the frozen base census of the pre-step fixtures
 * (`fixtures/base-census.json`), emitted at pull request 2's head by its
 * base emitter's own calls over each fixture's carriers. The head half is
 * this head's emission of each fixture's lift: the plan the scan builds,
 * from the cutover's own transform, over the fixtures as one fleet.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import {
	appCensus,
	type CensusChange,
	censusStops,
	emitCensusFiles,
	emitCensusFragments,
	explainedFiles,
	fleetCensus,
	parseBaseCensus,
} from "../census";
import { type EmissionFragment, normalizeEmittedApp } from "../emissionNormal";
import {
	BASE_FIXTURES,
	FIXTURE_MANIFEST,
	fixtureApp,
	planFixtureFleet,
} from "./fixtureFleet";

function baseOf(fixture: string): readonly EmissionFragment[] {
	const entry = BASE_FIXTURES.get(fixture);
	if (entry === undefined) throw new Error(`No base census for ${fixture}`);
	return entry.files;
}

const NOTHING_NAMED = { all: false, files: new Set<string>() } as const;

const fleet = planFixtureFleet(
	FIXTURE_MANIFEST.map((fixture) => fixtureApp(fixture.id)),
);
/** The base half as the base emitter prints it, over the fixture fleet. */
const base = parseBaseCensus(
	[
		...[...BASE_FIXTURES.values()].flatMap((entry) =>
			entry.files.map((file) =>
				JSON.stringify({ app: entry.fixture, ...file }),
			),
		),
		JSON.stringify({ kind: "fleet", fleetSeqDigest: fleet.fleetSeqDigest }),
	].join("\n"),
);
const census = fleetCensus({
	apps: fleet.plan.apps,
	deleted: new Set(),
	targets: fleet.targets,
	lookupDefinitions: fleet.lookupDefinitions,
	fleetSeqDigest: fleet.fleetSeqDigest,
	base,
});
function verdictOf(appId: string) {
	const app = census.apps.find((entry) => entry.appId === appId);
	if (app === undefined) throw new Error(`${appId} was not compared`);
	return app;
}
function targetOf(appId: string): BlueprintDoc {
	const target = fleet.targets.get(appId);
	if (target === undefined) throw new Error(`${appId} has no target`);
	return target;
}
function changesOf(appId: string): readonly CensusChange[] {
	return fleet.plan.apps.find((app) => app.appId === appId)?.changes ?? [];
}

describe("the frozen base census", () => {
	it("holds every fixture, from pull request 2's head, with its stored case schemas", () => {
		const frozen = JSON.parse(
			readFileSync(
				join(import.meta.dirname, "fixtures", "base-census.json"),
				"utf8",
			),
		) as { format: string; sourceCommit: string };
		expect(frozen.format).toBe("hq-round-trip-expressions-base-census-1");
		expect(frozen.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
		expect([...BASE_FIXTURES.keys()].sort()).toEqual(
			FIXTURE_MANIFEST.map((fixture) => fixture.id).sort(),
		);
		expect(
			[...BASE_FIXTURES.values()].every(
				(entry) =>
					entry.files.length > 0 && entry.caseTypeSchemas !== undefined,
			),
		).toBe(true);
	});
});

describe("a base census that does not cover the fleet", () => {
	const admitted = fleet.plan.apps.find(
		(app) => app.blockers.length === 0 && base.files.has(app.appId),
	);
	if (admitted === undefined) throw new Error("No fixture is admitted");

	it("stops on a live admitted app the base half holds no file of", () => {
		const files = new Map(base.files);
		files.delete(admitted.appId);
		const partial = fleetCensus({
			apps: fleet.plan.apps,
			deleted: new Set(),
			targets: fleet.targets,
			lookupDefinitions: fleet.lookupDefinitions,
			fleetSeqDigest: fleet.fleetSeqDigest,
			base: { ...base, files },
		});
		expect(partial.missingBase).toEqual([admitted.appId]);
		expect(partial.apps.some((app) => app.appId === admitted.appId)).toBe(
			false,
		);
		expect(censusStops(partial)).toEqual(["census-incomplete"]);
		// A deleted app is in neither half, so its absence stops nothing.
		const deleted = fleetCensus({
			apps: fleet.plan.apps,
			deleted: new Set([admitted.appId]),
			targets: fleet.targets,
			lookupDefinitions: fleet.lookupDefinitions,
			fleetSeqDigest: fleet.fleetSeqDigest,
			base: { ...base, files },
		});
		expect(censusStops(deleted)).toEqual([]);
	});

	it("stops on base digests read from other fleet sequences", () => {
		const stale = fleetCensus({
			apps: fleet.plan.apps,
			deleted: new Set(),
			targets: fleet.targets,
			lookupDefinitions: fleet.lookupDefinitions,
			fleetSeqDigest: fleet.fleetSeqDigest,
			base: { ...base, fleetSeqDigest: "0".repeat(64) },
		});
		expect(stale.fleetSeqDigestMatches).toBe(false);
		expect(censusStops(stale)).toEqual(["census-stale"]);
	});
});

describe("the census over the lifted fixtures", () => {
	it("compares every fixture the plan admits, every corpus fixture among them, and none it blocks", () => {
		const blocked = fleet.plan.apps
			.filter((app) => app.blockers.length > 0)
			.map((app) => app.appId);
		expect(census.notCompared).toEqual(blocked);
		expect(census.missingBase).toEqual([]);
		expect(census.emissionFailed).toEqual([]);
		expect(census.fleetSeqDigestMatches).toBe(true);
		expect(censusStops(census)).toEqual([]);
		const compared = new Set(census.apps.map((app) => app.appId));
		for (const fixture of FIXTURE_MANIFEST.filter(
			(entry) => entry.kind === "corpus",
		))
			expect(compared.has(fixture.id), fixture.id).toBe(true);
		expect(compared.size + blocked.length).toBe(FIXTURE_MANIFEST.length);
	});

	it("finds every difference after normalization in a file a named change explains", () => {
		expect(
			census.apps
				.filter((app) => app.verdict === "unexplained")
				.map((app) => [app.appId, app.unexplainedFiles]),
		).toEqual([]);
	});

	it.each([
		["targeted-datetime-ordering", "the lowering in two forms"],
		["form-logic", "the first-row lift"],
		["search-behavior", "part 06's two search changes"],
		["declare-read-properties", "the declarations"],
	])("names %s, for %s", (appId) => {
		expect(verdictOf(appId)).toMatchObject({ verdict: "named" });
		expect(verdictOf(appId).namedFiles).toBeGreaterThan(0);
	});

	it("reads the scaffolding's respelling as respelled-only where no named change reaches the wire", () => {
		for (const appId of [
			"arithmetic",
			"form-link-manual",
			"container-query-conditional-relative",
			"choices",
			"catalog-rules",
		])
			expect(verdictOf(appId).verdict, appId).toBe("respelled-only");
	});
});

describe("reading the base half", () => {
	const fileLine = (app: string, file: string) =>
		JSON.stringify({
			app,
			file,
			rawDigest: "a".repeat(64),
			digest: "b".repeat(64),
		});
	const fleet = JSON.stringify({
		kind: "fleet",
		fleetSeqDigest: "c".repeat(64),
	});

	it("reads each app's files and the fleet's sequence digest", () => {
		const base = parseBaseCensus(
			[
				fileLine("one", "local/suite.xml"),
				fileLine("two", "hq/app.json"),
				fleet,
			].join("\n"),
		);
		expect(base.fleetSeqDigest).toBe("c".repeat(64));
		expect([...base.files.keys()]).toEqual(["one", "two"]);
		expect(base.files.get("one")?.[0]?.file).toBe("local/suite.xml");
	});

	it.each([
		["with no fleet line", [fileLine("one", "local/suite.xml")]],
		[
			"with the fleet line before a file",
			[fleet, fileLine("one", "local/suite.xml")],
		],
		[
			"naming one file twice",
			[
				fileLine("one", "local/suite.xml"),
				fileLine("one", "local/suite.xml"),
				fleet,
			],
		],
		["with a line that is not JSON", ["{", fleet]],
		["with a line of another shape", [JSON.stringify({ app: "one" }), fleet]],
	])("refuses an input %s", (_name, lines) => {
		expect(() => parseBaseCensus(lines.join("\n"))).toThrow(
			/Run (the base emitter|it) again/,
		);
	});
});

const ordering = targetOf("targeted-datetime-ordering");
const orderingHead = emitCensusFragments(ordering, []);
const orderingChanges = changesOf("targeted-datetime-ordering");

describe("the verdicts", () => {
	it("stops on the lowering's differences when no change names them, by exactly the files its lines explain", () => {
		const verdict = appCensus(
			"ordering",
			baseOf("targeted-datetime-ordering"),
			orderingHead,
			NOTHING_NAMED,
		);
		expect(verdict.verdict).toBe("unexplained");
		expect(verdict.unexplainedFiles.length).toBeGreaterThan(0);
		expect(
			verdict.unexplainedFiles.every((file) =>
				explainedFiles(ordering, orderingChanges).files.has(file),
			),
		).toBe(true);
	});

	it("stops on a hand-edited head file no change names, by that file's position", () => {
		const { hqApp, localFiles } = emitCensusFiles(ordering, []);
		const [suite] = [...localFiles].filter(([name]) => name === "suite.xml");
		if (suite === undefined) throw new Error("no suite");
		/* A meaning change in the suite: no lowering line names a module, so
		 * the suite is no file of a named change. */
		const edited = new Map(localFiles);
		edited.set(
			"suite.xml",
			suite[1].replace(/<text>/, '<text><xpath function="1 + 1"/>'),
		);
		expect(edited.get("suite.xml")).not.toBe(suite[1]);
		const verdict = appCensus(
			"ordering",
			orderingHead,
			normalizeEmittedApp(hqApp, edited),
			explainedFiles(ordering, orderingChanges),
		);
		expect(verdict).toMatchObject({
			verdict: "unexplained",
			unexplainedFiles: ["local/suite.xml"],
		});
	});

	it("reads a respelling the normalizer sees through as respelled-only, and identical bytes as unchanged", () => {
		expect(
			appCensus("ordering", orderingHead, orderingHead, NOTHING_NAMED).verdict,
		).toBe("unchanged");
		const respelled = orderingHead.map((file, index) =>
			index === 0 ? { ...file, rawDigest: "f".repeat(64) } : file,
		);
		expect(
			appCensus("ordering", orderingHead, respelled, NOTHING_NAMED),
		).toMatchObject({ verdict: "respelled-only", respelledFiles: 1 });
	});

	it("counts a file present in one half only as moved", () => {
		const [first, ...rest] = orderingHead;
		if (first === undefined) throw new Error("no file");
		expect(
			appCensus("ordering", orderingHead, rest, NOTHING_NAMED),
		).toMatchObject({ verdict: "unexplained", unexplainedFiles: [first.file] });
		expect(
			appCensus("ordering", rest, orderingHead, NOTHING_NAMED),
		).toMatchObject({ verdict: "unexplained", unexplainedFiles: [first.file] });
	});
});

describe("which files a named change explains", () => {
	const change = (
		reason: string,
		type: string,
		uuid?: string,
	): CensusChange => ({
		reason,
		entity: { type, ...(uuid === undefined ? {} : { uuid }) },
	});
	const files = (doc: BlueprintDoc, changes: CensusChange[]) =>
		[...explainedFiles(doc, changes).files].sort();
	const [firstModule] = ordering.moduleOrder;
	const formUuid = ordering.formOrder[firstModule ?? ""]?.[0];
	if (firstModule === undefined || formUuid === undefined)
		throw new Error("no form");
	const fieldUuid = ordering.fieldOrder[formUuid]?.[0];
	if (fieldUuid === undefined) throw new Error("no field");
	const head = new Set(orderingHead.map((file) => file.file));

	it("gives a field's line its form's XForms and HQ form entry, each a file the emission holds", () => {
		const explained = files(ordering, [
			change("repeat-read-takes-first-row", "field", fieldUuid),
		]);
		expect(explained).toHaveLength(3);
		expect(explained.every((file) => head.has(file))).toBe(true);
		expect(explained.some((file) => file.endsWith("/form.json"))).toBe(true);
	});

	it("gives a form's line its files and the suite, and a module's its HQ entry and the suite", () => {
		expect(
			files(ordering, [
				change("date-time-comparison-compares-moments", "form", formUuid),
			]),
		).toEqual(
			[
				...files(ordering, [
					change("repeat-read-takes-first-row", "field", fieldUuid),
				]),
				"local/suite.xml",
			].sort(),
		);
		const moduleFiles = files(ordering, [
			change("search-today-is-workers-day", "module", firstModule),
		]);
		expect(moduleFiles).toHaveLength(2);
		expect(moduleFiles.every((file) => head.has(file))).toBe(true);
	});

	it("gives a declaration or an inference typing every file, and a line the emission does not change none", () => {
		expect(
			explainedFiles(ordering, [change("case-property-declared", "app")]).all,
		).toBe(true);
		expect(
			explainedFiles(ordering, [change("case-property-type-now-known", "app")])
				.all,
		).toBe(true);
		const quiet = explainedFiles(ordering, [
			change("expressions-follow-choices", "app"),
			change("expressions-respelled", "app"),
			change("case-property-rules-removed", "app"),
		]);
		expect(quiet.all).toBe(false);
		expect(quiet.files.size).toBe(0);
	});
});
