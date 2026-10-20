/**
 * The report is content-free (part 09 §3, "The report"): every line is
 * archived with the evidence and logged as one Cloud Logging entry, so a
 * name, an expression or a value an author wrote must never reach one. The
 * plausible failures: a section that prints a notice line's detail (a form,
 * a property, a case type), a blocker place's text, a census file key built
 * from a name, or a change's entity name. The observation is every string
 * every section prints over the whole fixture fleet, the plan the scan
 * builds, against every string the fixtures' carriers hold; and, as the
 * control that the fleet does carry authored content to leak, the operator's
 * `--debug-details`, which prints it.
 *
 * The framing is step 2's: each line carries `report`, `mode` and
 * `section`, `fleet` first and `outcome` last.
 */

import { describe, expect, it } from "vitest";
import { casePropertyDataTypes } from "@/lib/domain/casePropertyTypes";
import {
	DEPLOYMENT_NOTICE_REASONS,
	DOCUMENT_NOTICE_REASONS,
} from "@/lib/notices/migrationNotice";
import { fleetCensus, parseBaseCensus } from "../census";
import {
	CutoverReport,
	censusLine,
	debugDetails,
	fleetLine,
	outcomeLine,
	planSections,
	REPORT,
} from "../report";
import {
	CUTOVER_BLOCKER_CODES,
	CUTOVER_STOP_CODES,
	EXPRESSIONS_CHANGE_CLASSES,
	EXPRESSIONS_STEP_IDS,
} from "../types";
import {
	BASE_FIXTURES,
	FIXTURE_MANIFEST,
	fixtureApp,
	fixtureCarriers,
	planFixtureFleet,
} from "./fixtureFleet";

/** An id of the shape apps and deployments carry, so no id spells a word. */
function uuidFor(index: number, kind: number): string {
	return `01992000-0000-7000-8${kind}00-${index.toString(16).padStart(12, "0")}`;
}

const APP_IDS = new Map(
	FIXTURE_MANIFEST.map((fixture, index) => [fixture.id, uuidFor(index, 1)]),
);
function appIdOf(fixture: string): string {
	const id = APP_IDS.get(fixture);
	if (id === undefined) throw new Error(`No app for ${fixture}`);
	return id;
}

const fleet = planFixtureFleet(
	FIXTURE_MANIFEST.map((fixture, index) =>
		fixtureApp(fixture.id, {
			appId: appIdOf(fixture.id),
			discardsPrivateWork: index % 3 === 0,
			deployments: [
				{
					deploymentId: uuidFor(index, 2),
					server: "production",
					domain: `space-${index}`,
				},
			],
		}),
	),
);

function fullReport(): CutoverReport {
	const report = new CutoverReport("scan");
	fleetLine(report, fleet, { planMilliseconds: 1 });
	planSections(report, fleet);
	const base = parseBaseCensus(
		[
			...[...BASE_FIXTURES.values()].flatMap((entry) =>
				entry.files.map((file) =>
					JSON.stringify({ app: appIdOf(entry.fixture), ...file }),
				),
			),
			JSON.stringify({ kind: "fleet", fleetSeqDigest: fleet.fleetSeqDigest }),
		].join("\n"),
	);
	censusLine(
		report,
		fleetCensus({
			apps: fleet.plan.apps,
			deleted: new Set(),
			targets: fleet.targets,
			lookupDefinitions: fleet.lookupDefinitions,
			fleetSeqDigest: fleet.fleetSeqDigest,
			base,
		}),
	);
	outcomeLine(report, { outcome: "stopped", stoppedBy: ["blocker"] });
	return report;
}

/** Every string leaf of a JSON value. */
function strings(value: unknown, into: Set<string> = new Set()): Set<string> {
	if (typeof value === "string") into.add(value);
	else if (Array.isArray(value)) for (const item of value) strings(item, into);
	else if (value !== null && typeof value === "object")
		for (const item of Object.values(value)) strings(item, into);
	return into;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Every string an author could have written into a fixture: names, labels, ids, expressions, values. */
function authoredStrings(): Set<string> {
	const authored = new Set<string>();
	for (const fixture of FIXTURE_MANIFEST) {
		const { root, rows } = fixtureCarriers(fixture.id);
		authored.add(root.app_name);
		for (const text of [
			root.case_types_text,
			root.localization_text,
			root.app_settings_text,
			...rows.map((row) => row.data_text),
		]) {
			if (text === null || text === undefined) continue;
			strings(JSON.parse(text), authored);
		}
	}
	for (const value of [...authored])
		if (UUID.test(value) || value.trim() === "") authored.delete(value);
	return authored;
}

/** The report's own vocabulary: a step, class, reason, code, data type or
 * validator finding can coincide with a string a fixture holds (a property
 * named `text`, a field kind), and is the report's. */
function vocabulary(): Set<string> {
	return new Set<string>([
		...EXPRESSIONS_STEP_IDS,
		...Object.values(EXPRESSIONS_CHANGE_CLASSES).flat(),
		...DOCUMENT_NOTICE_REASONS,
		...DEPLOYMENT_NOTICE_REASONS,
		...CUTOVER_BLOCKER_CODES,
		...CUTOVER_STOP_CODES,
		...casePropertyDataTypes,
		"declared",
		"inferred",
		...fleet.plan.apps.flatMap((app) =>
			app.blockers.flatMap((blocker) => [
				...blocker.findingCodes,
				...(blocker.findingReasons ?? []),
			]),
		),
	]);
}

/** Authored strings the lines print: each printed string whole, and a long
 * authored string (a name, a label, an expression) also as part of one. */
function leaksOf(lines: readonly unknown[]): string[] {
	const printed = strings(lines);
	const known = vocabulary();
	return [...authoredStrings()].filter(
		(value) =>
			!known.has(value) &&
			(printed.has(value) ||
				(value.length >= 12 &&
					[...printed].some((text) => text.includes(value)))),
	);
}

describe("the report", () => {
	const report = fullReport();
	const lines = report.all();

	it("frames every line as step 2 did, fleet first and outcome last", () => {
		expect(lines.every((line) => line.report === REPORT)).toBe(true);
		expect(lines.every((line) => line.mode === "scan")).toBe(true);
		expect(lines.map((line) => line.section)).toEqual([
			"fleet",
			"steps",
			"behavior",
			"schema",
			"holders",
			"private-work",
			...lines
				.filter((line) => line.section === "blocker")
				.map(() => "blocker"),
			"census",
			"outcome",
		]);
		expect(report.text().split("\n")).toHaveLength(lines.length);
	});

	it("holds no string any fixture's author wrote", () => {
		expect(leaksOf(lines)).toEqual([]);
		expect(authoredStrings().size).toBeGreaterThan(100);
	});

	it("would show a name or an expression a line let through", () => {
		const target = fleet.targets.get(appIdOf("targeted-datetime-ordering"));
		if (target === undefined) throw new Error("no target");
		const leaking = fullReport();
		leaking.line("steps", { note: `in ${target.appName}` });
		expect(leaksOf(leaking.all())).toEqual([target.appName]);
	});

	it("still names every app, blocker and deployment by its id and code", () => {
		const text = report.text();
		const blocked = fleet.plan.apps.find((app) => app.blockers.length > 0);
		if (blocked === undefined) throw new Error("no blocked fixture");
		expect(text).toContain(blocked.appId);
		expect(text).toContain(`"code":"${blocked.blockers[0]?.code}"`);
		expect(text).toContain(uuidFor(0, 2));
	});

	it("leaves the authored places to the operator's terminal, which shows them", () => {
		const blocked = fleet.plan.apps.find((app) =>
			app.blockers.some((blocker) => blocker.code === "target-gate"),
		);
		if (blocked === undefined) throw new Error("no gate-blocked fixture");
		const details = debugDetails(fleet, blocked.appId).join("\n");
		const name = fleet.targets.get(blocked.appId)?.appName;
		expect(name).toBeDefined();
		expect(details).toContain(name as string);
		expect(report.text()).not.toContain(name as string);
	});
});
