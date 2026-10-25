/**
 * The model checks the cell table's `model` rows name
 * (`platformCells.ts`): each drives the production model for one platform
 * and asserts the observable that shows Preview plays the cell's reading.
 * `platformCells.test.ts` runs every check a row names, for that row's
 * platform.
 */

import { expect, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { rowMatchesFilterText } from "@/components/preview/shared/listFilter";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { CaseIndexRow, CaseRow } from "@/lib/case-store";
import {
	hiddenSearchInputDef,
	linkColumn,
	plainColumn,
	simpleSearchInputDef,
	tileCell,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression";
import type { Platform } from "@/lib/domain/platforms";
import { projectProseTemplate } from "@/lib/domain/prose";
import { appHomeLanding } from "../afterSubmitRouting";
import { automaticallyLaunchesSearch, caseListStep } from "../caseListPhase";
import { splitTileGridByGroupHeader } from "../caseTileGrouping";
import { projectTileGrid } from "../caseTileLayout";
import { planTileCell } from "../caseTileRendering";
import {
	type ColumnDisplayContext,
	projectColumnDisplay,
} from "../columnDisplay";
import { engineFixtureInput } from "../engine/__tests__/fixtures/engineInput";
import {
	androidDevice,
	TEST_ANDROID_DEVICE_ID,
	webAppsDevice,
} from "../engine/__tests__/fixtures/previewDevices";
import type { CaseRowWithCalculated } from "../engine/caseDataBindingTypes";
import { DataInstance } from "../engine/dataInstance";
import { buildFieldTree } from "../engine/fieldTree";
import { FormEngine } from "../engine/formEngine";
import { previewSessionValues } from "../engine/identity";
import {
	searchInputConstraintErrors,
	searchInputRequiredMarks,
} from "../engine/searchInputConstraints";
import { prepareEntryPointLaunch } from "../entryPointLaunch";
import { formlessCaseListSelection } from "../formlessCaseListRoute";
import { drawnSearchInputs } from "../hooks/useSearchInputRunState";
import {
	ANDROID_DEVICE_ID_PREFIX,
	androidAppVersion,
	previewPlatformRules,
	WEB_APPS_APPVERSION,
	WEB_APPS_DEVICE_ID,
} from "../platform";
import { evaluateAsync } from "../xpath/asyncEvaluator";
import {
	coreDateAdd,
	coreDaysSinceEpoch,
	coreFractionalDays,
	type DayNumberEpoch,
} from "../xpath/coreDays";
import { evaluate } from "../xpath/evaluator";
import { type EvalContext, XPathDate } from "../xpath/types";
import { assertAdmittedPreviewDoc } from "./fixtures/admittedDoc";

const WEB_APPS = previewPlatformRules("web-apps");
const ANDROID = previewPlatformRules("android");
const DAY_MS = 86_400_000;

// ── Fixtures ──────────────────────────────────────────────────────────

const NAME = testUuid("cell-model-name");
const VILLAGE = testUuid("cell-model-village");
const LINK = testUuid("cell-model-link");

const row = (properties: CaseRowWithCalculated["properties"] = {}) =>
	({
		case_id: "11111111-1111-4111-8111-111111111111",
		case_type: "patient",
		case_name: "Asha",
		app_id: "app",
		owner_id: "worker",
		status: "open",
		opened_on: null,
		modified_on: null,
		closed_on: null,
		external_id: null,
		parent_case_id: null,
		properties,
		calculated: {},
	}) as CaseRowWithCalculated;

const DISPLAY: ColumnDisplayContext = {
	calculatedTemporalTypes: new Map(),
	caseProperties: [],
	today: new Date("2026-05-06T12:00:00Z"),
	projectProse: (template) =>
		projectProseTemplate(template, { fields: {}, forms: {}, fieldOrder: {} })
			.text,
};

function emptyEvalContext(dayNumberEpoch: DayNumberEpoch): EvalContext {
	const data = new DataInstance();
	const root = testUuid("cell-model-root");
	data.initFromFields(buildFieldTree(root, {}, { [root]: [] }));
	const mainInstance = data.asXPathInstance();
	const rootNode = mainInstance.root();
	return {
		mainInstance,
		contextNode: rootNode,
		originalContextNode: rootNode,
		contextPath: "/",
		position: undefined,
		getValue: (path) => data.get(path),
		dayNumberEpoch,
	};
}

function withZone<T>(zone: string, run: () => T): T {
	const original = process.env.TZ;
	process.env.TZ = zone;
	try {
		return run();
	} finally {
		if (original === undefined) delete process.env.TZ;
		else process.env.TZ = original;
	}
}

const ENTRY_MODULE = testUuid("module"),
	ENTRY_FORM = testUuid("form"),
	ENTRY_POINT = testUuid("entry");

function entryPointArgs(platform: Platform) {
	const doc = buildDoc({
		appName: "Links",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: "module",
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "form",
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "notes" })],
					},
				],
			},
		],
	});
	doc.forms[ENTRY_FORM].entryPoint = { uuid: ENTRY_POINT, id: "visit" };
	doc.forms[ENTRY_FORM].hiddenFromMenu = true;
	assertAdmittedPreviewDoc(doc);
	const caseRow = (id: string, properties = {}): CaseRow => ({
		case_id: id,
		case_type: "patient",
		case_name: id,
		properties,
		parent_case_id: null,
		external_id: null,
		status: "open",
		opened_on: null,
		modified_on: null,
		closed_on: null,
		owner_id: "worker",
		app_id: "app",
	});
	return {
		doc,
		entryPointUuid: ENTRY_POINT,
		expectedSeq: 4,
		selections: [{ moduleUuid: ENTRY_MODULE, caseIds: ["outside"] }],
		database: { rows: [caseRow("held")], indices: [] as CaseIndexRow[] },
		session: { context: { userid: "worker" }, user: {}, userPropertySlugs: {} },
		lookup: { kind: "idle" as const },
		notHeld: {
			rows: [caseRow("outside", { village: "north" })],
			indices: [] as CaseIndexRow[],
		},
		rules: previewPlatformRules(platform),
	};
}

function searchFixture() {
	const name = simpleSearchInputDef(
		testUuid("cell-model-search-name"),
		"name",
		"Name",
		"text",
		"case_name",
		{ required: {} },
	);
	const doc = buildDoc({
		caseTypes: [{ name: "person", properties: [] }],
		modules: [
			{
				name: "People",
				caseType: "person",
				caseListConfig: { ...caseListConfig([]), searchInputs: [name] },
			},
		],
	});
	return {
		inputs: [name],
		session: { context: { username: "asha" }, user: {}, userPropertySlugs: {} },
		environment: { doc, moduleUuid: doc.moduleOrder[0] },
	};
}

// ── The checks ────────────────────────────────────────────────────────

export const PLATFORM_MODEL_CHECKS = {
	/* A calculate over the clock and a condition over it re-evaluate after
	 * an unrelated answer on Web Apps; a starting value does not; on Android
	 * neither moves. */
	"recalculation-every-request": () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const run = (platform: Platform) => {
				vi.setSystemTime(new Date("2026-05-06T12:00:00Z"));
				const engine = new FormEngine(
					engineFixtureInput(
						[
							{ id: "unrelated", kind: "text" },
							{ id: "day", kind: "hidden", calculate: "today()" },
							{
								id: "on_the_day",
								kind: "text",
								relevant: "#form/day = date('2026-05-06')",
							},
							{ id: "opened", kind: "hidden", default_value: "today()" },
						],
						{ formUuid: testUuid("cell-model-clock"), formType: "survey" },
					),
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					{
						device: platform === "web-apps" ? webAppsDevice() : androidDevice(),
					},
				);
				vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
				engine.setValue("/data/unrelated", "a");
				return {
					day: engine.getState("/data/day").value,
					onTheDay: engine.getState("/data/on_the_day").visible,
					opened: engine.getState("/data/opened").value,
				};
			};
			expect(run("web-apps")).toEqual({
				day: "2026-05-08",
				onTheDay: false,
				opened: "2026-05-06",
			});
			expect(run("android")).toEqual({
				day: "2026-05-06",
				onTheDay: true,
				opened: "2026-05-06",
			});
		} finally {
			vi.useRealTimers();
		}
	},

	/* Formplayer's day numbers count from UTC's midnight: the calendar day
	 * less one in Kiritimati, the day in Kolkata, one more twelve hours
	 * behind; fractional days are the instant over a day; `date(n)` is the
	 * same under both epochs; the evaluator reads the epoch it is given. */
	"day-number-utc-epoch": async () => {
		const may6 = Date.UTC(2026, 4, 6) / DAY_MS;
		for (const [zone, shift] of [
			["Pacific/Kiritimati", -1],
			["Asia/Kolkata", 0],
			["Etc/GMT+12", 1],
		] as const) {
			withZone(zone, () => {
				expect(coreDaysSinceEpoch(may6, "utc"), zone).toBe(may6 + shift);
				const instant = Date.parse("2026-05-06T07:30:00Z");
				expect(coreFractionalDays(instant, "utc"), zone).toBe(instant / DAY_MS);
				expect(coreDateAdd(20_579), zone).toBe(coreDateAdd(20_579));
			});
		}
		const today = evaluate("today()", emptyEvalContext("utc"));
		if (!(today instanceof XPathDate)) throw new Error("today() is a date");
		const utc = coreDaysSinceEpoch(today.calendarDays, "utc");
		expect(evaluate("int(today())", emptyEvalContext("utc"))).toBe(utc);
		expect(
			await evaluateAsync(
				"if(regex('a', 'a'), int(today()), -1)",
				emptyEvalContext("utc"),
			),
		).toBe(utc);
		expect(evaluate("int(today())", emptyEvalContext("device-zone"))).toBe(
			coreDaysSinceEpoch(today.calendarDays, "device-zone"),
		);
	},

	/* Java's ASCII `\w`, as Formplayer's JVM reads it. */
	"java-pattern-ascii-classes": async () => {
		const context = emptyEvalContext("utc");
		expect(await evaluateAsync("regex('é', '^\\w$')", context)).toBe(false);
		expect(await evaluateAsync("replace('a1é', '\\w', 'x')", context)).toBe(
			"xxé",
		);
	},

	/* Formplayer's session values on Web Apps, a phone's on Android. */
	"session-context-web-apps": () => {
		expect(
			previewSessionValues(null, { ...webAppsDevice("es"), windowWidth: 1280 })
				.context,
		).toEqual({
			deviceid: WEB_APPS_DEVICE_ID,
			appversion: WEB_APPS_APPVERSION,
			drift: "0",
			window_width: "1280",
			applanguage: "es",
		});
		const android = previewSessionValues(null, {
			...androidDevice("es"),
			windowWidth: 1280,
		}).context;
		expect(android).toEqual({
			deviceid: `${ANDROID_DEVICE_ID_PREFIX}${TEST_ANDROID_DEVICE_ID}`,
			appversion: androidAppVersion(),
			drift: "0",
			applanguage: "es",
		});
		expect(android).not.toHaveProperty("window_width");
	},

	/* Web Apps keeps a form off the menu off unless the entry point ignores
	 * display conditions, and claims the chosen case, the phone's or not. */
	"entry-point-web-apps": () => {
		expect(prepareEntryPointLaunch(entryPointArgs("web-apps")).kind).toBe(
			"refused",
		);
		const args = entryPointArgs("web-apps");
		args.doc.forms[ENTRY_FORM].hiddenFromMenu = false;
		const result = prepareEntryPointLaunch(args);
		if (result.kind !== "ready") throw new Error(result.message);
		expect(result.claimCaseIds).toEqual(["outside"]);
		expect(result.blankCaseIds).toEqual([]);
	},

	/* Android opens the form off the menu, claims nothing, and opens a case
	 * the phone lacks with no saved values. */
	"entry-point-android": () => {
		const result = prepareEntryPointLaunch(entryPointArgs("android"));
		if (result.kind !== "ready") throw new Error(result.message);
		expect(result.claimCaseIds).toEqual([]);
		expect(result.blankCaseIds).toEqual(["outside"]);
		expect(
			result.launch.menuSelections[ENTRY_MODULE].cases[0].caseProperties,
		).toEqual({});
	},

	"case-list-menu-item-web-apps": () => {
		expect(formlessCaseListSelection(WEB_APPS)).toEqual({
			kind: "root-menu",
			notice: "formlessReturned",
		});
		expect(formlessCaseListSelection(ANDROID)).toEqual({
			kind: "device-home",
		});
	},

	"tiles-flat-android": () => {
		const projection = projectTileGrid([
			plainColumn(NAME, "case_name", "Name", { tile: tileCell(0, 0, 2, 1) }),
			plainColumn(VILLAGE, "village", "Village", {
				tile: tileCell(0, 1, 2, 1),
			}),
		]);
		const split = splitTileGridByGroupHeader(projection, 1, ANDROID);
		expect(split.header.cells).toEqual([]);
		expect(split.body).toBe(projection);
	},

	"tile-border-shading-android": () => {
		const projection = projectTileGrid([
			plainColumn(NAME, "case_name", "Name", {
				tile: tileCell(0, 0, 2, 1, { showBorder: true, showShading: true }),
			}),
		]);
		const cell = projection.cells[0];
		expect(planTileCell(cell, WEB_APPS)).toMatchObject({
			bordered: true,
			shaded: true,
		});
		expect(planTileCell(cell, ANDROID)).toMatchObject({
			bordered: false,
			shaded: false,
		});
	},

	/* Android takes only a middle cell's vertical alignment; top and bottom
	 * draw at the top (the lane's observation, `computeGravity`). */
	"tile-vertical-align-android": () => {
		const projection = projectTileGrid([
			plainColumn(NAME, "case_name", "Name", {
				tile: tileCell(0, 0, 1, 1, { verticalAlign: "top" }),
			}),
			plainColumn(VILLAGE, "village", "Village", {
				tile: tileCell(1, 0, 1, 1, { verticalAlign: "middle" }),
			}),
			plainColumn(LINK, "district", "District", {
				tile: tileCell(2, 0, 1, 1, { verticalAlign: "bottom" }),
			}),
		]);
		const alignOf = (index: number) =>
			planTileCell(projection.cells[index], ANDROID).style.alignSelf;
		expect([alignOf(0), alignOf(1), alignOf(2)]).toEqual([
			"start",
			"center",
			"start",
		]);
	},

	/* A column hidden from Results still answers the quick filter. */
	"hidden-column-searchable": () => {
		const village = plainColumn(VILLAGE, "village", "Village");
		expect(
			rowMatchesFilterText(
				[],
				row({ village: "Riverside" }),
				"riverside",
				DISPLAY,
				{
					fields: [
						{
							column: village,
							position: 0,
							hidden: true,
							wire: "property",
							joinText: "village",
							comparator: "text",
						},
					],
					carriers: [],
					authored: [],
				},
			),
		).toBe(true);
	},

	/* Android's list shows a link column's markdown as written; the case
	 * detail shows the link on both. */
	"link-column-raw-android": () => {
		const column = linkColumn(LINK, "photo_url", "Photo", "View photo");
		const linked = row({ photo_url: "https://example.org/x" });
		expect(
			projectColumnDisplay(column, linked, {
				...DISPLAY,
				linkColumnInList: "raw-text",
			}).text,
		).toBe("[View photo](https://example.org/x)");
		expect(projectColumnDisplay(column, linked, DISPLAY).text).not.toBe(
			"[View photo](https://example.org/x)",
		);
	},

	/* Android searches whatever the answers: no checks, no required marks. */
	"search-field-checks-android": () => {
		const { inputs, session, environment } = searchFixture();
		expect(
			searchInputConstraintErrors(
				ANDROID,
				inputs,
				new Map(),
				session,
				environment,
			).size,
		).toBe(0);
		expect(
			searchInputRequiredMarks(ANDROID, inputs, new Map(), session, environment)
				.size,
		).toBe(0);
		expect(
			searchInputConstraintErrors(
				WEB_APPS,
				inputs,
				new Map(),
				session,
				environment,
			).size,
		).toBe(1);
	},

	/* Android draws a hidden Search field with a starting value as an
	 * ordinary field. */
	"hidden-search-field-android": () => {
		const hidden = hiddenSearchInputDef(
			testUuid("cell-model-hidden"),
			"district",
			"District",
			term(literal("north")),
		);
		expect(drawnSearchInputs([hidden], ANDROID)).toEqual([hidden]);
		expect(drawnSearchInputs([hidden], WEB_APPS)).toEqual([]);
	},

	/* A search that found nothing keeps the search screen on Android, and a
	 * claim is followed by a sync. */
	"search-android": () => {
		const after = (rules: typeof ANDROID) =>
			caseListStep({
				searchFirst: false,
				hasVisibleInputs: true,
				hasSubmitted: true,
				submittedFoundNothing: true,
				rules,
			});
		expect(after(ANDROID)).toBe("search");
		expect(after(WEB_APPS)).not.toBe("search");
		expect(ANDROID.claimThenSync).toBe(true);
	},

	/* Android never skips to results: the list comes first. */
	"skip-to-results-android": () => {
		const launches = (rules: typeof ANDROID) =>
			automaticallyLaunchesSearch({
				relevant: true,
				hasVisibleInputs: false,
				searchFirst: false,
				hasEffectiveFilter: true,
				rules,
			});
		expect(launches(ANDROID)).toBe(false);
		expect(launches(WEB_APPS)).toBe(true);
	},

	"after-submit-home-web-apps": () => {
		expect(appHomeLanding(WEB_APPS)).toBe("module-list");
	},

	"after-submit-home-android": () => {
		expect(appHomeLanding(ANDROID)).toBe("device-home");
	},

	/* Web Apps draws every section of a form on one screen. */
	"form-one-screen-web-apps": () => {
		const engine = new FormEngine(
			engineFixtureInput(
				[
					{
						id: "first",
						kind: "section",
						children: [{ id: "a", kind: "text" }],
					},
					{
						id: "second",
						kind: "section",
						children: [{ id: "b", kind: "text" }],
					},
				],
				{ formUuid: testUuid("cell-model-sections"), formType: "survey" },
			),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ device: webAppsDevice() },
		);
		expect(
			engine.formScreens().map(({ kind, path }) => ({ kind, path })),
		).toEqual([{ kind: "form", path: "/data" }]);
	},
} as const satisfies Readonly<
	Record<string, (platform: Platform) => void | Promise<void>>
>;

export type PlatformModelCheckId = keyof typeof PLATFORM_MODEL_CHECKS;
