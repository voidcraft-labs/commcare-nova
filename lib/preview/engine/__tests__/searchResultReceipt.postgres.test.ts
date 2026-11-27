import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { buildCaseTypeMap, withProjectContext } from "@/lib/case-store";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { setPreviewSearchSettings } from "@/lib/deployment/previewSearchSettings";
import { toRscSerializableDoc } from "@/lib/doc/ownRecords";
import { simpleSearchInputDef } from "@/lib/domain";
import { resolvePreviewSearchFacts } from "../../searchSettings";
import {
	loadCasesAction,
	loadSearchResultsSnapshotAction,
} from "../caseDataBinding";
import { resolveAuthorizedPreviewContext } from "../previewAuthorization";
import {
	keepSearchResult,
	readKeptSearchResultDetail,
} from "../searchResultReceipt";
import { webAppsDevice } from "./fixtures/previewDevices";

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
	};
	const prompt = testUuid("search-response-name");
	const unanswered = testUuid("search-response-unanswered");
	const offeredRow = opening.snapshot.rows[0];
	const primary = {
		rows: [offeredRow, { ...offeredRow, case_id: "filtered-by-device" }],
		totalMatches: 2,
	};
	const frame = {
		visibleCaseIds: ["served"],
		answers: [
			{ inputUuid: prompt, answer: "original typed text" },
			{ inputUuid: unanswered, answer: null },
		],
	};
	const detailReceipt = await keepSearchResult(
		resultScope,
		context,
		primary,
		frame,
	);
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
	).toEqual({ kind: "data", snapshot: primary });

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
