/**
 * The model checks the cell table's `model` rows name
 * (`platformCells.ts`): each drives the production model for one platform
 * and asserts the observable that shows Preview plays the cell's reading.
 * `platformCells.test.ts` runs every check a row names, for that row's
 * platform.
 */

import { expect, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { rowsMatchingFilterText } from "@/components/preview/shared/listFilter";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { CaseIndexRow, CaseRow } from "@/lib/case-store";
import {
	ENDPOINT_MODULE,
	endpointWireFixture,
} from "@/lib/commcare/__tests__/endpointWireFixture";
import {
	asMediaAssetId,
	type CaseListOrderPlan,
	type Column,
	caseListOrderPlan,
	columnSort,
	hiddenSearchInputDef,
	imageMapColumn,
	linkColumn,
	type ProseTemplate,
	plainColumn,
	proseText,
	simpleSearchInputDef,
	tileCell,
} from "@/lib/domain";
import {
	FIXTURE_FORM,
	FIXTURE_MODULE,
	PLATFORM_FEATURE_FIXTURES,
} from "@/lib/domain/__tests__/platformFeatureFixtures";
import { literal, term } from "@/lib/domain/expression";
import type { Platform } from "@/lib/domain/platforms";
import { projectProseTemplate } from "@/lib/domain/prose";
import { appHomeLanding } from "../afterSubmitRouting";
import {
	completeAfterSubmit,
	EMPTY_AFTER_SUBMIT_STACK,
} from "../afterSubmitStack";
import { caseListMenuItemSelection } from "../caseListMenuItemRoute";
import { caseListStep } from "../caseListPhase";
import { previewRegisterAction } from "../caseListRegistration";
import { caseListSortOptions, LIST_ORDER } from "../caseListSortMenu";
import { caseListOwnWording } from "../caseListWording";
import { projectCaseMap } from "../caseMap";
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
import {
	caseListActionReturn,
	selectionsAfterRegistrationReturn,
} from "../engine/caseListRegisterAction";
import { DataInstance } from "../engine/dataInstance";
import { buildFieldTree } from "../engine/fieldTree";
import { FormEngine } from "../engine/formEngine";
import {
	type AfterSubmitFrameChoice,
	evaluateAfterSubmit,
} from "../engine/formLinkEvaluation";
import { firstMenuSelections } from "../engine/frameLanding";
import { previewSessionValues } from "../engine/identity";
import { resolvePreviousTask } from "../engine/previousTask";
import {
	searchInputConstraintErrors,
	searchInputRequiredMarks,
} from "../engine/searchInputConstraints";
import {
	startingSearchRange,
	webSearchRangeDraft,
} from "../engine/searchRangeAnswer";
import {
	drawnSearchInputs,
	searchInputAnswerKeys,
} from "../engine/searchRunState";
import { prepareEntryPointLaunch } from "../entryPointLaunch";
import { labelPresentation } from "../labelPresentation";
import { shownMenuBadge } from "../menuProjection";
import {
	ANDROID_DEVICE_ID_PREFIX,
	androidAppVersion,
	previewPlatformRules,
	WEB_APPS_APPVERSION,
	WEB_APPS_DEVICE_ID,
} from "../platform";
import { searchAfterClear } from "../searchStanding";
import { automaticSubmissionEntry } from "../submitOffer";
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

const REGISTER_HOST = testUuid("cell-model-register-host");
const REGISTER_FORM = testUuid("cell-model-register-form");
const REGISTER_ICON = asMediaAssetId(testUuid("cell-model-register-icon"));
const REGISTER_AUDIO = asMediaAssetId(testUuid("cell-model-register-audio"));

/** A case list that always offers another menu's registration form, its
 *  Register button holding an icon and a spoken label. */
function registerActionDoc() {
	const doc = buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: "cell-model-register-host",
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
			{
				name: "Registration",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "cell-model-register-form",
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	doc.modules[REGISTER_HOST].caseListRegistrationForm = {
		kind: "always",
		formUuid: REGISTER_FORM,
		icon: REGISTER_ICON,
		audioLabel: REGISTER_AUDIO,
		afterSubmit: "case-list",
	};
	assertAdmittedPreviewDoc(doc);
	return doc;
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

function firstMenuPrevious(platform: Platform) {
	const doc = PLATFORM_FEATURE_FIXTURES["first-menu-previous"].with();
	const patient = row();
	const task = resolvePreviousTask({
		doc,
		platform,
		formUuid: FIXTURE_FORM,
		submittedCaseIds: [patient.case_id],
		selections: {},
		caseDatabase: { rows: [patient], indices: [] },
	});
	expect(task.destination).toEqual({ kind: "home" });
	return (
		task.selections[FIXTURE_MODULE]?.cases.map((choice) => choice.caseId) ?? []
	);
}

/** A deep link to a form listed on the first menu, choosing patient "b":
 *  the menus whose entries read that same datum after Back to Home. */
function firstMenuEntryPoint(platform: Platform) {
	const doc = endpointWireFixture("first-menu");
	const result = prepareEntryPointLaunch({
		doc,
		entryPointUuid: testUuid("endpoint-identity"),
		expectedSeq: 4,
		selections: [{ moduleUuid: ENDPOINT_MODULE, caseIds: ["b"] }],
		database: {
			rows: [{ ...row(), case_id: "b", case_name: "b" }],
			indices: [] as CaseIndexRow[],
		},
		session: { context: { userid: "worker" }, user: {}, userPropertySlugs: {} },
		lookup: { kind: "idle" as const },
		notHeld: { rows: [] as CaseRow[], indices: [] as CaseIndexRow[] },
		rules: previewPlatformRules(platform),
	});
	if (result.kind !== "ready") throw new Error(result.message);
	return Object.fromEntries(
		Object.entries(result.launch.firstMenuSelections ?? {}).map(
			([moduleUuid, selection]) => [
				moduleUuid,
				selection.cases.map((choice) => choice.caseId),
			],
		),
	);
}

const FIRST_MENU_ABOVE = testUuid("cell-model-first-menu-visits");
const FIRST_MENU_HOST = testUuid("cell-model-first-menu-reviews");
const FIRST_MENU_REGISTER = testUuid("cell-model-first-menu-register");

/** Visits lists its patient follow-up on the first menu; Reviews, under it,
 *  always offers another menu's registration and returns to the new case. */
function firstMenuRegistrationDoc() {
	const doc = buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			...["Visits", "Reviews"].map((name) => ({
				uuid: `cell-model-first-menu-${name.toLowerCase()}`,
				name,
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: name === "Visits" ? "Visit" : "Review",
						type: "followup" as const,
						fields: [f({ kind: "text", id: "note" })],
					},
				],
			})),
			{
				uuid: "cell-model-first-menu-registration",
				name: "Registration",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "cell-model-first-menu-register",
						name: "Register patient",
						type: "registration" as const,
						fields: [
							f({
								kind: "text",
								id: "patient",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	doc.modules[FIRST_MENU_ABOVE].formsInMenuAbove = true;
	doc.modules[FIRST_MENU_HOST].parentModuleUuid = FIRST_MENU_ABOVE;
	doc.modules[FIRST_MENU_HOST].caseListRegistrationForm = {
		kind: "always",
		formUuid: FIRST_MENU_REGISTER,
		afterSubmit: "new-case",
	};
	assertAdmittedPreviewDoc(doc);
	return doc;
}

/** Register from Reviews' list, then Back to Home: the first-menu choice the
 *  return frame leaves for the next command that reads it. */
function firstMenuRegistration(platform: Platform) {
	const doc = firstMenuRegistrationDoc();
	const landing = caseListActionReturn(
		doc,
		FIRST_MENU_REGISTER,
		{ hostModuleUuid: FIRST_MENU_HOST },
		"registered",
	);
	if (!landing) throw new Error("Register returns to the new case.");
	const next = selectionsAfterRegistrationReturn(
		{},
		landing,
		FIRST_MENU_HOST,
		"patient",
		{ caseId: "registered", caseName: "Asha" },
	);
	expect(next[FIRST_MENU_HOST]?.cases[0]?.caseId).toBe("registered");
	const home = firstMenuSelections(
		landing.firstMenuCases,
		next,
		previewPlatformRules(platform),
	);
	return home?.[FIRST_MENU_ABOVE]?.cases.map((choice) => choice.caseId) ?? [];
}

export const PLATFORM_MODEL_CHECKS = {
	/* A deep link through a first menu that shares one case: Web Apps
	 * opens Home fresh; Android keeps the case for both menus that read it. */
	"first-menu-entry-point-web-apps": () => {
		expect(firstMenuEntryPoint("web-apps")).toEqual({});
	},
	"first-menu-entry-point-android": () => {
		expect(firstMenuEntryPoint("android")).toEqual({
			[ENDPOINT_MODULE]: ["b"],
			[testUuid("endpoint-second-patient-menu")]: ["b"],
		});
	},
	/* Register's return through that first menu carries the new case to its
	 * list on both; only Android keeps it on Home after Back. */
	"first-menu-registration-web-apps": () => {
		expect(firstMenuRegistration("web-apps")).toEqual([]);
	},
	"first-menu-registration-android": () => {
		expect(firstMenuRegistration("android")).toEqual(["registered"]);
	},
	"first-menu-previous-web-apps": () => {
		expect(firstMenuPrevious("web-apps")).toEqual([]);
	},
	"first-menu-previous-android": () => {
		expect(firstMenuPrevious("android")).toEqual([row().case_id]);
	},

	"desktop-search-on-clear": () => {
		expect(searchAfterClear(true, WEB_APPS, 991)).toBe(false);
		expect(searchAfterClear(true, WEB_APPS, 992)).toBe(true);
		expect(searchAfterClear(false, WEB_APPS, 992)).toBe(false);
		expect(searchAfterClear(true, ANDROID, 1280)).toBe(false);
	},
	/* Formplayer reads the presence pragmas, Android none: a Web Apps form
	 * holding automatic submission submits once per entry when its submit is
	 * offered, and an Android one waits for the worker. */
	"presence-pragmas-on-web-apps-only": () => {
		const opening = {
			active: true,
			enabled: true,
			offered: "offered" as const,
			entry: "second-visit",
			attempted: undefined,
		};
		const web = {
			...opening,
			platformAllows: previewPlatformRules("web-apps").webAppsFormPragmas,
		};
		expect(automaticSubmissionEntry(web)).toBe("second-visit");
		expect(
			automaticSubmissionEntry({ ...web, attempted: "second-visit" }),
		).toBeUndefined();
		expect(
			automaticSubmissionEntry({ ...web, offered: "waiting" }),
		).toBeUndefined();
		expect(automaticSubmissionEntry({ ...web, active: false })).toBeUndefined();
		expect(
			automaticSubmissionEntry({
				...opening,
				platformAllows: previewPlatformRules("android").webAppsFormPragmas,
			}),
		).toBeUndefined();
	},
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

	/* A row's starting value beside a calculation that reads a value the
	 * row's insertion set first: a later starting value in the row reads it,
	 * and the row keeps it on Android, while Web Apps works the calculation
	 * out again on the next answer, so the starting value never reaches the
	 * form Web Apps sends. Both platforms take the calculation once what it
	 * reads changes. */
	"row-starting-value": () => {
		const run = (platform: Platform) => {
			const engine = new FormEngine(
				engineFixtureInput(
					[
						{ id: "unrelated", kind: "text" },
						{
							id: "rows",
							kind: "repeat",
							repeat_mode: "user_controlled",
							children: [
								{ id: "note", kind: "text", default_value: "'a'" },
								{
									id: "value",
									kind: "hidden",
									default_value: "'D'",
									calculate: "concat(../note, '!')",
								},
								{ id: "seen", kind: "text", default_value: "../value" },
							],
						},
					],
					{ formUuid: testUuid("cell-model-row-value"), formType: "survey" },
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
			engine.addRepeat("/data/rows");
			const inserted = {
				value: engine.getState("/data/rows[0]/value").value,
				seen: engine.getState("/data/rows[0]/seen").value,
			};
			engine.setValue("/data/unrelated", "u");
			const afterUnrelated = engine.getState("/data/rows[0]/value").value;
			engine.setValue("/data/rows[0]/note", "ab");
			return {
				inserted,
				afterUnrelated,
				afterRead: engine.getState("/data/rows[0]/value").value,
			};
		};
		expect(run("web-apps")).toEqual({
			inserted: { value: "D", seen: "D" },
			afterUnrelated: "a!",
			afterRead: "ab!",
		});
		expect(run("android")).toEqual({
			inserted: { value: "D", seen: "D" },
			afterUnrelated: "D",
			afterRead: "ab!",
		});
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
		args.doc.forms[ENTRY_FORM].hiddenFromMenu = undefined;
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

	/* Choosing a case from a case list menu entry shows the screen before it
	 * again in Web Apps, and returns to the phone's home screen on Android. */
	"case-list-menu-item-web-apps": () => {
		expect(caseListMenuItemSelection(WEB_APPS)).toEqual({ kind: "step-back" });
		expect(caseListMenuItemSelection(ANDROID)).toEqual({
			kind: "device-home",
		});
	},

	/* The Register button on a case list shows its text alone in Web Apps,
	 * and its icon and spoken label beside it on Android. */
	"register-action-media": () => {
		const doc = registerActionDoc();
		expect(previewRegisterAction(doc, REGISTER_HOST, "web-apps")).toMatchObject(
			{
				label: "Register patient",
				icon: undefined,
				audioLabel: undefined,
			},
		);
		expect(previewRegisterAction(doc, REGISTER_HOST, "android")).toMatchObject({
			label: "Register patient",
			icon: REGISTER_ICON,
			audioLabel: REGISTER_AUDIO,
		});
	},

	/* A label's QR code takes the image's place on Android and shows nowhere
	 * in Web Apps, and an inline video takes the place of both; its spoken text's speaker button shows on Android where the
	 * label has no audio, and nowhere in Web Apps. */
	"label-texts": () => {
		const image = asMediaAssetId(testUuid("platform-cells-label-image"));
		const card = {
			uuid: testUuid("platform-cells-label-card"),
			id: "card",
			kind: "label",
			label: proseText("Show the card"),
			qr_code: proseText("ID-17"),
			spoken_text: proseText("Show the card"),
			label_media: { image },
		} as const;
		const project = (template: ProseTemplate) =>
			template.parts
				.map((part) => (part.kind === "text" ? part.text : ""))
				.join("");
		const shown = (platform: Platform) =>
			labelPresentation(
				card,
				false,
				previewPlatformRules(platform),
				{},
				project,
			);
		expect(shown("web-apps")).toMatchObject({
			qrCode: undefined,
			speech: undefined,
			media: { image },
		});
		expect(shown("android")).toMatchObject({
			qrCode: "ID-17",
			speech: "Show the card",
			media: { image: undefined },
		});
		/* An inline video plays on Android in the place of the QR code and the
		 * image alike, and shows nowhere in Web Apps. */
		const video = asMediaAssetId(testUuid("platform-cells-label-video"));
		const film = { ...card, label_media: { image, videoInline: video } };
		const played = (platform: Platform) =>
			labelPresentation(
				film,
				false,
				previewPlatformRules(platform),
				{},
				project,
			);
		expect(played("web-apps")).toMatchObject({
			qrCode: undefined,
			media: { image, videoInline: undefined },
		});
		expect(played("android")).toMatchObject({
			qrCode: undefined,
			media: { image: undefined, videoInline: video },
		});
	},

	/* A menu or form badge: Web Apps shows the evaluated text whole; Android
	 * hides an empty or exactly "0" badge and shortens a longer one, "999+"
	 * where a Java int reads it, else its first three units and "..". */
	"menu-badge-android": () => {
		const values = [
			"",
			"0",
			"New",
			"0000",
			"1234",
			"-2147483648",
			"2147483648",
			"Équipe",
		];
		expect(values.map((text) => shownMenuBadge(text, "web-apps"))).toEqual(
			values,
		);
		expect(values.map((text) => shownMenuBadge(text, "android"))).toEqual([
			"",
			"",
			"New",
			"999+",
			"999+",
			"999+",
			"214..",
			"Équ..",
		]);
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
			filterKeepsRow([], row({ village: "Riverside" }), "riverside", DISPLAY, {
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
				introductionOrders: [],
				calculations: [],
			}),
		).toBe(true);
	},

	/* Web Apps lists a hidden sort field under its name in Sort by only in a
	 * case tile list, whose Sort By lists every sort field; a list of columns
	 * sorts by the headers it shows. Android lists it in both. */
	"sort-label-web-apps": () => {
		const feeling = plainColumn(VILLAGE, "feeling_sick", "", {
			visibleInList: false,
			sort: columnSort("desc", 0, undefined, "Feeling Sick"),
		});
		const listed = (tiled: boolean, platform: Platform) => {
			const name = plainColumn(NAME, "case_name", "Name", {
				...(tiled && { tile: tileCell(0, 0, 1, 1) }),
			});
			const config = {
				columns: [name, feeling],
				searchInputs: [],
				listColumnOrder: [NAME, VILLAGE],
				detailColumnOrder: [NAME, VILLAGE],
				...(tiled && { tile: {} }),
			};
			return caseListSortOptions({
				plan: caseListOrderPlan(config, [], {
					mediaOn: true,
					calculatedType: () => undefined,
					expressionText: () => "",
				}),
				columns: config.columns,
				rules: previewPlatformRules(platform).sortMenu,
				tiled,
				choice: LIST_ORDER,
			}).map((option) => option.name);
		};
		expect(listed(false, "web-apps")).toEqual([]);
		expect(listed(true, "web-apps")).toEqual(["Feeling Sick"]);
		expect(listed(false, "android")).toEqual(["Name", "Feeling Sick"]);
		expect(listed(true, "android")).toEqual(["Name", "Feeling Sick"]);
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

	/* A case list's own empty text and Continue label: Web Apps draws both,
	 * the label on its several-case Continue only; Android keeps its own. */
	"case-list-own-wording": (platform) => {
		const wording = caseListOwnWording(previewPlatformRules(platform), {
			emptyText: "No patients yet",
			selectButtonText: "Visit these patients",
		});
		expect(wording).toEqual(
			platform === "android"
				? {}
				: {
						emptyText: "No patients yet",
						continueText: "Visit these patients",
					},
		);
	},

	/* An image rule's description is what Web Apps reads for its picture;
	 * Android shows the picture alone. */
	"case-image-description-android": (platform) => {
		const column = imageMapColumn(LINK, "priority", "Priority", [
			{
				value: "urgent",
				assetId: asMediaAssetId(testUuid("cell-model-urgent")),
				altText: "Urgent case",
			},
		]);
		const shown = projectColumnDisplay(column, row({ priority: "urgent" }), {
			...DISPLAY,
			readsCaseImageDescriptions:
				previewPlatformRules(platform).readsCaseImageDescriptions,
		});
		expect(shown.kind).toBe("image");
		expect("altText" in shown ? shown.altText : undefined).toBe(
			platform === "android" ? undefined : "Urgent case",
		);
	},

	/* Android marks a case at its first location that holds one; Web Apps
	 * reads the first location alone. */
	"case-map-fallback-android": (platform) => {
		const home = testUuid("cell-model-home");
		const clinic = testUuid("cell-model-clinic");
		const values = new Map([
			[home, ""],
			[clinic, "12.5 3.25"],
		]);
		const geometry = projectCaseMap(
			platform,
			{ locations: [home, clinic], layers: {} },
			(id) => values.get(id) ?? "",
		);
		expect(geometry.location).toEqual(
			platform === "android" ? { lat: 12.5, lng: 3.25 } : undefined,
		);
	},

	/* Android searches whatever the answers: no checks, no required marks. */
	"starting-dates-android": () => {
		expect(
			startingSearchRange(
				"2024-03-10 to 2024-03-11",
				"device-zone",
				"America/New_York",
			),
		).toEqual({ kind: "pair", from: "2024-03-09", to: "2024-03-10" });
		expect(
			startingSearchRange("unfinished", "device-zone", "America/New_York"),
		).toEqual({ kind: "unparsed", text: "unfinished" });
	},
	"starting-dates-web-apps": () => {
		const range = simpleSearchInputDef(
			testUuid("platform-range"),
			"dates",
			"Dates",
			"date-range",
			"dob",
		);
		expect(startingSearchRange("2024-03-10 to 2024-03-11", "utc")).toEqual({
			kind: "pair",
			from: "2024-03-10",
			to: "2024-03-11",
		});
		expect(
			webSearchRangeDraft([range], new Map([["dates:starting", "unfinished"]]))
				.unavailable?.inputUuid,
		).toBe(range.uuid);
	},
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

	/* Android reads no `hidden`: it draws a hidden value, with or without a
	 * starting value, and a field Web Apps does not draw, as ordinary fields;
	 * Web Apps draws none of them (`SearchInputForm` reads the same rule). */
	"search-address-picker-android": () => {
		const source = {
			kind: "address",
			type: "address",
			uuid: testUuid("address-source"),
			name: "source",
			label: "Address",
		} as const;
		const receiver = {
			...simpleSearchInputDef(
				testUuid("address-receiver"),
				"city",
				"City",
				"text",
				"city",
			),
			addressReceiver: {
				kind: "address",
				source: source.uuid,
				parts: ["city"] as "city"[],
			},
		} as const;
		expect(drawnSearchInputs([source, receiver], ANDROID)).toEqual([receiver]);
		expect(drawnSearchInputs([source, receiver], WEB_APPS)).toEqual([
			source,
			receiver,
		]);
		expect(searchInputAnswerKeys([source, receiver])).toEqual(
			new Set(["city"]),
		);
	},
	"hidden-search-field-android": () => {
		const hidden = hiddenSearchInputDef(
			testUuid("cell-model-hidden"),
			"district",
			"District",
			term(literal("north")),
		);
		const empty = hiddenSearchInputDef(
			testUuid("cell-model-hidden-empty"),
			"zone",
			"Zone",
			undefined,
		);
		const field = simpleSearchInputDef(
			testUuid("cell-model-hidden-field"),
			"region",
			"Region",
			"text",
			"region",
			{ hidden: true, default: term(literal("north")) },
		);
		expect(drawnSearchInputs([hidden, empty, field], ANDROID)).toEqual([
			hidden,
			empty,
			field,
		]);
		expect(drawnSearchInputs([hidden, empty, field], WEB_APPS)).toEqual([]);
		expect(ANDROID.hiddenSearchField).toBe("editable");
		expect(WEB_APPS.hiddenSearchField).toBe("hidden");
	},

	/* Android reads no `allow_blank_value`: its Search screen draws the field
	 * alone, so no blank is ever ticked or sent; Web Apps draws the box
	 * (`SearchInputForm`'s row reads this rule; the browser witness is
	 * `preview-search-audit.spec.ts`). */
	"search-for-blank-android": () => {
		expect(ANDROID.searchForBlank).toBe(false);
		expect(WEB_APPS.searchForBlank).toBe(true);
	},

	/* A search that found nothing keeps the search screen on Android, and a
	 * claim is followed by a sync. */
	"search-android": () => {
		const after = (rules: typeof ANDROID) =>
			caseListStep({
				workflow: "searchFirst",
				formsReadSearch: false,
				searchRelevant: true,
				hasSubmitted: true,
				submittedFoundNothing: true,
				rules,
			});
		expect(after(ANDROID)).toBe("search");
		expect(after(WEB_APPS)).not.toBe("search");
		expect(ANDROID.claimThenSync).toBe(true);
	},

	/* Android never opens on Search: the list comes first, with the Search
	 * action. */
	"search-first-android": () => {
		const opens = (rules: typeof ANDROID) =>
			caseListStep({
				workflow: "searchFirst",
				formsReadSearch: false,
				searchRelevant: true,
				hasSubmitted: false,
				rules,
			});
		expect(opens(ANDROID)).toBe("browse");
		expect(opens(WEB_APPS)).toBe("search");
	},

	/* Android never skips to results: the list comes first. */
	"skip-to-results-android": () => {
		const opens = (rules: typeof ANDROID) =>
			caseListStep({
				workflow: "skipToResults",
				formsReadSearch: false,
				searchRelevant: true,
				hasSubmitted: false,
				rules,
			});
		expect(opens(ANDROID)).toBe("browse");
		expect(opens(WEB_APPS)).toBe("results");
	},

	"after-submit-home-web-apps": () => {
		expect(appHomeLanding(WEB_APPS)).toBe("module-list");
	},

	"after-submit-home-android": () => {
		expect(appHomeLanding(ANDROID)).toBe("device-home");
	},

	/* Web Apps opens the frame on top alone: of two destinations that both
	 * hold, the author's first opens, and once it is submitted its own
	 * destination follows, never the second. */
	"after-submit-top-frame-web-apps": () => {
		const MENU = testUuid("cell-model-visits");
		const SOURCE = testUuid("cell-model-source");
		const FIRST = testUuid("cell-model-first");
		const SECOND = testUuid("cell-model-second");
		const doc = buildDoc({
			appName: "Visits",
			modules: [
				{
					uuid: "cell-model-visits",
					name: "Visits",
					forms: [
						{
							uuid: "cell-model-source",
							name: "Source",
							type: "survey",
							formLinks: [
								{
									uuid: "cell-model-to-first",
									target: { type: "form", moduleUuid: MENU, formUuid: FIRST },
								},
								{
									uuid: "cell-model-to-second",
									target: { type: "form", moduleUuid: MENU, formUuid: SECOND },
								},
							],
							fields: [f({ kind: "text", id: "note", label: "Note" })],
						},
						{
							uuid: "cell-model-first",
							name: "First",
							type: "survey",
							postSubmit: "module",
							fields: [f({ kind: "text", id: "note", label: "Note" })],
						},
						{
							uuid: "cell-model-second",
							name: "Second",
							type: "survey",
							fields: [f({ kind: "text", id: "note", label: "Note" })],
						},
					],
				},
			],
		});
		const frames = (formUuid: typeof SOURCE) =>
			evaluateAfterSubmit({
				input: {
					doc,
					formUuid,
					session: previewSessionValues(null, webAppsDevice()),
					usercase: {},
					sessionDatums: new Map(),
				},
			}).map((route) => ({ route, landing: [] }));
		const pushed = frames(SOURCE);
		expect(pushed).toHaveLength(2);
		const opened = completeAfterSubmit<AfterSubmitFrameChoice>(
			EMPTY_AFTER_SUBMIT_STACK,
			[],
			pushed,
			WEB_APPS.afterSubmitFrames,
		);
		expect(opened.next).toMatchObject({
			kind: "destination",
			link: { target: { formUuid: FIRST } },
		});
		expect(opened.state.pending).toEqual([]);
		const followed = completeAfterSubmit(
			opened.state,
			[],
			frames(FIRST),
			WEB_APPS.afterSubmitFrames,
		);
		expect(followed.next).toEqual({
			kind: "post-submit",
			destination: "module",
		});
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

/** Whether the list's filter, exact and as Web Apps runs it, keeps the row. */
function filterKeepsRow(
	columns: readonly Column[],
	row: CaseRowWithCalculated,
	filterText: string,
	context: ColumnDisplayContext,
	plan?: CaseListOrderPlan,
): boolean {
	return (
		rowsMatchingFilterText(columns, [row], filterText, context, plan, {
			fuzzy: false,
			rules: previewPlatformRules("web-apps").listFilter,
			edited: true,
			imageReference: () => undefined,
		}).length === 1
	);
}
