/**
 * One pair of documents for every platform feature: `with()` holds exactly
 * one use of the feature, `without()` the nearest document that holds none,
 * and `use` names the use `with()` holds, its owner and its site. Shared by
 * the detector test (`platformUses.test.ts`) and the parity test of the
 * table and the gate (`lib/commcare/validator/__tests__/platformAvailability.test.ts`).
 *
 * Typed over every `PlatformFeatureId`, so a new feature, refusable or not,
 * fails to compile until it has its pair. Every document is built with
 * `buildDoc`, which declares the platform its content runs on; a test of a
 * declaration sets `appSettings` on the result itself.
 */

import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	type CaseListConfigSpec,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import {
	type AppSettings,
	type BlueprintDoc,
	type Column,
	type ConnectType,
	calculatedColumn,
	hiddenSearchInputDef,
	linkColumn,
	type Module,
	NEW_APP_SETTINGS,
	type PlatformFeatureId,
	type PlatformFeatureUse,
	plainColumn,
	proseText,
	type SearchInputDef,
	simpleSearchInputDef,
	tileCell,
} from "@/lib/domain";
import { eq, literal, prop, term } from "@/lib/domain/expression";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";

export interface PlatformFeatureFixture {
	/** A document holding exactly one use of the feature. */
	readonly with: () => BlueprintDoc;
	/** The nearest document holding none. */
	readonly without: () => BlueprintDoc;
	/** The use `with()` holds. */
	readonly use:
		| PlatformFeatureUse
		| ((doc: BlueprintDoc) => PlatformFeatureUse);
}

export const FIXTURE_MODULE = testUuid("platform-fixture-module");
export const FIXTURE_FORM = testUuid("platform-fixture-form");
export const FIXTURE_FIELD = testUuid("platform-fixture-field");
export const FIXTURE_COLUMN = testUuid("platform-fixture-column");
export const FIXTURE_INPUT = testUuid("platform-fixture-input");
const REGISTER_FORM = testUuid("platform-fixture-register");
const DATE_FIELD = testUuid("platform-fixture-date");
const ASSET = testMediaAssetId("platform-fixture-asset");

const MODULE_OWNER = { kind: "module", moduleUuid: FIXTURE_MODULE } as const;
const FORM_OWNER = {
	kind: "form",
	moduleUuid: FIXTURE_MODULE,
	formUuid: FIXTURE_FORM,
} as const;
const FIELD_OWNER = {
	kind: "field",
	moduleUuid: FIXTURE_MODULE,
	formUuid: FIXTURE_FORM,
	fieldUuid: FIXTURE_FIELD,
} as const;
const COLUMN_OWNER = {
	kind: "column",
	moduleUuid: FIXTURE_MODULE,
	columnUuid: FIXTURE_COLUMN,
} as const;
const INPUT_OWNER = {
	kind: "search-input",
	moduleUuid: FIXTURE_MODULE,
	inputUuid: FIXTURE_INPUT,
} as const;

/** A survey app whose one form holds `fields`. */
function survey(
	fields: FieldSpec[],
	options: {
		readonly connectType?: ConnectType;
		readonly appSettings?: AppSettings;
		readonly configure?: (doc: BlueprintDoc) => void;
		readonly postSubmit?: "firstMenu";
	} = {},
): BlueprintDoc {
	return buildDoc(
		{
			appName: "Platforms",
			...(options.connectType === undefined
				? {}
				: { connectType: options.connectType }),
			...(options.appSettings === undefined
				? {}
				: { appSettings: options.appSettings }),
			modules: [
				{
					uuid: FIXTURE_MODULE,
					name: "Survey",
					forms: [
						{
							uuid: FIXTURE_FORM,
							name: "Intake",
							type: "survey",
							...(options.connectType === undefined
								? {}
								: {
										connect:
											options.connectType === "learn"
												? {
														learn_module: {
															id: "lesson",
															name: "Lesson",
															description: "Read it",
															time_estimate: 5,
														},
													}
												: { deliver_unit: { id: "visit", name: "Visit" } },
									}),
							...(options.postSubmit === undefined
								? {}
								: { postSubmit: options.postSubmit }),
							fields,
						},
					],
				},
			],
		},
		options.configure,
	);
}

/** A survey whose one field is `spec`, under the fixture field's uuid. */
function oneField(spec: FieldSpec): BlueprintDoc {
	return survey([f({ ...spec, uuid: FIXTURE_FIELD })]);
}

/** A survey whose one hidden value is calculated by `calculate`, beside a
 * date question `d` and a text question `t` it may read. */
function calculated(calculate: string): BlueprintDoc {
	return survey([
		f({ kind: "date", id: "d", uuid: DATE_FIELD, label: proseText("Day") }),
		f({ kind: "text", id: "t", label: proseText("Note") }),
		f({ kind: "hidden", id: "value", uuid: FIXTURE_FIELD, calculate }),
	]);
}

/** The use of a hidden value's calculate, at the root of its expression. */
function calculateUse(feature: PlatformFeatureId): PlatformFeatureUse {
	return {
		feature,
		owner: FIELD_OWNER,
		site: {
			kind: "expression",
			ref: { entity: "field", uuid: FIXTURE_FIELD, slot: "calculate" },
			path: [],
		},
	};
}

/** A case app: a module on `patient` with a Name column, a registration form
 * and a follow-up form. */
function caseApp(
	options: {
		readonly columns?: Column[];
		readonly list?: (config: CaseListConfigSpec) => void;
		readonly module?: Partial<
			Pick<Module, "caseSearchConfig" | "caseListOnly">
		>;
		readonly searchInputs?: SearchInputDef[];
	} = {},
): BlueprintDoc {
	const config: CaseListConfigSpec = caseListConfig([
		{ field: "case_name", header: "Name" },
	]);
	if (options.columns !== undefined) {
		config.columns = [...config.columns, ...options.columns];
		config.listColumnOrder = config.columns.map((column) => column.uuid);
		config.detailColumnOrder = config.columns.map((column) => column.uuid);
	}
	if (options.searchInputs !== undefined)
		config.searchInputs = options.searchInputs;
	options.list?.(config);
	const listOnly = options.module?.caseListOnly === true;
	return buildDoc({
		appName: "Platforms",
		modules: [
			{
				uuid: FIXTURE_MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				...(options.module?.caseSearchConfig === undefined
					? {}
					: { caseSearchConfig: options.module.caseSearchConfig }),
				...(listOnly ? { caseListOnly: true } : {}),
				forms: listOnly
					? []
					: [
							{
								uuid: FIXTURE_FORM,
								name: "Visit",
								type: "followup",
								fields: [
									f({ kind: "text", id: "note", label: proseText("Note") }),
								],
							},
						],
			},
			...(listOnly
				? [
						{
							name: "Registration",
							caseType: "patient",
							caseListConfig: caseListConfig([
								{ field: "case_name", header: "Name" },
							]),
							forms: [
								{
									uuid: REGISTER_FORM,
									name: "Register",
									type: "registration" as const,
									fields: [
										f({
											kind: "text",
											id: "name",
											label: proseText("Name"),
											caseWrite: { caseType: "patient", property: "case_name" },
										}),
									],
								},
							],
						},
					]
				: []),
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "status", label: proseText("Status") },
					{ name: "dob", label: proseText("Date of birth"), data_type: "date" },
					{ name: "website", label: proseText("Website") },
				],
			},
		],
	});
}

function input(
	type: "text" | "date" | "barcode",
	slots: Parameters<typeof simpleSearchInputDef>[5] = {},
): SearchInputDef {
	return simpleSearchInputDef(
		FIXTURE_INPUT,
		"dob",
		"Date of birth",
		type,
		type === "date" ? "dob" : "case_name",
		slots,
	);
}

function slotUse(
	feature: PlatformFeatureId,
	owner: PlatformFeatureUse["owner"],
	slot: string,
): PlatformFeatureUse {
	return { feature, owner, site: { kind: "slot", slot } };
}

function fieldKindPair(
	feature: PlatformFeatureId,
	kind: FieldSpec["kind"],
	extra: Record<string, unknown> = {},
): PlatformFeatureFixture {
	return {
		with: () =>
			oneField({ kind, id: "answer", label: proseText("Answer"), ...extra }),
		without: () =>
			oneField({ kind: "text", id: "answer", label: proseText("Answer") }),
		use: slotUse(feature, FIELD_OWNER, "kind"),
	};
}

function calculatePair(
	feature: PlatformFeatureId,
	withCalculate: string,
	withoutCalculate = "1",
): PlatformFeatureFixture {
	return {
		with: () => calculated(withCalculate),
		without: () => calculated(withoutCalculate),
		use: calculateUse(feature),
	};
}

const CONNECT: PlatformFeatureFixture = {
	with: () =>
		survey([f({ kind: "text", id: "answer", label: proseText("Answer") })], {
			connectType: "learn",
		}),
	without: () =>
		survey([f({ kind: "text", id: "answer", label: proseText("Answer") })]),
	use: slotUse("connect-app", { kind: "app" }, "connectType"),
};

const tiled =
	(cell: Parameters<typeof tileCell>[4]) => (config: CaseListConfigSpec) => {
		config.columns = config.columns.map((column, index) =>
			index === 0
				? { ...column, uuid: FIXTURE_COLUMN, tile: tileCell(0, 0, 4, 1, cell) }
				: column,
		);
		config.listColumnOrder = config.columns.map((column) => column.uuid);
		config.detailColumnOrder = config.columns.map((column) => column.uuid);
		config.tile = {};
	};

const SKIP_FILTER = eq(prop("patient", "status"), literal("open"));

export const PLATFORM_FEATURE_FIXTURES = {
	"datetime-question": fieldKindPair("datetime-question", "datetime"),
	"case-list-here": {
		with: () =>
			caseApp({
				columns: [
					calculatedColumn(FIXTURE_COLUMN, "Distance", { kind: "here" }),
				],
			}),
		without: () =>
			caseApp({
				columns: [
					calculatedColumn(FIXTURE_COLUMN, "Distance", { kind: "today" }),
				],
			}),
		use: {
			feature: "case-list-here",
			owner: COLUMN_OWNER,
			site: {
				kind: "expression",
				ref: {
					entity: "module",
					uuid: FIXTURE_MODULE,
					slot: "case_list_column_expression",
					member: { columnUuid: FIXTURE_COLUMN },
				},
				path: [],
			},
		},
	},
	"search-first": {
		with: () =>
			caseApp({
				searchInputs: [input("text")],
				module: { caseSearchConfig: { searchFirst: true } },
			}),
		without: () =>
			caseApp({
				searchInputs: [input("text")],
				module: { caseSearchConfig: {} },
			}),
		use: slotUse("search-first", MODULE_OWNER, "caseSearchConfig.searchFirst"),
	},
	"several-cases": {
		with: () =>
			caseApp({
				list: (config) => {
					config.selection = { kind: "multiple", maximum: 10 };
				},
			}),
		without: () => caseApp(),
		use: slotUse("several-cases", MODULE_OWNER, "caseListConfig.selection"),
	},
	"search-field-single-date": {
		with: () => caseApp({ searchInputs: [input("date")] }),
		without: () => caseApp({ searchInputs: [input("text")] }),
		use: slotUse(
			"search-field-single-date",
			INPUT_OWNER,
			"caseListConfig.searchInputs[0].type",
		),
	},
	"search-field-multiple-choice": {
		with: () =>
			caseApp({
				searchInputs: [
					simpleSearchInputDef(
						FIXTURE_INPUT,
						"regions",
						"Regions",
						"multi-select",
						"status",
						{
							options: {
								kind: "lookup",
								tableId: lookupTableIdSchema.parse(
									"018f0000-0000-7000-8000-0000000000a1",
								),
								valueColumnId: lookupColumnIdSchema.parse(
									"018f0000-0000-7000-8000-0000000000a2",
								),
								labelColumnId: lookupColumnIdSchema.parse(
									"018f0000-0000-7000-8000-0000000000a3",
								),
							},
						},
					),
				],
			}),
		without: () => caseApp({ searchInputs: [input("text")] }),
		use: slotUse(
			"search-field-multiple-choice",
			INPUT_OWNER,
			"caseListConfig.searchInputs[0].type",
		),
	},
	"connect-app": CONNECT,
	"location-question": fieldKindPair("location-question", "geopoint"),
	"barcode-question": fieldKindPair("barcode-question", "barcode"),
	"image-question": fieldKindPair("image-question", "image"),
	"audio-question": fieldKindPair("audio-question", "audio"),
	"video-question": fieldKindPair("video-question", "video"),
	"question-pages": {
		with: () =>
			survey([
				f({
					kind: "section",
					id: "page",
					uuid: FIXTURE_FIELD,
					label: proseText("Page"),
					children: [
						f({ kind: "text", id: "answer", label: proseText("Answer") }),
					],
				}),
			]),
		without: () =>
			survey([
				f({
					kind: "group",
					id: "page",
					uuid: FIXTURE_FIELD,
					label: proseText(""),
					children: [
						f({ kind: "text", id: "answer", label: proseText("Answer") }),
					],
				}),
			]),
		use: slotUse("question-pages", FIELD_OWNER, "kind"),
	},
	"choice-media": {
		with: () =>
			oneField({
				kind: "single_select",
				id: "answer",
				label: proseText("Answer"),
				options: [
					{
						value: "a",
						label: "A",
						uuid: "platform-fixture-option",
						media: { image: ASSET },
					},
					{ value: "b", label: "B" },
				],
			}),
		without: () =>
			oneField({
				kind: "single_select",
				id: "answer",
				label: proseText("Answer"),
				options: [
					{ value: "a", label: "A", uuid: "platform-fixture-option" },
					{ value: "b", label: "B" },
				],
			}),
		use: slotUse(
			"choice-media",
			{
				...FIELD_OWNER,
				kind: "option",
				optionUuid: testUuid("platform-fixture-option"),
			},
			"media",
		),
	},
	"help-media": {
		with: () =>
			oneField({
				kind: "text",
				id: "answer",
				label: proseText("Answer"),
				help: "Ask twice",
				help_media: { image: ASSET },
			}),
		without: () =>
			oneField({
				kind: "text",
				id: "answer",
				label: proseText("Answer"),
				help: "Ask twice",
			}),
		use: slotUse("help-media", FIELD_OWNER, "help_media"),
	},
	now: calculatePair("now", "now()"),
	today: calculatePair("today", "today()"),
	"random-and-unique-id": calculatePair("random-and-unique-id", "random()"),
	pause: calculatePair("pause", "sleep(1, /data/t)", "/data/t"),
	"date-as-number": calculatePair(
		"date-as-number",
		"int(/data/d)",
		"int(/data/t)",
	),
	"json-property": calculatePair(
		"json-property",
		"json-property(/data/t, 'name')",
		"/data/t",
	),
	"case-conversion": calculatePair(
		"case-conversion",
		"upper-case(/data/t)",
		"/data/t",
	),
	"text-pattern": calculatePair(
		"text-pattern",
		"replace(/data/t, 'a', 'b')",
		"/data/t",
	),
	"device-id": calculatePair(
		"device-id",
		"instance('commcaresession')/session/context/deviceid",
		"instance('commcaresession')/session/context/userid",
	),
	"app-version": calculatePair(
		"app-version",
		"instance('commcaresession')/session/context/appversion",
		"instance('commcaresession')/session/context/userid",
	),
	"entry-points": {
		with: () =>
			survey([f({ kind: "text", id: "answer", label: proseText("Answer") })], {
				configure: (doc) => {
					const form = doc.forms[FIXTURE_FORM];
					if (form !== undefined)
						form.entryPoint = {
							uuid: testUuid("platform-fixture-entry"),
							id: "intake",
						};
				},
			}),
		without: () =>
			survey([f({ kind: "text", id: "answer", label: proseText("Answer") })]),
		use: slotUse(
			"entry-points",
			{
				kind: "entry-point",
				target: {
					kind: "form",
					moduleUuid: FIXTURE_MODULE,
					formUuid: FIXTURE_FORM,
				},
			},
			"entryPoint",
		),
	},
	"case-list-menu-item": {
		with: () => caseApp({ module: { caseListOnly: true } }),
		without: () => caseApp(),
		use: slotUse("case-list-menu-item", MODULE_OWNER, "caseListOnly"),
	},
	"tile-grouping": {
		with: () =>
			caseApp({
				list: (config) => {
					tiled({ verticalAlign: "middle" })(config);
					config.tile = { grouping: { identifier: "parent", headerRows: 1 } };
				},
			}),
		without: () => caseApp({ list: tiled({ verticalAlign: "middle" }) }),
		use: slotUse("tile-grouping", MODULE_OWNER, "caseListConfig.tile.grouping"),
	},
	"tile-alignment": {
		with: () => caseApp({ list: tiled({ verticalAlign: "top" }) }),
		without: () => caseApp({ list: tiled({ verticalAlign: "middle" }) }),
		use: slotUse(
			"tile-alignment",
			COLUMN_OWNER,
			"caseListConfig.columns[0].tile.verticalAlign",
		),
	},
	"tile-border-and-shading": {
		with: () =>
			caseApp({ list: tiled({ verticalAlign: "middle", showBorder: true }) }),
		without: () => caseApp({ list: tiled({ verticalAlign: "middle" }) }),
		use: slotUse(
			"tile-border-and-shading",
			COLUMN_OWNER,
			"caseListConfig.columns[0].tile.showBorder",
		),
	},
	"column-hidden-from-results": {
		with: () =>
			caseApp({
				columns: [
					plainColumn(FIXTURE_COLUMN, "status", "Status", {
						visibleInList: false,
					}),
				],
			}),
		without: () =>
			caseApp({
				columns: [
					plainColumn(FIXTURE_COLUMN, "status", "Status", {
						visibleInList: false,
					}),
				],
				list: (config) => {
					tiled({ verticalAlign: "middle" })(config);
					config.columns = config.columns.map((column, index) =>
						index === 0
							? { ...column, uuid: testUuid("platform-fixture-name") }
							: column,
					);
					config.listColumnOrder = config.columns.map((column) => column.uuid);
					config.detailColumnOrder = config.columns.map(
						(column) => column.uuid,
					);
				},
			}),
		use: slotUse(
			"column-hidden-from-results",
			COLUMN_OWNER,
			"caseListConfig.columns[1].visibleInList",
		),
	},
	"link-column": {
		with: () =>
			caseApp({
				columns: [linkColumn(FIXTURE_COLUMN, "website", "Website", "Open")],
			}),
		without: () =>
			caseApp({ columns: [plainColumn(FIXTURE_COLUMN, "website", "Website")] }),
		use: slotUse("link-column", COLUMN_OWNER, "caseListConfig.columns[1].kind"),
	},
	"search-screen-text": {
		with: () =>
			caseApp({
				searchInputs: [input("text")],
				module: { caseSearchConfig: { searchScreenTitle: "Find a patient" } },
			}),
		without: () =>
			caseApp({
				searchInputs: [input("text")],
				module: { caseSearchConfig: {} },
			}),
		use: slotUse(
			"search-screen-text",
			MODULE_OWNER,
			"caseSearchConfig.searchScreenTitle",
		),
	},
	"search-field-checks": {
		with: () => caseApp({ searchInputs: [input("text", { required: {} })] }),
		without: () => caseApp({ searchInputs: [input("text")] }),
		use: slotUse(
			"search-field-checks",
			INPUT_OWNER,
			"caseListConfig.searchInputs[0].required",
		),
	},
	"barcode-search-field": {
		with: () => caseApp({ searchInputs: [input("barcode")] }),
		without: () => caseApp({ searchInputs: [input("text")] }),
		use: slotUse(
			"barcode-search-field",
			INPUT_OWNER,
			"caseListConfig.searchInputs[0].type",
		),
	},
	"hidden-search-field": {
		with: () =>
			caseApp({
				searchInputs: [
					hiddenSearchInputDef(
						FIXTURE_INPUT,
						"region",
						"Region",
						term(literal("North")),
					),
				],
			}),
		without: () => caseApp({ searchInputs: [input("text")] }),
		use: slotUse(
			"hidden-search-field",
			INPUT_OWNER,
			"caseListConfig.searchInputs[0].kind",
		),
	},
	search: {
		with: () => caseApp({ searchInputs: [input("text")] }),
		without: () => caseApp(),
		use: slotUse("search", MODULE_OWNER, "caseSearchConfig"),
	},
	"skip-to-results": {
		with: () =>
			caseApp({
				module: { caseSearchConfig: {} },
				list: (config) => {
					config.filter = SKIP_FILTER;
				},
			}),
		without: () => caseApp({ module: { caseSearchConfig: {} } }),
		use: slotUse("skip-to-results", MODULE_OWNER, "caseListConfig.filter"),
	},
	"after-submit-home": {
		with: () =>
			survey([f({ kind: "text", id: "answer", label: proseText("Answer") })]),
		without: () =>
			survey([f({ kind: "text", id: "answer", label: proseText("Answer") })], {
				postSubmit: "firstMenu",
			}),
		use: slotUse("after-submit-home", FORM_OWNER, "postSubmit"),
	},
	"app-logo": {
		with: () =>
			survey([f({ kind: "text", id: "answer", label: proseText("Answer") })], {
				configure: (doc) => {
					doc.logo = ASSET;
				},
			}),
		without: () =>
			survey([f({ kind: "text", id: "answer", label: proseText("Answer") })]),
		use: slotUse("app-logo", { kind: "app" }, "logo"),
	},
	"saved-forms": {
		with: () =>
			survey([f({ kind: "text", id: "answer", label: proseText("Answer") })], {
				appSettings: { ...NEW_APP_SETTINGS, showSavedForms: true },
			}),
		without: () =>
			survey([f({ kind: "text", id: "answer", label: proseText("Answer") })], {
				appSettings: { ...NEW_APP_SETTINGS },
			}),
		use: slotUse("saved-forms", { kind: "app" }, "appSettings.showSavedForms"),
	},
	"incomplete-forms": {
		with: () =>
			survey([f({ kind: "text", id: "answer", label: proseText("Answer") })], {
				appSettings: { ...NEW_APP_SETTINGS, showIncompleteForms: true },
			}),
		without: () =>
			survey([f({ kind: "text", id: "answer", label: proseText("Answer") })], {
				appSettings: { ...NEW_APP_SETTINGS },
			}),
		use: slotUse(
			"incomplete-forms",
			{ kind: "app" },
			"appSettings.showIncompleteForms",
		),
	},
	"connect-location-capture": {
		...CONNECT,
		use: slotUse("connect-location-capture", { kind: "app" }, "connectType"),
	},
} as const satisfies Readonly<
	Record<PlatformFeatureId, PlatformFeatureFixture>
>;

/** The use a fixture names, over its own `with()` document. */
export function plantedUse(
	fixture: PlatformFeatureFixture,
	doc: BlueprintDoc,
): PlatformFeatureUse {
	return typeof fixture.use === "function" ? fixture.use(doc) : fixture.use;
}
