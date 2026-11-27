import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { buildCaseTypeMap, withProjectContext } from "@/lib/case-store";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { setPreviewSearchSettings } from "@/lib/deployment/previewSearchSettings";
import { toRscSerializableDoc } from "@/lib/doc/ownRecords";
import {
	calculatedColumn,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import { count, eq, gt, literal, prop, term } from "@/lib/domain/expression";
import { resolvePreviewSearchFacts } from "../../searchSettings";
import {
	loadCaseDataAction,
	loadCasesAction,
	loadSearchResultsSnapshotAction,
} from "../caseDataBinding";
import { resolveAuthorizedPreviewContext } from "../previewAuthorization";
import {
	keepSearchResultDetail,
	readKeptSearchResultDetail,
	SearchDetailFrameTooLarge,
} from "../searchResultReceipt";
import { androidDevice, webAppsDevice } from "./fixtures/previewDevices";

const ACTOR = "search-response-worker";
const PROJECT = "search-response-project";
const APP = "search-response-app";
const LOCAL = { kind: "local" } as const;
const auth = vi.hoisted(() => ({ sessionId: "search-response-first-session" }));
vi.mock("@/lib/auth-utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/auth-utils")>()),
	getSession: async () => ({
		user: { id: ACTOR, name: "Amara", email: "amara@dimagi.com" },
		session: { id: auth.sessionId },
	}),
}));
vi.mock("../caseDataBindingTelemetry", async (importOriginal) => ({
	...(await importOriginal<typeof import("../caseDataBindingTelemetry")>()),
	reportUnexpectedActionError: (_action: string, error: unknown) => {
		throw error;
	},
}));
const h = setupAppStateTestDb("preview_search_response_", {
	authSchema: "migrated",
	poolMax: 4,
});

it.each(["literal", "property"] as const)(
	"checks a Search requirement comparing a %s against the authorized worker restore",
	async (match) => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		await sql`INSERT INTO auth_session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
		VALUES (${auth.sessionId}, ${auth.sessionId}, ${ACTOR}, now()+interval '1 hour', now(), now())`.execute(
			h.db(),
		);
		const required = gt(
			count({
				kind: "cases",
				source: "casedb",
				where: [
					eq(
						{ kind: "case-row-type" },
						{ kind: "case-type", caseType: "patient" },
					),
					eq(
						prop("patient", "standing"),
						match === "literal"
							? literal("active")
							: prop("patient", "village"),
					),
				],
			}),
			literal(0),
		);
		const doc = buildDoc({
			appId: APP,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "standing", label: "Standing", data_type: "text" },
						{ name: "village", label: "Village", data_type: "text" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListMenuItem: {},
					caseSearchConfig: {},
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						searchInputs: [
							simpleSearchInputDef(
								testUuid("required-worker-restore-name"),
								"patient_name",
								"Patient name",
								"text",
								"case_name",
								{
									required: { when: required, message: "Give a patient name." },
								},
							),
						],
					},
				},
			],
		});
		await h.seedAppWithBlueprint(doc, {
			id: APP,
			owner: ACTOR,
			projectId: PROJECT,
		});
		const store = await withProjectContext(PROJECT, ACTOR, ACTOR);
		await store.applySchemaChange({
			appId: APP,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(doc),
		});
		const saved = await setPreviewSearchSettings(
			{ appId: APP, projectId: PROJECT },
			ACTOR,
			LOCAL,
			"0",
			{
				maximum: 500,
				propertyMatchers: { ignoredText: [], fuzzyProperties: [] },
			},
		);
		if (saved.kind !== "saved")
			throw new Error(`Search settings refused: ${saved.kind}`);
		const revision = resolvePreviewSearchFacts(saved.catalog, LOCAL).revision;
		const moduleUuid = doc.moduleOrder[0];
		const search = (
			device = webAppsDevice(),
			inputValues: Record<string, string> = {},
		) =>
			loadCasesAction({
				appId: APP,
				caseType: "patient",
				moduleUuid,
				blueprint: toRscSerializableDoc(doc),
				caseListConfig: doc.modules[moduleUuid].caseListConfig,
				search: true,
				searchSubmission: crypto.randomUUID(),
				device: { ...device, searchConfiguration: { target: LOCAL, revision } },
				inputValues,
				page: { offset: 0, limit: 10 },
			});
		const insert = async (
			caseStore: typeof store,
			id: string,
			standing = "active",
		) =>
			caseStore.insert({
				appId: APP,
				row: {
					case_id: id,
					case_type: "patient",
					case_name: id,
					properties: { standing, village: "active" },
				},
			});
		const other = await withProjectContext(PROJECT, ACTOR, "other-case-owner");
		await insert(other, "outside-the-restore");
		await insert(store, "inactive", "inactive");
		expect(await search()).toMatchObject({ kind: "rows" });
		await insert(store, "Amina");
		expect(await search()).toMatchObject({
			kind: "invalid-search",
			repair: "inputs",
			message: "Give a patient name.",
		});
		expect(
			await search(webAppsDevice(), { patient_name: "Amina" }),
		).toMatchObject({
			kind: "rows",
			rows: [{ case_id: "Amina" }],
		});
		expect(await search(androidDevice())).toMatchObject({ kind: "rows" });
	},
);

it("opens a form on the same search response that supplied Results", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
	const secondSession = "search-response-second-session";
	for (const session of [auth.sessionId, secondSession]) {
		await sql`INSERT INTO auth_session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
			VALUES (${session}, ${session}, ${ACTOR}, now()+interval '1 hour', now(), now())`.execute(
			h.db(),
		);
	}
	const doc = buildDoc({
		appId: APP,
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListMenuItem: {},
				caseSearchConfig: { formsReadSearch: true },
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					searchInputs: [
						simpleSearchInputDef(
							testUuid("search-response-name"),
							"name",
							"Name",
							"text",
							"case_name",
						),
					],
				},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ id: "note", kind: "text" })],
					},
				],
			},
		],
	});
	await h.seedAppWithBlueprint(doc, {
		id: APP,
		owner: ACTOR,
		projectId: PROJECT,
	});
	const store = await withProjectContext(PROJECT, ACTOR, ACTOR);
	await store.applySchemaChange({
		appId: APP,
		caseType: "patient",
		caseTypeSchemas: buildCaseTypeMap(doc),
	});
	const saved = await setPreviewSearchSettings(
		{ appId: APP, projectId: PROJECT },
		ACTOR,
		LOCAL,
		"0",
		{
			maximum: 500,
			propertyMatchers: { ignoredText: [], fuzzyProperties: [] },
		},
	);
	if (saved.kind !== "saved")
		throw new Error(`Search settings refused: ${saved.kind}`);
	const revision = resolvePreviewSearchFacts(saved.catalog, LOCAL).revision;
	const moduleUuid = doc.moduleOrder[0];
	const { caseListConfig: config } = doc.modules[moduleUuid];
	const request = {
		appId: APP,
		caseType: "patient",
		moduleUuid,
		blueprint: toRscSerializableDoc(doc),
		caseListConfig: config,
		searchSubmission: crypto.randomUUID(),
		device: {
			...webAppsDevice(),
			searchConfiguration: { target: LOCAL, revision },
		},
		inputValues: {},
	};
	await store.insert({
		appId: APP,
		row: {
			case_id: "served",
			case_type: "patient",
			case_name: "Old name",
			properties: {},
		},
	});
	const results = await loadCasesAction({
		...request,
		search: true,
		page: { offset: 0, limit: 10 },
	});
	expect(results).toMatchObject({
		kind: "rows",
		rows: [{ case_id: "served", case_name: "Old name" }],
	});
	if (results.kind !== "rows" || results.resultReceipt === undefined)
		throw new Error("Search did not issue a response receipt.");
	await store.update({
		appId: APP,
		caseId: "served",
		patch: { status: "closed", case_name: "New name" },
	});
	await store.insert({
		appId: APP,
		row: {
			case_id: "replacement",
			case_type: "patient",
			case_name: "Replacement",
			properties: {},
		},
	});
	const form = {
		...request,
		formUuid: Object.values(doc.forms)[0].uuid,
		resultReceipt: results.resultReceipt,
	};
	expect(await loadSearchResultsSnapshotAction(form)).toMatchObject({
		kind: "data",
		snapshot: {
			totalMatches: 1,
			rows: [{ case_id: "served", case_name: "Old name", status: "open" }],
		},
	});
	const fresh = await loadCasesAction({
		...request,
		search: true,
		searchSubmission: crypto.randomUUID(),
		page: { offset: 0, limit: 10 },
	});
	expect(fresh).toMatchObject({
		kind: "rows",
		searchMatchCount: 1,
		rows: [{ case_id: "replacement" }],
	});
	expect(
		await loadSearchResultsSnapshotAction({
			...form,
			searchSubmission: crypto.randomUUID(),
		}),
	).toMatchObject({ kind: "invalid-search" });
	const opening = await loadSearchResultsSnapshotAction(form);
	if (opening.kind !== "data")
		throw new Error("The original results were lost.");
	const resolveDetailContext = async () => {
		const context = await resolveAuthorizedPreviewContext({
			appId: APP,
			required: "view",
			loadBlueprint: true,
			device: request.device,
		});
		if (context.kind !== "ready")
			throw new Error("The fixture worker did not open.");
		return context;
	};
	const context = await resolveDetailContext();
	const resultScope = {
		appId: APP,
		moduleUuid,
		caseType: "patient",
		submission: request.searchSubmission,
		previewRun: crypto.randomUUID(),
	};
	const prompt = testUuid("search-response-name");
	const unanswered = testUuid("search-response-unanswered");
	const frame = {
		visibleCaseIds: ["served"],
		answers: [
			{ inputUuid: prompt, answer: "original typed text" },
			{ inputUuid: unanswered, answer: null },
		],
	};
	const detailReceipt = await keepSearchResultDetail(
		resultScope,
		context,
		frame,
	);
	const countReceipts = async () =>
		(
			await sql<{
				count: number;
			}>`SELECT COUNT(*)::int AS count FROM form_opening_data
			WHERE session_id = ${auth.sessionId}`.execute(h.db())
		).rows[0].count;
	const beforeOverflow = await countReceipts();
	await expect(
		keepSearchResultDetail(resultScope, context, {
			visibleCaseIds: ["served"],
			answers: [{ inputUuid: prompt, answer: "🟦".repeat(80_000) }],
		}),
	).rejects.toBeInstanceOf(SearchDetailFrameTooLarge);
	expect(await countReceipts()).toBe(beforeOverflow);

	frame.answers[0].answer = "later draft";
	frame.visibleCaseIds.push("filtered-by-device");
	expect(
		await readKeptSearchResultDetail(
			resultScope,
			context,
			detailReceipt,
			"served",
			prompt,
		),
	).toEqual({ answer: "original typed text" });
	expect(
		await readKeptSearchResultDetail(
			resultScope,
			context,
			detailReceipt,
			"served",
			unanswered,
		),
	).toEqual({ answer: null });
	expect(
		await readKeptSearchResultDetail(
			resultScope,
			context,
			detailReceipt,
			"replacement",
			prompt,
		),
	).toBeUndefined();
	expect(
		await readKeptSearchResultDetail(
			resultScope,
			context,
			detailReceipt,
			"served",
			testUuid("other-prompt"),
		),
	).toBeUndefined();
	expect(
		await readKeptSearchResultDetail(
			resultScope,
			context,
			results.resultReceipt,
			"served",
			prompt,
		),
	).toBeUndefined();
	expect(
		await readKeptSearchResultDetail(
			{ ...resultScope, submission: crypto.randomUUID() },
			context,
			detailReceipt,
			"served",
			prompt,
		),
	).toBeUndefined();
	expect(
		await loadSearchResultsSnapshotAction({
			...form,
			resultReceipt: detailReceipt,
		}),
	).toMatchObject({ kind: "invalid-search" });

	expect(
		await readKeptSearchResultDetail(
			resultScope,
			context,
			detailReceipt,
			"filtered-by-device",
			prompt,
		),
	).toBeUndefined();

	const firstSession = auth.sessionId;
	try {
		auth.sessionId = secondSession;
		expect(
			await readKeptSearchResultDetail(
				resultScope,
				await resolveDetailContext(),
				detailReceipt,
				"served",
				prompt,
			),
		).toBeUndefined();
		expect(await loadSearchResultsSnapshotAction(form)).toMatchObject({
			kind: "invalid-search",
		});
	} finally {
		auth.sessionId = firstSession;
	}
	await sql`UPDATE auth_session SET "expiresAt" = now() - interval '1 second'
		WHERE id = ${firstSession}`.execute(h.db());
	expect(
		await readKeptSearchResultDetail(
			resultScope,
			context,
			detailReceipt,
			"served",
			prompt,
		),
	).toBeUndefined();
	await sql`UPDATE auth_session SET "expiresAt" = now() + interval '1 hour'
		WHERE id = ${firstSession}`.execute(h.db());

	expect(
		await setPreviewSearchSettings(
			{ appId: APP, projectId: PROJECT },
			ACTOR,
			LOCAL,
			"1",
			{ maximum: 1500 },
		),
	).toMatchObject({ kind: "saved" });
	expect(await loadSearchResultsSnapshotAction(form)).toMatchObject({
		kind: "invalid-search",
		reason: { kind: "search-settings-changed" },
	});
});

const detailVariants = [
	"submitted answer",
	"submitted date",
	"submitted date range",
	"fixed text",
	"a Results-only answer",
] as const;
it.each(detailVariants)(
	"restores standalone Details with %s",
	testStandaloneDetails,
);

async function testStandaloneDetails(branch: (typeof detailVariants)[number]) {
	const fixed = branch === "fixed text";
	const range = branch === "submitted date range";
	const date = range || branch === "submitted date";
	const inputName = date ? "dob" : "name";
	const birthday = "2025-03-09";
	const submitted = range
		? "__range__2025-03-01__2025-03-31"
		: date
			? birthday
			: "Asha";
	const answers: Record<string, string> = range
		? { "dob:from": "2025-03-01", "dob:to": "2025-03-31" }
		: { [inputName]: submitted };
	const onList = branch === "a Results-only answer";
	const actor = ACTOR;
	const appId = "search-detail-restored-app";
	const sessionId = "search-detail-restored-session";
	auth.sessionId = sessionId;
	await h.seedProjectMember(actor, PROJECT, "owner");
	await sql`INSERT INTO auth_session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
		VALUES (${sessionId}, ${sessionId}, ${actor}, now()+interval '1 hour', now(), now())`.execute(
		h.db(),
	);
	const inputUuid = testUuid("standalone-detail-name");
	const columnUuid = testUuid("standalone-detail-column");
	const column = {
		...calculatedColumn(
			columnUuid,
			"Entered name",
			term(literal(onList ? "" : "local row")),
			onList
				? { visibleInDetail: false }
				: { notOnList: true, visibleInList: false },
		),
		searchResultDetail: fixed
			? { text: "entered=[]" }
			: onList
				? { inputUuid, prefix: "", suffix: "", onList: true as const }
				: { inputUuid, prefix: "entered=[", suffix: "]" },
	};
	const ordinaryList = caseListConfig([{ field: "case_name", header: "Name" }]);
	const fixture = buildDoc({
		appId,
		caseTypes: [
			{
				name: "patient",
				properties: date
					? [{ name: "dob", label: proseText("Born on"), data_type: "date" }]
					: [],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				...(onList ? {} : { caseListMenuItem: {} }),
				caseSearchConfig: {},
				caseListConfig: {
					columns: [...ordinaryList.columns, column],
					listColumnOrder: [...ordinaryList.listColumnOrder, columnUuid],
					detailColumnOrder: [columnUuid, ...ordinaryList.detailColumnOrder],
					searchInputs: [
						simpleSearchInputDef(
							inputUuid,
							inputName,
							date ? "Born on" : "Name",
							range ? "date-range" : date ? "date" : "text",
							date ? "dob" : "case_name",
						),
					],
				},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ id: "note", kind: "text" })],
					},
				],
			},
		],
	});
	const doc = {
		...fixture,
		appSettings: { ...fixture.appSettings, runsOnlyOn: "web-apps" as const },
		localization: {
			sourceLanguage: "eng" as const,
			defaultLanguage: "eng" as const,
			languageOrder: ["eng", "spa"] as ("eng" | "spa")[],
			wireCodes: { eng: "en", spa: "es" },
			translations: { spa: {} },
		},
	};
	await h.seedAppWithBlueprint(doc, {
		id: appId,
		owner: actor,
		projectId: PROJECT,
	});
	const store = await withProjectContext(PROJECT, actor, actor);
	await store.applySchemaChange({
		appId,
		caseType: "patient",
		caseTypeSchemas: buildCaseTypeMap(doc),
	});
	for (const caseId of ["one", "two"]) {
		await store.insert({
			appId,
			row: {
				case_id: caseId,
				case_type: "patient",
				case_name: "Asha",
				properties: date ? { dob: birthday } : {},
			},
		});
	}
	const saved = await setPreviewSearchSettings(
		{ appId, projectId: PROJECT },
		actor,
		LOCAL,
		"0",
		{
			maximum: 500,
			propertyMatchers: { ignoredText: [], fuzzyProperties: [] },
		},
	);
	if (saved.kind !== "saved")
		throw new Error("Search settings were not saved.");
	const revision = resolvePreviewSearchFacts(saved.catalog, LOCAL).revision;
	const moduleUuid = doc.moduleOrder[0];
	const config = doc.modules[moduleUuid].caseListConfig;
	const device = {
		...webAppsDevice(),
		searchConfiguration: { target: LOCAL, revision },
	};
	const request = {
		appId,
		caseType: "patient",
		moduleUuid,
		blueprint: toRscSerializableDoc(doc),
		caseListConfig: config,
		device,
		search: true,
		page: { offset: 0, limit: 1 },
	};
	if (onList) {
		for (const [inputValues, expected] of [
			[{ name: "Asha" }, "Asha"],
			[{}, ""],
		] as const) {
			expect(
				await loadCasesAction({
					...request,
					searchSubmission: crypto.randomUUID(),
					inputValues,
				}),
			).toMatchObject({
				kind: "rows",
				searchMatchCount: 2,
				rows: [{ calculated: { [columnUuid]: expected } }],
			});
		}
		return;
	}

	const run = async (inputValues: Record<string, string>) => {
		const submission = crypto.randomUUID();
		const previewRun = crypto.randomUUID();
		const runScope = { previewRun };
		const results = await loadCasesAction({
			...request,
			...runScope,
			searchSubmission: submission,
			inputValues,
		});
		expect(results).toMatchObject({ kind: "rows", searchMatchCount: 2 });
		if (results.kind !== "rows" || !results.resultReceipt || !results.rows[0])
			throw new Error("The Results page did not offer a signed case.");
		expect(results.rows[0].calculated[columnUuid]).toBe("local row");
		return {
			chosen: results.rows[0].case_id,
			opening: { ...runScope, submission, receipt: results.resultReceipt },
		};
	};
	const answered = await run(answers);
	const unanswered = await run({});
	const reopen = (
		caseId: string,
		opening?: typeof answered.opening,
		options: { includeHeld?: boolean; wireLanguage?: string } = {},
	) =>
		loadCaseDataAction(
			appId,
			"patient",
			caseId,
			0,
			config,
			undefined,
			undefined,
			options.includeHeld,
			undefined,
			true,
			undefined,
			request.blueprint,
			moduleUuid,
			false,
			null,
			{ ...device, appLanguage: options.wireLanguage ?? device.appLanguage },
			{ [inputName]: date ? "2024-11-03" : "edited draft" },
			undefined,
			undefined,
			opening,
		);
	expect(await reopen(answered.chosen, answered.opening)).toMatchObject({
		kind: "row",
		row: {
			calculated: {
				[columnUuid]: fixed ? "entered=[]" : `entered=[${submitted}]`,
			},
		},
	});

	expect(
		await reopen(answered.chosen, answered.opening, { wireLanguage: "es" }),
	).toMatchObject({
		kind: "row",
		row: {
			calculated: {
				[columnUuid]: fixed ? "entered=[]" : `entered=[${submitted}]`,
			},
		},
	});
	expect(await reopen(unanswered.chosen, unanswered.opening)).toMatchObject({
		kind: "row",
		row: { calculated: { [columnUuid]: "entered=[]" } },
	});
	expect(
		await reopen(answered.chosen, {
			...answered.opening,
			previewRun: unanswered.opening.previewRun,
		}),
	).toMatchObject({ kind: "error" });
	expect(await reopen(answered.chosen)).toMatchObject({
		kind: "row",
		row: { calculated: { [columnUuid]: "local row" } },
	});
	expect(
		await reopen(answered.chosen === "one" ? "two" : "one", answered.opening),
	).toMatchObject({
		kind: "error",
	});
	expect(
		await reopen(answered.chosen, {
			...answered.opening,
			submission: unanswered.opening.submission,
		}),
	).toMatchObject({
		kind: "error",
	});
	const countReceipts = async () =>
		(
			await sql<{
				count: number;
			}>`SELECT COUNT(*)::int AS count FROM form_opening_data
			WHERE session_id = ${sessionId}`.execute(h.db())
		).rows[0].count;
	const beforeEmpty = await countReceipts();
	expect(
		await loadCasesAction({
			...request,
			previewRun: answered.opening.previewRun,
			searchSubmission: crypto.randomUUID(),
			inputValues: {
				[inputName]: { value: "crafted non-text" },
			} as unknown as Record<string, string>,
		}),
	).toMatchObject({ kind: "invalid-search", repair: "inputs" });
	expect(await countReceipts()).toBe(beforeEmpty);

	const empty = await loadCasesAction({
		...request,
		previewRun: answered.opening.previewRun,
		searchSubmission: crypto.randomUUID(),
		inputValues: range
			? { "dob:from": "2024-11-01", "dob:to": "2024-11-30" }
			: { [inputName]: date ? "2024-11-03" : "Nobody on this page" },
	});
	expect(empty).toMatchObject({ kind: "empty" });
	expect(empty).not.toHaveProperty("resultReceipt");
	expect(await countReceipts()).toBe(beforeEmpty);

	await sql`INSERT INTO parked_case_values
		(app_id, case_id, case_type, property, original_value, reason)
		VALUES (${appId}, ${answered.chosen}, 'patient', 'old_value', '"held"'::jsonb, 'fixture hold')`.execute(
		h.db(),
	);
	expect(
		await reopen(answered.chosen, undefined, { includeHeld: true }),
	).toMatchObject({ kind: "row" });
	expect(
		await reopen(answered.chosen, answered.opening, { includeHeld: true }),
	).toEqual({ kind: "missing" });
}
