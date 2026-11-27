import { proseText } from "@/lib/domain/prose";
// Submission-program acceptance: the ENGINE's collected answers flow
// through the PURE program builder into the REAL storage executor —
// proving the production supplier produces executor-compatible programs
// over a real committed-doc shape. Covers the form's own case (its
// creates under the ids its entry minted, its close under the committed
// close condition), the absent-value matrix (blank answer → absent JSONB
// key; blank authored key → typed whole-rollback rejection) and effect
// ordering (the own case first, as the array holds it; iteration-major
// repeat expansion).

import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { parentUserWriteFixture } from "@/lib/__tests__/parentUserWriteFixture";
import { sharedWorkerRepeat } from "@/lib/__tests__/sharedWorkerRepeat";
import type { CaseStore, LookupTableSchemas } from "@/lib/case-store";
import { buildCaseTypeMap } from "@/lib/case-store";
import { SubmissionRejectedError } from "@/lib/case-store/errors";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import {
	advancedFixture,
	choice,
	read,
	U,
	UNDER_TEST,
} from "@/lib/commcare/__tests__/advancedPlacementFixture";
import { arithmeticFixture } from "@/lib/commcare/__tests__/arithmeticFixture";
import { planPlacements } from "@/lib/commcare/placement";
import type { AppDatabase } from "@/lib/db/pg";
import { addCaseOperationMutations } from "@/lib/doc/caseOperationMutations";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, CaseOperation, Uuid } from "@/lib/domain";
import { formCaseSelections } from "@/lib/domain/advancedEntryDatums";
import { entryDatumCaseId } from "@/lib/domain/entryCaseIdentity";
import {
	and,
	dateCoerce,
	eq,
	formatDate,
	formField,
	literal,
	matchNone,
	or,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/expression";
import { SEARCH_READING } from "@/lib/domain/expression/temporalType";
import { instantDatetimeValue } from "@/lib/domain/temporalValues";
import { applyLookupAuthoringBatchInTransaction } from "@/lib/lookup/authoringBatch";
import { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";
import { authorizeLookupWriteInTransaction } from "@/lib/lookup/writerTransaction";
import {
	androidDevice,
	webAppsDevice,
} from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import { sharedVisitEntries } from "../../../../proof/targeted/documents/sharedVisitEntries";
import { validateCaptureSubmissionProjection } from "../captureSubmissionValidation";
import {
	buildCaseOperationProgramFromDoc,
	buildSubmissionReceiptIdentity,
	submissionEnvelopeArgs,
} from "../caseDataBindingHelpers";
import { buildEngineInput } from "../engineInput";
import { entrySessionData } from "../entrySessionData";
import { FormEngine } from "../formEngine";
import {
	type FormOpeningProjection,
	formNeedsOpeningEvidence,
	openingCaseData,
} from "../formOpeningSnapshot";
import type { ResolvedPreviewIdentity } from "../identity";
import { openingCaseAssignments } from "../openingCaseAssignments";
import { signFormOpening, verifyFormOpening } from "../signedFormOpening";
import {
	acceptanceDoc,
	conditionalCloseDoc,
	engineFor,
	operationRelevanceDoc,
	ordinaryAuthorityDoc,
	ordinaryAuthorityMutation,
} from "./fixtures/submissionProgram";

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "program_acceptance_",
});

beforeEach(async () => {
	// Case rows are structurally tenant-bound to their authoritative app row.
	// Establish the real `(app, Project)` parent before materializing schemas
	// or data; bypassing it would exercise a state production cannot represent.
	await sql`
		INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		VALUES (
			${APP_ID},
			${ACTOR},
			${PROJECT},
			'Submission program acceptance',
			'submission program acceptance'
		)
	`.execute(dbHandle.db);
});

const APP_ID = "app-program-acceptance";
const PROJECT = "project-acceptance";
const ACTOR = "worker-1";
const SESSION_CASE = "50000000-0000-0000-0000-000000000001";
const SECOND_SESSION_CASE = "50000000-0000-0000-0000-000000000002";
const ENTRY_KEY = "11111111-1111-4111-8111-111111111111";

const IDENTITY: ResolvedPreviewIdentity = {
	actorUserId: ACTOR,
	ownerId: ACTOR,
	session: {
		context: { userid: ACTOR, username: "ada" },
		user: { role: "supervisor" },
		userPropertySlugs: {},
	},
	usercase: { role: "supervisor" },
};

function makeStore(checkAuthorizedSequence = false): CaseStore {
	return new PostgresCaseStore({
		projectId: PROJECT,
		actorUserId: ACTOR,
		ownerId: ACTOR,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
		...(checkAuthorizedSequence && {
			authorizeMutation: async () => ({ appMutationSeq: 0 }),
		}),
	});
}

const OP_ROOT = testUuid("60000000-0000-7000-8000-00000000a001");
const OP_REPEAT = testUuid("60000000-0000-7000-8000-00000000a002");

async function seedSessionCase(store: CaseStore, doc: BlueprintDoc) {
	await store.applySchemaChange({
		appId: APP_ID,
		caseType: "patient",
		caseTypeSchemas: buildCaseTypeMap(doc),
	});
	await store.insert({
		appId: APP_ID,
		row: {
			case_id: SESSION_CASE,
			case_type: "patient",
			case_name: "Ada",
			external_id: "seed-external",
			status: "open",
			properties: {},
		},
	});
}

async function seedSecondSessionCase(store: CaseStore) {
	await store.insert({
		appId: APP_ID,
		row: {
			case_id: SECOND_SESSION_CASE,
			case_type: "patient",
			case_name: "Grace",
			external_id: "seed-external-2",
			status: "open",
			properties: {},
		},
	});
}

async function submit(
	doc: BlueprintDoc,
	engine: FormEngine,
	store: CaseStore,
	lookupTableSchemas?: LookupTableSchemas,
) {
	const mutation = engine.computeSubmissionMutation({
		caseIds: [SESSION_CASE],
		entryKey: ENTRY_KEY,
	});
	const projection = validateCaptureSubmissionProjection(mutation);
	const built = buildCaseOperationProgramFromDoc({
		device: webAppsDevice(),
		blueprint: doc,
		mutation,
		projection,
		identity: IDENTITY,
	});
	expect(built.program?.ownCase?.caseType).toBe("patient");
	const withLookupSchemas =
		built.program === undefined || lookupTableSchemas === undefined
			? built
			: {
					...built,
					program: { ...built.program, lookupTableSchemas },
				};
	return store.applySubmission(
		submissionEnvelopeArgs(mutation, APP_ID, {
			...withLookupSchemas,
			submissionReceipt: {
				...buildSubmissionReceiptIdentity({
					appId: APP_ID,
					identity: IDENTITY,
					mutation,
					projection,
				}),
				expectedAppMutationSeq: 0,
				blueprintDigest: "0".repeat(64),
			},
		}),
	);
}

async function loadCase(store: CaseStore, caseId: string) {
	const rows = await store.query({
		reading: SEARCH_READING,
		appId: APP_ID,
		caseType: "patient",
	});
	return rows.find((row) => row.case_id === caseId);
}

describe("engine → builder → executor acceptance", () => {
	const modes = ["always", "edit", "case-name"] as const;
	it.each(modes)(
		"%s keeps the signed case facet's calendar day",
		async (mode) => {
			const rename = mode === "case-name";
			const toggle = testUuid("datetime-external-id-toggle");
			const seen = testUuid("datetime-external-id-seen");
			const doc = buildDoc({
				caseTypes: [
					{
						name: "patient",
						properties: [{ name: "case_name", label: proseText("Name") }],
					},
				],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
						forms: [
							{
								name: "Follow up",
								type: "followup",
								fields: [
									f({ kind: "text", id: "toggle", uuid: toggle }),
									f({
										kind: "datetime",
										id: "seen",
										uuid: seen,
										relevant: eq(formField(toggle), literal("yes")),
									}),
								],
							},
						],
					},
				],
			});
			doc.appSettings.runsOnlyOn = "android";
			const moduleUuid = doc.moduleOrder[0];
			const formUuid = doc.formOrder[moduleUuid][0];
			doc.forms[formUuid].caseOperations = [
				{
					uuid: OP_ROOT,
					id: "patient",
					action: "own",
					placement: {
						kind: "basic",
						slot: "own",
						...(!rename && { externalIdCalendarDayField: seen }),
					},
					...(rename
						? {
								name: formatDate(dateCoerce(term(formField(seen))), "%Y-%m-%d"),
							}
						: {
								writes: [
									{
										property: "external_id",
										value: dateCoerce(term(formField(seen))),
										...(mode === "edit" && { onlyIfChanged: true }),
									},
								],
							}),
				},
			];
			const verdict = mutationCommitVerdict(
				doc,
				[],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
			const store = makeStore(true);
			await seedSessionCase(store, doc);
			await seedSecondSessionCase(store);
			const input = buildEngineInput(doc, formUuid, null);
			if (!input) throw new Error("Expected the ordinary follow-up form");
			const device = androidDevice();
			const answer = "2025-04-06T06:24:47.125Z";
			for (const [kind, externalId] of [
				["irrelevant", "seed-external"],
				["answered", "2025-04-05"],
				["same-day", mode === "edit" ? "concurrent-id" : "2025-04-05"],
				["retained-blank", ""],
				["untouched-picker", undefined],
			] as const) {
				const entryKey = testUuid(`external-id-${kind}`);
				const snapshot = await store.readDeviceCaseDatabase({
					appId: APP_ID,
					restoreScope: { ownerIds: [ACTOR] },
				});
				const audience = {
					app: APP_ID,
					project: PROJECT,
					actor: ACTOR,
					worker: ACTOR,
					session: "session",
					persona: null,
					device,
					module: moduleUuid,
					form: formUuid,
					entry: entryKey,
					run: ENTRY_KEY,
					revision: 0,
					blueprintDigest: "0".repeat(64),
				};
				const secret = "synthetic calendar day opening key";
				const signed = await signFormOpening(secret, audience, {
					cases: openingCaseData(snapshot),
					lookup: { projectRevision: "0", definitions: [], rowsByTable: {} },
					choices: [],
					primaryCaseIds: [SESSION_CASE],
					datums: {},
					resolvedEntries: {},
					sessionData: {},
					complete: true,
				});
				const engine = new FormEngine(
					input,
					"patient",
					undefined,
					IDENTITY,
					null,
					snapshot,
					{ device },
				);
				engine.setValue("/data/toggle", kind === "irrelevant" ? "no" : "yes");
				if (kind === "answered" || kind === "same-day")
					engine.setValue("/data/seen", answer);
				const zone = "America/Los_Angeles";
				let expectedExternalId: string | undefined = externalId;
				if (kind === "untouched-picker") {
					engine.enterScreen("/data/seen");
					const shown = engine.getState("/data/seen").androidPickerDatetime;
					if (shown === undefined)
						throw Error("The Android picker must show its clock");
					expect(engine.getState("/data/seen").value).toBe("");
					expect(engine.saveScreenAnswers()).toEqual(["/data/seen"]);
					expectedExternalId = instantDatetimeValue(
						Date.parse(shown),
						zone,
					).slice(0, 10);
				}
				expect(engine.getState("/data/seen").visible).toBe(
					kind !== "irrelevant",
				);
				expect(engine.validateAll()).toBe(true);
				const mutation = engine.computeSubmissionMutation({
					caseIds: [SESSION_CASE],
					entryKey,
				});
				const submitted = mutation.operationAnswers?.root.find(
					(entry) => entry.fieldUuid === seen,
				);
				expect(submitted).toBeDefined();
				expect(submitted?.absent === true).toBe(kind === "irrelevant");
				const projection = validateCaptureSubmissionProjection(mutation);
				const built = buildCaseOperationProgramFromDoc({
					device,
					blueprint: doc,
					mutation,
					projection,
					identity: IDENTITY,
					opening: await verifyFormOpening(secret, audience, signed),
					viewerTimeZone: zone,
				});
				if (kind === "same-day" && !rename)
					await store.update({
						appId: APP_ID,
						caseId: SESSION_CASE,
						patch: { external_id: "concurrent-id" },
					});
				await store.applySubmission(
					submissionEnvelopeArgs(mutation, APP_ID, {
						...built,
						submissionReceipt: {
							...buildSubmissionReceiptIdentity({
								appId: APP_ID,
								identity: IDENTITY,
								mutation,
								projection,
							}),
							expectedAppMutationSeq: 0,
							blueprintDigest: audience.blueprintDigest,
						},
					}),
				);
				expect(await loadCase(store, SESSION_CASE)).toMatchObject({
					external_id: rename ? "seed-external" : expectedExternalId,
					case_name: rename
						? kind === "irrelevant"
							? "Ada"
							: expectedExternalId
						: "Ada",
				});
				expect(await loadCase(store, SECOND_SESSION_CASE)).toMatchObject({
					external_id: "seed-external-2",
					case_name: "Grace",
				});
			}
		},
	);

	it.each([
		"Advanced",
		"held Save to Case",
		"confirmation",
		"banner",
		"preloaded",
	] as const)(
		"saves only a relevant root label on %s to the signed selected case",
		async (source) => {
			const held = source === "held Save to Case";
			const preloaded = source === "preloaded";
			const initialNotes = "Text from the selected case";
			const submittedText =
				source === "confirmation" || source === "banner" ? "" : "OK";
			const {
				doc: initial,
				formUuid,
				moduleUuid,
			} = advancedFixture({
				menu: "members",
				formType: "followup",
				configure(doc) {
					const label = doc.fields[U("note")];
					if (label.kind !== "label") throw new Error("Expected a label");
					doc.fields[U("note")] = {
						...label,
						...(source === "confirmation" && { askForConfirmation: true }),
						...(source === "banner" && { banner: "good" }),
						relevant: eq(read("name"), literal("Show the reminder")),
					};
					doc.forms[UNDER_TEST].caseSelections = [
						...formCaseSelections(doc, UNDER_TEST),
					];
					if (preloaded)
						doc.forms[UNDER_TEST].openingAssignments = [
							{
								uuid: testUuid("passive-label-starting-assignment"),
								source: { kind: "own" },
								field: U("note"),
								property: "notes",
							},
						];
				},
			});
			const operation: CaseOperation = {
				uuid: testUuid("passive-label-own"),
				id: "member",
				action: "own",
				writes: [
					{ property: "seen", value: read("note") },
					{ property: "notes", value: read("name") },
				],
			};
			const verdict = mutationCommitVerdict(
				initial,
				addCaseOperationMutations(initial, formUuid, operation),
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
			let doc = verdict.nextDoc;
			const heldPlacement = {
				kind: "save-to-case",
				path: ["nova_operations", "member"],
			} satisfies NonNullable<CaseOperation["placement"]>;
			if (held) {
				const form = doc.forms[formUuid];
				doc = {
					...doc,
					forms: {
						...doc.forms,
						[formUuid]: {
							...form,
							caseOperations: form.caseOperations?.map((candidate) =>
								candidate.uuid === operation.uuid
									? { ...candidate, placement: heldPlacement }
									: candidate,
							),
						},
					},
				};
			}
			const selections = formCaseSelections(doc, formUuid);
			const selected = selections[1];
			expect(selections).toHaveLength(2);
			const closeUuid = testUuid("held-passive-label-close");
			const closePlacement = {
				kind: "save-to-case",
				path: [
					"nova_operations",
					"nova_condition_finish_member",
					"finish_member",
				],
			};
			if (held) {
				const close: CaseOperation = {
					uuid: closeUuid,
					id: "finish_member",
					action: "close",
					caseType: "member",
					target: {
						kind: "expression",
						expr: term({
							kind: "session-datum",
							datum: { kind: "form-selection", selection: selected.uuid },
						}),
					},
					condition: eq(read("status"), choice("status", "yes")),
				};
				const edit = mutationCommitVerdict(
					doc,
					addCaseOperationMutations(doc, formUuid, close),
					LOOKUP_CONTEXT_UNAVAILABLE,
				);
				if (!edit.ok) throw new Error(JSON.stringify(edit.findings));
				doc = edit.nextDoc;
				expect(
					planPlacements(doc, formUuid).placements.get(closeUuid)?.placement,
				).toEqual(closePlacement);
			}
			expect(
				planPlacements(doc, formUuid).placements.get(operation.uuid)?.placement,
			).toEqual(
				held ? heldPlacement : { kind: "advanced", tag: "load_member1" },
			);
			const store = makeStore(true);
			const household = testUuid("label-parent");
			const unrelated = testUuid("label-unrelated-member");
			const catalog = buildCaseTypeMap(doc);
			for (const caseType of ["household", "member"])
				await store.applySchemaChange({
					appId: APP_ID,
					caseType,
					caseTypeSchemas: catalog,
				});
			for (const [caseId, caseType, previous] of [
				[household, "household", ""],
				[SESSION_CASE, "member", "before"],
				[unrelated, "member", "unrelated"],
			] as const) {
				await store.insert({
					appId: APP_ID,
					row: {
						case_id: caseId,
						case_type: caseType,
						case_name: caseType,
						status: "open",
						properties:
							caseId === SESSION_CASE
								? { seen: previous, notes: initialNotes }
								: caseType === "member"
									? { seen: previous }
									: {},
						...(caseType === "member" && { parent_case_id: household }),
					},
				});
			}
			if (held) {
				// The own note can save while open. The separate close attempt
				// fails after that write, which must roll back with the close.
				await sql`ALTER TABLE cases ADD CONSTRAINT label_close_rollback
				CHECK (status <> 'closed' OR properties->>'notes' IS DISTINCT FROM 'Refuse closing')`.execute(
					dbHandle.db,
				);
			}
			const device = androidDevice();
			const scenarios = [
				{
					visible: false,
					note: "The reminder is hidden",
					closes: false,
					fails: false,
				},
				...(held
					? [
							{
								visible: false,
								note: "Refuse closing",
								closes: true,
								fails: true,
							},
						]
					: []),
				{
					visible: true,
					note: "Show the reminder",
					closes: held,
					fails: false,
				},
			];
			for (const { visible, note, closes, fails } of scenarios) {
				const entryKey = testUuid(`label-entry-${note}`);
				const audience = {
					app: APP_ID,
					project: PROJECT,
					actor: ACTOR,
					worker: ACTOR,
					session: "session",
					persona: null,
					device,
					module: moduleUuid,
					form: formUuid,
					entry: entryKey,
					run: ENTRY_KEY,
					revision: 0,
					blueprintDigest: "0".repeat(64),
				};
				const snapshot = await store.readDeviceCaseDatabase({
					appId: APP_ID,
					restoreScope: { ownerIds: [ACTOR] },
				});
				const choices = selections.map((row, index) => ({
					selection: row.uuid,
					caseId: index === 0 ? household : SESSION_CASE,
				}));
				const ready = entrySessionData(doc, formUuid, {
					appId: APP_ID,
					entryKey,
					caseDatabase: snapshot,
					session: IDENTITY.session,
					boundCases: [],
					menuSelections: {},
					entryChoices: choices.map(({ selection, caseId }) => ({
						selectionUuid: selection,
						caseId,
						caseName: caseId === household ? "household" : "member",
					})),
				});
				expect(ready.nextSelection).toBeUndefined();
				expect(ready.reachedCaseIds.get(selected.uuid)).toBe(SESSION_CASE);
				const secret = "synthetic Advanced label opening key";
				const signed = await signFormOpening(secret, audience, {
					cases: openingCaseData(snapshot),
					lookup: { projectRevision: "0", definitions: [], rowsByTable: {} },
					choices,
					primaryCaseIds: [SESSION_CASE],
					datums: { ...ready.datumsByRef },
					resolvedEntries: { ...ready.resolvedEntryValues },
					sessionData: { ...ready.data },
					complete: true,
				});
				const input = buildEngineInput(doc, formUuid, null);
				if (!input) throw new Error("Expected the Advanced member form");
				const engine = new FormEngine(
					{
						...input,
						openingAssignments: openingCaseAssignments(
							doc,
							formUuid,
							ready.reachedCaseIds,
							snapshot,
						),
					},
					"member",
					undefined,
					IDENTITY,
					null,
					snapshot,
					{ device, sessionData: ready.data },
				);
				engine.setValue("/data/name", note);
				if (held) engine.setValue("/data/status", closes ? "yes" : "no");
				expect(engine.getState("/data/note").visible).toBe(visible);
				if (preloaded && visible)
					expect(engine.getState("/data/note").value).toBe(
						"The reminder is hidden",
					);
				expect(engine.validateAll()).toBe(true);
				const mutation = engine.computeSubmissionMutation({
					caseIds: [SESSION_CASE],
					entryKey,
				});
				const label = mutation.operationAnswers?.root.find(
					(answer) => answer.fieldUuid === U("note"),
				);
				expect(label).toMatchObject(
					visible ? { value: submittedText } : { absent: true },
				);
				const projection = validateCaptureSubmissionProjection(mutation);
				const built = buildCaseOperationProgramFromDoc({
					device,
					blueprint: doc,
					mutation,
					projection,
					identity: IDENTITY,
					opening: await verifyFormOpening(secret, audience, signed),
				});
				const applied = store.applySubmission(
					submissionEnvelopeArgs(mutation, APP_ID, {
						...built,
						submissionReceipt: {
							...buildSubmissionReceiptIdentity({
								appId: APP_ID,
								identity: IDENTITY,
								mutation,
								projection,
							}),
							expectedAppMutationSeq: 0,
							blueprintDigest: audience.blueprintDigest,
						},
					}),
				);
				if (fails) {
					await expect(applied).rejects.toMatchObject({
						code: "23514",
						constraint: "label_close_rollback",
					});
				} else {
					const result = await applied;
					if (held) {
						expect(
							result.operations.find((row) => row.operationUuid === closeUuid),
						).toMatchObject({
							executed: closes,
							caseId: closes ? SESSION_CASE : "",
						});
					}
				}
				const rows = await store.query({
					appId: APP_ID,
					caseType: "member",
					reading: SEARCH_READING,
				});
				expect(rows.find((row) => row.case_id === SESSION_CASE)).toMatchObject({
					status: closes && !fails ? "closed" : "open",
					properties: {
						seen: visible ? submittedText : "before",
						notes: fails ? "The reminder is hidden" : note,
					},
				});
				expect(
					rows.find((row) => row.case_id === unrelated)?.properties,
				).toEqual({ seen: "unrelated" });
			}
		},
	);

	it("keeps the signed parent user block with omitted and present blank answers", async () => {
		const { doc, form } = parentUserWriteFixture(APP_ID);
		const middle = testUuid("parent-user-first-target");
		const terminal = testUuid("parent-user-terminal");
		const unrelated = testUuid("parent-user-unrelated-household");
		const store = makeStore(true);
		const catalog = buildCaseTypeMap(doc);
		for (const caseType of ["person", "family", "household"]) {
			await store.applySchemaChange({
				appId: APP_ID,
				caseType,
				caseTypeSchemas: catalog,
			});
		}
		for (const [id, type, properties] of [
			[middle, "family", {}],
			[terminal, "household", { linked_note: "before" }],
			[unrelated, "household", { linked_note: "unrelated" }],
		] as const) {
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: id,
					case_type: type,
					case_name: type,
					status: "open",
					properties,
				},
			});
		}
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: SESSION_CASE,
				case_type: "person",
				case_name: "Person",
				status: "open",
				parent_case_id: middle,
				properties: { local_note: "before" },
			},
		});
		const db = dbHandle.db as unknown as Kysely<Database>;
		await db
			.insertInto("case_indices")
			.values({
				case_id: middle,
				ancestor_id: terminal,
				target_case_type: "household",
				identifier: "user",
				relationship: "child",
				depth: 1,
			})
			.execute();
		await sql`UPDATE cases SET modified_on = '2024-01-01T00:00:00Z' WHERE app_id = ${APP_ID}`.execute(
			db,
		);
		const snapshot = await store.readDeviceCaseDatabase({
			appId: APP_ID,
			restoreScope: { ownerIds: [ACTOR] },
		});
		const read = async (type: string, id: string) =>
			(
				await store.query({
					appId: APP_ID,
					caseType: type,
					reading: SEARCH_READING,
				})
			).find((row) => row.case_id === id);
		const apply = async (
			entryKey: string,
			mode: string,
			answer: string,
			cases: typeof snapshot,
			without?: "opening" | "route-types",
		) => {
			const audience = {
				app: APP_ID,
				project: PROJECT,
				actor: ACTOR,
				worker: ACTOR,
				session: "session",
				persona: null,
				device: webAppsDevice(),
				module: doc.moduleOrder[0],
				form,
				entry: entryKey,
				run: ENTRY_KEY,
				revision: 0,
				blueprintDigest: "0".repeat(64),
			};
			const secret = "synthetic parent user opening key";
			const signed = await signFormOpening(secret, audience, {
				cases: openingCaseData(cases),
				lookup: { projectRevision: "0", definitions: [], rowsByTable: {} },
				choices: [],
				primaryCaseIds: [SESSION_CASE],
				datums: {},
				resolvedEntries: {},
				sessionData: {},
				complete: true,
			});
			const input = buildEngineInput(doc, form, null);
			if (!input) throw new Error("Expected the parent user form");
			const engine = new FormEngine(input);
			engine.setValue("/data/mode", mode);
			if (mode === "show") engine.setValue("/data/note", answer);
			const mutation = engine.computeSubmissionMutation({
				caseIds: [SESSION_CASE],
				entryKey,
			});
			const projection = validateCaptureSubmissionProjection(mutation);
			const built = buildCaseOperationProgramFromDoc({
				device: webAppsDevice(),
				blueprint: doc,
				mutation,
				projection,
				identity: IDENTITY,
				opening:
					without === "opening"
						? undefined
						: await verifyFormOpening(secret, audience, signed),
			});
			const program = built.program;
			const supplied =
				without === "route-types" && program
					? {
							...built,
							program: {
								...program,
								operations: program.operations.map((step) => ({
									...step,
									parentUserCaseTypes: undefined,
								})),
							},
						}
					: built;
			return store.applySubmission(
				submissionEnvelopeArgs(mutation, APP_ID, {
					...supplied,
					submissionReceipt: {
						...buildSubmissionReceiptIdentity({
							appId: APP_ID,
							identity: IDENTITY,
							mutation,
							projection,
						}),
						expectedAppMutationSeq: 0,
						blueprintDigest: audience.blueprintDigest,
					},
				}),
			);
		};
		const id = (name: string) => testUuid(`parent-user-submission-${name}`);
		for (const [label, broken] of [
			[
				"missing-first",
				{
					...snapshot,
					indices: snapshot.indices.filter(
						(edge) => edge.case_id !== SESSION_CASE,
					),
				},
			],
			[
				"missing-intermediate",
				{
					...snapshot,
					rows: snapshot.rows.filter((row) => row.case_id !== middle),
				},
			],
			[
				"missing-second",
				{
					...snapshot,
					indices: snapshot.indices.filter((edge) => edge.case_id !== middle),
				},
			],
			[
				"missing-terminal",
				{
					...snapshot,
					rows: snapshot.rows.filter((row) => row.case_id !== terminal),
				},
			],
		] as const) {
			await expect(apply(id(label), "omit", "", broken)).rejects.toBeInstanceOf(
				SubmissionRejectedError,
			);
			expect((await read("person", SESSION_CASE))?.properties.local_note).toBe(
				"before",
			);
			expect((await read("household", terminal))?.properties.linked_note).toBe(
				"before",
			);
		}
		for (const missing of ["opening", "route-types"] as const) {
			await expect(
				apply(id(missing), "show", "must not write", snapshot, missing),
			).rejects.toThrow(
				"Reopen the form to load the records this case change follows",
			);
			expect((await read("person", SESSION_CASE))?.properties.local_note).toBe(
				"before",
			);
			expect((await read("household", terminal))?.properties.linked_note).toBe(
				"before",
			);
		}
		const before = await read("household", terminal);
		const omitted = await apply(id("omitted"), "omit", "", snapshot);
		expect(omitted.caseDatabasePatch?.rows.map((row) => row.case_id)).toContain(
			terminal,
		);
		expect((await read("household", terminal))?.properties.linked_note).toBe(
			"before",
		);
		expect((await read("household", terminal))?.modified_on).not.toEqual(
			before?.modified_on,
		);

		await db
			.updateTable("case_indices")
			.set({ ancestor_id: unrelated })
			.where("case_id", "=", middle)
			.where("identifier", "=", "user")
			.execute();
		await apply(id("held id"), "show", "from form", snapshot);
		expect((await read("household", terminal))?.properties.linked_note).toBe(
			"from form",
		);
		expect((await read("household", unrelated))?.properties.linked_note).toBe(
			"unrelated",
		);
		expect((await read("family", middle))?.properties).toEqual({});
		await apply(id("blank"), "show", "", snapshot);
		expect((await read("household", terminal))?.properties).not.toHaveProperty(
			"linked_note",
		);

		await db
			.updateTable("cases")
			.set({ case_type: "household" })
			.where("case_id", "=", middle)
			.execute();
		await expect(
			apply(id("current type changed"), "omit", "", snapshot),
		).rejects.toMatchObject({
			rejection: { reason: "case-type-mismatch" },
		});
		await db
			.updateTable("cases")
			.set({ case_type: "family" })
			.where("case_id", "in", [middle, terminal])
			.execute();
		await expect(
			apply(id("terminal type changed"), "omit", "", snapshot),
		).rejects.toMatchObject({
			rejection: { reason: "case-type-mismatch" },
		});
		expect((await read("person", SESSION_CASE))?.properties.local_note).toBe(
			"show",
		);
	});

	it("applies live repeat rows in order to the worker case retained at opening", async () => {
		const form = testUuid("repeated-worker-form");
		const repeat = testUuid("repeated-worker-members");
		const answer = testUuid("repeated-worker-member-name");
		const showAnswer = testUuid("repeated-worker-show-member");
		const property = testUuid("repeated-worker-property");
		const doc = buildDoc(
			{
				appId: APP_ID,
				modules: [
					{
						name: "Workers",
						forms: [
							{
								uuid: form,
								name: "Members",
								type: "survey",
								fields: [
									f({
										kind: "repeat",
										uuid: repeat,
										id: "members",
										repeat_mode: "user_controlled",
										children: [
											f({ kind: "text", uuid: showAnswer, id: "show_member" }),
											f({
												kind: "text",
												uuid: answer,
												id: "member_name",
												relevant: eq(
													term(formField(showAnswer)),
													literal("yes"),
												),
											}),
										],
									}),
								],
							},
						],
					},
				],
			},
			(draft) => {
				draft.userProperties = {
					[property]: {
						uuid: property,
						slug: "visit_note",
						label: "Visit note",
					},
				};
				draft.userPropertyOrder = [property];
				draft.forms[form].caseOperations = [
					{
						uuid: OP_REPEAT,
						id: "worker",
						action: "update",
						caseType: "commcare-user",
						target: { kind: "worker-record" },
						forEach: { repeat },
						writes: [
							{ property: "visit_note", value: term(formField(answer)) },
						],
					},
				];
			},
		);
		expect(formNeedsOpeningEvidence(doc, form)).toBe(true);
		const store = makeStore(true);
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "commcare-user",
			caseTypeSchemas: buildCaseTypeMap(doc),
		});
		const workerRows = () =>
			store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "commcare-user",
			});
		const apply = async (
			entryKey: string,
			rows: Awaited<ReturnType<typeof workerRows>>,
			members: readonly (string | null)[],
		) => {
			const audience = {
				app: APP_ID,
				project: PROJECT,
				actor: ACTOR,
				worker: ACTOR,
				session: "session",
				persona: null,
				device: webAppsDevice(),
				module: doc.moduleOrder[0],
				form,
				entry: entryKey,
				run: ENTRY_KEY,
				revision: 0,
				blueprintDigest: "0".repeat(64),
			};
			const secret = "synthetic repeat worker opening key";
			const signed = await signFormOpening(secret, audience, {
				cases: openingCaseData({ rows, indices: [] }),
				lookup: { projectRevision: "0", definitions: [], rowsByTable: {} },
				choices: [],
				primaryCaseIds: [],
				datums: {},
				resolvedEntries: {},
				sessionData: {},
				complete: true,
			});
			const opening = await verifyFormOpening(secret, audience, signed);
			const input = buildEngineInput(doc, form, null);
			if (!input) throw new Error("Expected the repeating worker survey");
			const engine = new FormEngine(input);
			for (const [index, member] of members.entries()) {
				engine.addRepeat("/data/members");
				const path = `/data/members[${index}]`;
				engine.setValue(`${path}/show_member`, member === null ? "no" : "yes");
				if (member !== null) engine.setValue(`${path}/member_name`, member);
			}
			const mutation = engine.computeSubmissionMutation({ entryKey });
			expect(
				mutation.operationAnswers?.repeats[0].iterations.map((entries) =>
					entries.find((entry) => entry.fieldUuid === answer),
				),
			).toEqual(
				members.map((member) => ({
					fieldUuid: answer,
					value: member ?? "",
					...(member === null && { absent: true }),
				})),
			);
			const projection = validateCaptureSubmissionProjection(mutation);
			const built = buildCaseOperationProgramFromDoc({
				device: webAppsDevice(),
				blueprint: doc,
				mutation,
				projection,
				identity: IDENTITY,
				opening,
			});
			return store.applySubmission(
				submissionEnvelopeArgs(mutation, APP_ID, {
					...built,
					submissionReceipt: {
						...buildSubmissionReceiptIdentity({
							appId: APP_ID,
							identity: IDENTITY,
							mutation,
							projection,
						}),
						expectedAppMutationSeq: 0,
						blueprintDigest: audience.blueprintDigest,
					},
				}),
			);
		};
		const entry = (suffix: number) =>
			`11111111-1111-4111-8111-11111111111${suffix}`;
		const absentAtOpening = await workerRows();
		const skipped = await apply(entry(2), absentAtOpening, []);
		expect(skipped.operations).toEqual([]);
		expect(skipped.caseDatabasePatch?.rows).toEqual([]);
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: SECOND_SESSION_CASE,
				case_type: "commcare-user",
				case_name: "Worker",
				status: "open",
				properties: { hq_user_id: ACTOR, visit_note: "before" },
			},
		});
		await expect(
			apply(entry(3), absentAtOpening, ["first", "last"]),
		).rejects.toThrow("worker's record is missing or has changed");
		expect(await workerRows()).toMatchObject([
			{
				case_id: SECOND_SESSION_CASE,
				properties: { visit_note: "before" },
			},
		]);
		const updated = await apply(entry(4), await workerRows(), [
			"first",
			"last",
		]);
		expect(updated.operations).toMatchObject([
			{ caseId: SECOND_SESSION_CASE, executed: true, iteration: 0 },
			{ caseId: SECOND_SESSION_CASE, executed: true, iteration: 1 },
		]);
		expect(updated.caseDatabasePatch?.rows).toMatchObject([
			{ case_id: SECOND_SESSION_CASE },
		]);
		expect(await workerRows()).toMatchObject([
			{
				case_id: SECOND_SESSION_CASE,
				properties: { visit_note: "last" },
			},
		]);
		await apply(entry(5), await workerRows(), ["retained", null]);
		expect(await workerRows()).toMatchObject([
			{
				case_id: SECOND_SESSION_CASE,
				properties: { visit_note: "retained" },
			},
		]);
		await apply(entry(6), await workerRows(), ["replaced", ""]);
		const [worker] = await workerRows();
		expect(worker.case_id).toBe(SECOND_SESSION_CASE);
		expect(worker.properties).not.toHaveProperty("visit_note");
	});

	it("does not stamp the selected worker for a shared form with no live repeat rows", async () => {
		const { doc, shared } = sharedWorkerRepeat(false, APP_ID);
		const store = makeStore(true);
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "commcare-user",
			caseTypeSchemas: buildCaseTypeMap(doc),
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: SESSION_CASE,
				case_type: "commcare-user",
				case_name: "Worker",
				status: "open",
				properties: { hq_user_id: ACTOR, visit_note: "before" },
			},
		});
		await sql`UPDATE cases SET modified_on = '2024-01-01T00:00:00Z' WHERE app_id = ${APP_ID}`.execute(
			dbHandle.db,
		);
		const workers = () =>
			store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "commcare-user",
			});
		const baseline = await workers();
		const audience = {
			app: APP_ID,
			project: PROJECT,
			actor: ACTOR,
			worker: ACTOR,
			session: "shared-opening",
			persona: null,
			device: webAppsDevice(),
			module: doc.moduleOrder[1],
			form: shared,
			entry: ENTRY_KEY,
			run: ENTRY_KEY,
			revision: 0,
			blueprintDigest: "0".repeat(64),
		};
		const secret = "synthetic shared worker opening key";
		const signed = await signFormOpening(secret, audience, {
			cases: openingCaseData({ rows: baseline, indices: [] }),
			lookup: { projectRevision: "0", definitions: [], rowsByTable: {} },
			choices: [],
			primaryCaseIds: [SESSION_CASE],
			datums: {},
			resolvedEntries: {},
			sessionData: {},
			complete: true,
		});
		const input = buildEngineInput(doc, shared, null);
		if (!input) throw new Error("Expected the shared worker form");
		const mutation = new FormEngine(input).computeSubmissionMutation({
			caseIds: [SESSION_CASE],
			entryKey: ENTRY_KEY,
		});
		const projection = validateCaptureSubmissionProjection(mutation);
		const built = buildCaseOperationProgramFromDoc({
			device: webAppsDevice(),
			blueprint: doc,
			mutation,
			projection,
			identity: IDENTITY,
			opening: await verifyFormOpening(secret, audience, signed),
		});
		const result = await store.applySubmission(
			submissionEnvelopeArgs(mutation, APP_ID, {
				...built,
				submissionReceipt: {
					...buildSubmissionReceiptIdentity({
						appId: APP_ID,
						identity: IDENTITY,
						mutation,
						projection,
					}),
					expectedAppMutationSeq: 0,
					blueprintDigest: audience.blueprintDigest,
				},
			}),
		);
		expect(result.primaryCaseIds).toEqual([SESSION_CASE]);
		expect(result.operations).toEqual([]);
		expect(await workers()).toEqual(baseline);
	});

	it("applies a root worker update only on the committed condition to the scoped row", async () => {
		const field = testUuid("worker-condition-answer");
		const form = testUuid("worker-condition-form");
		const property = testUuid("worker-condition-property");
		const workerCaseId = SECOND_SESSION_CASE;
		const replacementId = SESSION_CASE;
		const doc = buildDoc(
			{
				appId: APP_ID,
				modules: [
					{
						name: "Worker notes",
						forms: [
							{
								uuid: form,
								name: "Review",
								type: "survey",
								fields: [f({ kind: "text", uuid: field, id: "decision" })],
							},
						],
					},
				],
			},
			(draft) => {
				draft.userProperties = {
					[property]: {
						uuid: property,
						slug: "visit_note",
						label: "Visit note",
					},
				};
				draft.userPropertyOrder = [property];
				draft.forms[form].caseOperations = [
					{
						uuid: OP_ROOT,
						id: "worker",
						action: "update",
						caseType: "commcare-user",
						target: { kind: "worker-record" },
						condition: or(
							eq(term(formField(field)), literal("save")),
							and(
								eq(term(formField(field)), literal("check")),
								eq(
									term({
										kind: "session-user-property",
										userPropertyUuid: property,
										source: "worker-record",
									}),
									literal("before"),
								),
							),
						),
						writes: [
							{ property: "visit_note", value: term(literal("updated")) },
						],
					},
				];
			},
		);
		expect(formNeedsOpeningEvidence(doc, form)).toBe(true);
		const identity = {
			...IDENTITY,
			session: {
				...IDENTITY.session,
				userPropertySlugs: { [property]: "visit_note" },
			},
		};
		const store = makeStore(true);
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "commcare-user",
			caseTypeSchemas: buildCaseTypeMap(doc),
		});
		const apply = (
			decision: string,
			entryKey: string,
			expectedAppMutationSeq = 0,
			opening?: FormOpeningProjection,
		) => {
			const input = buildEngineInput(doc, form, null);
			if (!input) throw new Error("Expected the worker survey");
			const engine = new FormEngine(input);
			engine.setValue("/data/decision", decision);
			const mutation = engine.computeSubmissionMutation({ entryKey });
			const projection = validateCaptureSubmissionProjection(mutation);
			const built = buildCaseOperationProgramFromDoc({
				device: webAppsDevice(),
				blueprint: doc,
				mutation,
				projection,
				identity,
				opening,
			});
			return store.applySubmission(
				submissionEnvelopeArgs(mutation, APP_ID, {
					...built,
					submissionReceipt: {
						...buildSubmissionReceiptIdentity({
							appId: APP_ID,
							identity,
							mutation,
							projection,
						}),
						expectedAppMutationSeq,
						blueprintDigest: "0".repeat(64),
					},
				}),
			);
		};
		const entry = (last: number) =>
			`11111111-1111-4111-8111-11111111111${last}`;
		const audienceFor = (entryKey: string) => ({
			app: APP_ID,
			project: PROJECT,
			actor: ACTOR,
			worker: ACTOR,
			session: "session",
			persona: null,
			device: webAppsDevice(),
			module: doc.moduleOrder[0],
			form,
			entry: entryKey,
			run: entry(7),
			revision: 0,
			blueprintDigest: "0".repeat(64),
		});
		const secret = "synthetic worker entry signing key";
		const openingFor = async (
			entryKey: string,
			rows: Parameters<typeof openingCaseData>[0]["rows"],
		) => {
			const audience = audienceFor(entryKey);
			const signed = await signFormOpening(secret, audience, {
				cases: openingCaseData({ rows, indices: [] }),
				lookup: { projectRevision: "0", definitions: [], rowsByTable: {} },
				choices: [],
				primaryCaseIds: [],
				datums: {},
				resolvedEntries: {},
				sessionData: {},
				complete: true,
			});
			return {
				signed,
				projection: await verifyFormOpening(secret, audience, signed),
			};
		};
		const workerRows = () =>
			store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "commcare-user",
			});
		const noWorker = await openingFor(entry(1), []);
		const skipped = await apply("keep", entry(1), 0, noWorker.projection);
		expect(skipped.operations).toEqual([
			expect.objectContaining({ executed: false, caseId: "" }),
		]);
		expect(skipped.caseDatabasePatch?.rows).toEqual([]);
		await expect(
			apply("keep", entry(2), 99, (await openingFor(entry(2), [])).projection),
		).rejects.toThrow("The form changed");
		const absentAtOpening = (await openingFor(entry(3), [])).projection;
		await expect(apply("save", entry(3), 0, absentAtOpening)).rejects.toThrow(
			"worker's record is missing or has changed",
		);
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: workerCaseId,
				case_type: "commcare-user",
				case_name: "Worker",
				status: "open",
				properties: { hq_user_id: ACTOR, visit_note: "before" },
			},
		});
		// A newly synced row cannot become the target of that older form.
		await expect(apply("save", entry(3), 0, absentAtOpening)).rejects.toThrow(
			"worker's record is missing or has changed",
		);
		const before = await workerRows();
		const held = await apply(
			"keep",
			entry(4),
			0,
			(await openingFor(entry(4), before)).projection,
		);
		expect(held.caseDatabasePatch?.rows).toEqual([]);
		const { signed, projection: opening } = await openingFor(entry(6), before);
		await expect(
			verifyFormOpening(
				secret,
				{ ...audienceFor(entry(6)), worker: "another-worker" },
				signed,
			),
		).rejects.toThrow();
		const changed = await apply(
			"save",
			entry(5),
			0,
			(await openingFor(entry(5), before)).projection,
		);
		expect(changed.operations).toEqual([
			expect.objectContaining({ executed: true, caseId: workerCaseId }),
		]);
		expect(changed.caseDatabasePatch?.rows).toMatchObject([
			{ case_id: workerCaseId },
		]);
		const [row] = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "commcare-user",
		});
		expect(row?.properties).toEqual({
			hq_user_id: ACTOR,
			visit_note: "updated",
		});
		// Live now says "updated". The "check" condition is true only against
		// the worker property retained by the authorized opening.
		const fromOpening = await apply("check", entry(6), 0, opening);
		expect(fromOpening.operations).toEqual([
			expect.objectContaining({ executed: true, caseId: workerCaseId }),
		]);
		const earlier = (await openingFor(entry(8), before)).projection;
		await sql`UPDATE cases
			SET properties = jsonb_set(properties, '{hq_user_id}', to_jsonb('former-worker'::text))
			WHERE app_id = ${APP_ID} AND project_id = ${PROJECT} AND case_id = ${workerCaseId}
		`.execute(dbHandle.db);
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: replacementId,
				case_type: "commcare-user",
				case_name: "Replacement",
				status: "open",
				properties: { hq_user_id: ACTOR, visit_note: "replacement" },
			},
		});
		await expect(apply("save", entry(8), 0, earlier)).rejects.toThrow(
			"worker's record is missing or has changed",
		);
		const current = new Map(
			(await workerRows()).map((row) => [
				row.case_id,
				row.properties.visit_note,
			]),
		);
		expect(current).toEqual(
			new Map([
				[workerCaseId, "updated"],
				[replacementId, "replacement"],
			]),
		);
	});

	it("submits a shared entry’s parent answers to the case selected by that entry", async () => {
		const doc = hydratePersistedBlueprint(sharedVisitEntries().doc);
		const entry = Object.values(doc.forms).find(
			(form) => form.name === "Follow a referral",
		);
		if (!entry?.shadowOf) throw new Error("Expected the referral entry.");
		const store = makeStore();
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "person",
			caseTypeSchemas: buildCaseTypeMap(doc),
		});
		for (const id of [SESSION_CASE, SECOND_SESSION_CASE]) {
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: id,
					case_type: "person",
					case_name: id,
					external_id: "",
					status: "open",
					properties: {},
				},
			});
		}
		const input = buildEngineInput(doc, entry.uuid, null);
		if (!input) throw new Error("Expected the shared visit form.");
		const engine = new FormEngine(input);
		engine.setValue("/data/visit_note", "Reached at home");
		const mutation = engine.computeSubmissionMutation({
			caseIds: [SECOND_SESSION_CASE],
			entryKey: ENTRY_KEY,
		});
		const projection = validateCaptureSubmissionProjection(mutation);
		expect(projection.formUuid).toBe(entry.uuid);
		const built = buildCaseOperationProgramFromDoc({
			device: webAppsDevice(),
			blueprint: doc,
			mutation,
			projection,
			identity: IDENTITY,
		});
		expect(built.program?.formUuid).toBe(entry.shadowOf.form);
		await store.applySubmission(
			submissionEnvelopeArgs(mutation, APP_ID, {
				...built,
				submissionReceipt: {
					...buildSubmissionReceiptIdentity({
						appId: APP_ID,
						identity: IDENTITY,
						mutation,
						projection,
					}),
					expectedAppMutationSeq: 0,
					blueprintDigest: "0".repeat(64),
				},
			}),
		);
		const rows = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "person",
		});
		expect(
			rows.find((row) => row.case_id === SESSION_CASE)?.properties,
		).toEqual({});
		expect(
			rows.find((row) => row.case_id === SECOND_SESSION_CASE)?.properties,
		).toEqual({ visit_note: "Reached at home" });
	});

	it("checks Connect's submitted delivery before case effects and replays the committed worker facts", async () => {
		const formUuid = testUuid("connect-visit-followup");
		const activity = testUuid("connect-visit-delivery");
		const doc = buildDoc({
			connectRoles: ["deliver"],
			appSettings: {
				runsOnlyOn: "android",
				showSavedForms: false,
				showIncompleteForms: false,
			},
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "visit_note", label: proseText("Visit note") }],
				},
			],
			modules: [
				{
					name: "Visits",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Follow up",
							uuid: formUuid,
							type: "followup",
							fields: [
								f({ kind: "text", id: "person", label: "Person" }),
								f({
									kind: "text",
									id: "note",
									label: "Visit note",
									caseWrite: { caseType: "patient", property: "visit_note" },
								}),
								f({
									kind: "connect_activity",
									id: "visit",
									uuid: activity,
									activity: {
										kind: "delivery",
										name: "Visit",
										entityId: "#form/person",
									},
								}),
							],
						},
					],
				},
			],
		});
		const store = makeStore();
		await seedSessionCase(store, doc);
		const engine = engineFor(doc, formUuid);
		engine.setValue("/data/note", "Reached the household");
		engine.setValue("/data/person", "🌿".repeat(256));
		await expect(submit(doc, engine, store)).rejects.toThrow("255 characters");
		expect((await loadCase(store, SESSION_CASE))?.properties).toEqual({});
		const entries = await sql<{
			count: number;
		}>`SELECT count(*)::int AS count FROM form_submission_intents WHERE entry_key = ${ENTRY_KEY}`.execute(
			dbHandle.db,
		);
		expect(entries.rows[0]?.count).toBe(0);
		const entityId = "🌿".repeat(255);
		engine.setValue("/data/person", entityId);
		const result = await submit(doc, engine, store);
		expect(result.activities).toEqual([
			{
				fieldUuid: activity,
				rows: [],
				kind: "delivery",
				id: "visit",
				name: "Visit",
				entityId,
				entityName: "",
				workAreaId: "",
			},
		]);
		expect((await loadCase(store, SESSION_CASE))?.properties).toMatchObject({
			visit_note: "Reached the household",
		});
		const replay = await submit(doc, engine, store);
		expect(replay.activities).toEqual(result.activities);
	});

	it.each([false, true])(
		"operation reads and repeated effects inherit relevance: %s",
		async (participates) => {
			const { doc, formUuid } = operationRelevanceDoc();
			const store = makeStore();
			await seedSessionCase(store, doc);
			const engine = engineFor(doc, formUuid);
			engine.addRepeat("/data/visits");
			engine.setValue("/data/external_code", participates ? "yes" : "no");
			const result = await submit(doc, engine, store);
			expect((await loadCase(store, SESSION_CASE))?.properties).toEqual({
				visit_note: "kept",
				...(participates ? { op_status: "pending" } : {}),
			});
			// The own case, the root read, and the repeat's create when the
			// repeat participates.
			expect(result.operations.filter((op) => op.executed)).toHaveLength(
				participates ? 3 : 2,
			);
			expect(
				await store.query({
					reading: SEARCH_READING,
					appId: APP_ID,
					caseType: "patient",
				}),
			).toHaveLength(participates ? 2 : 1);
		},
	);

	it.each([
		["10", "3", 3, 1],
		["-10", "3", -3, -1],
		["10", "-3", -3, 1],
		["-10", "-3", 3, -1],
	] as const)(
		"stores admitted arithmetic from %s and %s with declared answer types",
		async (numerator, denominator, quotient, remainder) => {
			const { doc, formUuid } = arithmeticFixture();
			const store = makeStore();
			await seedSessionCase(store, doc);
			const engine = engineFor(doc, formUuid);
			engine.setValue("/data/numerator", numerator);
			engine.setValue("/data/denominator", denominator);
			engine.setValue("/data/decimal", "10");
			await submit(doc, engine, store);
			const row = await loadCase(store, SESSION_CASE);
			expect(row?.properties).toEqual({
				quotient,
				remainder,
				mixed: 10 / Number(denominator),
				large: 715827882,
			});
		},
	);
	it("creates a registration's case and its children from the committed form, each named case under the id its entry minted", async () => {
		const { doc, formUuid } = ordinaryAuthorityDoc();
		const store = makeStore();
		const schemas = buildCaseTypeMap(doc);
		for (const caseType of doc.caseTypes ?? []) {
			await store.applySchemaChange({
				appId: APP_ID,
				caseType: caseType.name,
				caseTypeSchemas: schemas,
			});
		}

		const mutation = ordinaryAuthorityMutation(doc, formUuid);
		const projection = validateCaptureSubmissionProjection(mutation);
		const built = buildCaseOperationProgramFromDoc({
			device: webAppsDevice(),
			blueprint: doc,
			mutation,
			projection,
			identity: IDENTITY,
		});
		expect(built.ordinaryAction).toEqual({ kind: "registration" });
		const program = built.program;
		// The entry's session names the patient and its one visit, so both
		// are created with the ids the form read; the repeat's orders are
		// named by no datum.
		expect(
			program?.operations.map(({ operation }) => [
				operation.action,
				program.entryCaseKeys?.get(operation.uuid),
			]),
		).toEqual([
			["own", "new-case"],
			["create", "new-child-case:visit"],
			["create", undefined],
		]);
		const envelope = submissionEnvelopeArgs(mutation, APP_ID, {
			...built,
			submissionReceipt: {
				...buildSubmissionReceiptIdentity({
					appId: APP_ID,
					identity: IDENTITY,
					mutation,
					projection,
				}),
				expectedAppMutationSeq: 0,
				blueprintDigest: "0".repeat(64),
			},
		});

		const result = await store.applySubmission(envelope);
		const entryKey = envelope.submissionReceipt.entryKey;
		const patientId = entryDatumCaseId(APP_ID, entryKey, "new-case");
		const visitId = entryDatumCaseId(APP_ID, entryKey, "new-child-case:visit");
		expect(result.primaryCaseIds).toEqual([patientId]);
		expect(result.createdChildren).toEqual([]);
		const patients = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		expect(
			patients.map((row) => [row.case_id, row.case_name, row.properties]),
		).toEqual([[patientId, "Ada", { age: 37 }]]);
		const [visit] = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "visit",
		});
		expect(visit).toMatchObject({
			case_id: visitId,
			case_name: "First visit",
			parent_case_id: patientId,
			properties: { notes: "Checkup" },
		});
		const orders = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "medication_order",
		});
		expect(orders.map((row) => row.case_name).sort()).toEqual([
			"Aspirin",
			"Hydrangea",
		]);
		for (const order of orders) {
			expect(order.parent_case_id).toBe(patientId);
		}
		const ids = new Set([
			patientId,
			visitId,
			...orders.map((row) => row.case_id),
		]);
		expect(ids.size).toBe(4);
	});

	it("refuses zero or multiple eligible groups and writes the single restored owner to the actual case rows", async () => {
		const { doc, formUuid } = ordinaryAuthorityDoc();
		const sharing = {
			...doc,
			appSettings: { ...doc.appSettings, caseSharing: true },
		};
		const owners = [{ id: "north-circle", name: "North", details: [] }];
		expect(() => ordinaryAuthorityMutation(sharing, formUuid, [])).toThrow();
		expect(() =>
			ordinaryAuthorityMutation(sharing, formUuid, [...owners, ...owners]),
		).toThrow();
		const store = makeStore();
		for (const type of doc.caseTypes ?? [])
			await store.applySchemaChange({
				appId: APP_ID,
				caseType: type.name,
				caseTypeSchemas: buildCaseTypeMap(sharing),
			});
		const mutation = ordinaryAuthorityMutation(sharing, formUuid, owners),
			projection = validateCaptureSubmissionProjection(mutation);
		const built = buildCaseOperationProgramFromDoc({
			device: webAppsDevice(),
			blueprint: sharing,
			identity: IDENTITY,
			projection,
			mutation,
			workerGroups: owners,
			workerScopeRevision: { project: "0", places: "0" },
		});
		const expectedOperations = built.program?.groupDefaults?.operations;
		expect(expectedOperations?.length).toBeGreaterThan(0);
		const submission = submissionEnvelopeArgs(mutation, APP_ID, {
			...built,
			submissionReceipt: {
				...buildSubmissionReceiptIdentity({
					appId: APP_ID,
					identity: IDENTITY,
					mutation,
					projection,
				}),
				expectedAppMutationSeq: 0,
				blueprintDigest: "0".repeat(64),
			},
		});
		await sql`INSERT INTO lookup_project_state(project_id,revision) VALUES (${PROJECT},1) ON CONFLICT(project_id) DO UPDATE SET revision=1`.execute(
			dbHandle.db,
		);
		await expect(store.applySubmission(submission)).rejects.toThrow(
			/groups or places changed/,
		);
		expect(
			await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "patient",
			}),
		).toEqual([]);
		const fresh = buildCaseOperationProgramFromDoc({
			device: webAppsDevice(),
			blueprint: sharing,
			identity: IDENTITY,
			projection,
			mutation,
			workerGroups: owners,
			workerScopeRevision: { project: "1", places: "0" },
		});
		await store.applySubmission(
			submissionEnvelopeArgs(mutation, APP_ID, {
				...fresh,
				submissionReceipt: submission.submissionReceipt,
			}),
		);
		const [patient] = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		expect(patient.owner_id).toBe(owners[0].id);
	});

	it.each([
		["no", 0, undefined],
		["yes", 1, "open"],
		["yes and close", 1, "closed"],
	] as const)(
		"runs a registration's own case under its open and close conditions (%s)",
		async (answer, created, status) => {
			const doc = buildDoc(
				{
					appName: "Conditional registration",
					caseTypes: [{ name: "patient", properties: [] }],
					modules: [
						{
							name: "Patients",
							caseType: "patient",
							caseListConfig: caseListConfig([
								{ field: "case_name", header: "Name" },
							]),
							forms: [
								{
									name: "Register",
									type: "registration",
									fields: [
										f({
											kind: "text",
											id: "name",
											caseWrite: {
												caseType: "patient",
												property: "case_name",
											},
										}),
										f({ kind: "text", id: "consent" }),
									],
								},
							],
						},
					],
				},
				(draft) => {
					const [formUuid] = Object.keys(draft.forms);
					const consent = Object.values(draft.fields).find(
						(field) => field.id === "consent",
					);
					if (formUuid === undefined || consent === undefined) return;
					draft.forms[formUuid] = {
						...draft.forms[formUuid],
						// Create the case on consent; close it again at once when
						// the answer also says to close it.
						openCondition: or(
							eq(formField(consent.uuid), literal("yes")),
							eq(formField(consent.uuid), literal("yes and close")),
						),
						closeCondition: eq(
							formField(consent.uuid),
							literal("yes and close"),
						),
					};
				},
			);
			const formUuid = Object.keys(doc.forms)[0] as Uuid;
			const store = makeStore();
			await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(doc),
			});
			const engine = engineFor(doc, formUuid);
			engine.setValue("/data/name", "Amina");
			engine.setValue("/data/consent", answer);
			const mutation = engine.computeSubmissionMutation({
				entryKey: ENTRY_KEY,
			});
			const projection = validateCaptureSubmissionProjection(mutation);
			const built = buildCaseOperationProgramFromDoc({
				device: webAppsDevice(),
				blueprint: doc,
				mutation,
				projection,
				identity: IDENTITY,
			});
			await store.applySubmission(
				submissionEnvelopeArgs(mutation, APP_ID, {
					...built,
					submissionReceipt: {
						...buildSubmissionReceiptIdentity({
							appId: APP_ID,
							identity: IDENTITY,
							mutation,
							projection,
						}),
						expectedAppMutationSeq: 0,
						blueprintDigest: "0".repeat(64),
					},
				}),
			);
			const rows = await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "patient",
				includeHeld: true,
			});
			expect(rows).toHaveLength(created);
			if (status !== undefined) {
				expect(rows[0]).toMatchObject({ case_name: "Amina", status });
			}
		},
	);

	it("uses the captured answer to resolve a dynamic create type through the Preview program", async () => {
		const answer = testUuid("case-type-answer");
		const doc = buildDoc(
			{
				appId: APP_ID,
				caseTypes: [
					{ name: "person", properties: [] },
					{ name: "visitor", properties: [] },
				],
				modules: [
					{
						name: "Intake",
						forms: [
							{
								name: "Check in",
								type: "survey",
								fields: [f({ kind: "text", id: "selection", uuid: answer })],
							},
						],
					},
				],
			},
			(draft) => {
				const form = Object.values(draft.forms)[0];
				if (form === undefined) throw new Error("Expected the intake form.");
				form.caseOperations = [
					{
						uuid: OP_ROOT,
						id: "new_record",
						action: "create",
						caseType: "person",
						target: { kind: "new" },
						name: term(literal("Checked in")),
						typeChoice: {
							condition: eq(formField(answer), literal("person")),
							otherwise: "visitor",
						},
						writes: [{ property: "selection", value: term(formField(answer)) }],
					},
				];
			},
		);
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const store = makeStore();
		const caseTypeSchemas = buildCaseTypeMap(doc);
		for (const caseType of ["person", "visitor"])
			await store.applySchemaChange({
				appId: APP_ID,
				caseType,
				caseTypeSchemas,
			});
		const input = buildEngineInput(doc, formUuid, null);
		if (input === undefined) throw new Error("Expected the intake form.");
		const engine = new FormEngine(input);
		engine.setValue("/data/selection", "guest");
		const mutation = engine.computeSubmissionMutation({ entryKey: ENTRY_KEY });
		const projection = validateCaptureSubmissionProjection(mutation);
		const built = buildCaseOperationProgramFromDoc({
			device: webAppsDevice(),
			blueprint: doc,
			mutation,
			projection,
			identity: IDENTITY,
		});
		await store.applySubmission(
			submissionEnvelopeArgs(mutation, APP_ID, {
				...built,
				submissionReceipt: {
					...buildSubmissionReceiptIdentity({
						appId: APP_ID,
						identity: IDENTITY,
						mutation,
						projection,
					}),
					expectedAppMutationSeq: 0,
					blueprintDigest: "0".repeat(64),
				},
			}),
		);
		const readCases = (caseType: string) =>
			store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType,
			});
		expect(await readCases("person")).toEqual([]);
		expect(await readCases("visitor")).toEqual([
			expect.objectContaining({
				case_type: "visitor",
				case_name: "Checked in",
				properties: { selection: "guest" },
			}),
		]);
	});

	it("closes the complete ordered selection when the committed close condition holds", async () => {
		const { doc, formUuid } = conditionalCloseDoc();
		const store = makeStore();
		await seedSessionCase(store, doc);
		await seedSecondSessionCase(store);

		const engine = engineFor(doc, formUuid);
		engine.setValue("/data/close_when", "done");
		const mutation = engine.computeSubmissionMutation({
			caseIds: [SECOND_SESSION_CASE, SESSION_CASE],
			entryKey: ENTRY_KEY,
		});
		const projection = validateCaptureSubmissionProjection(mutation);
		const built = buildCaseOperationProgramFromDoc({
			device: webAppsDevice(),
			blueprint: doc,
			mutation,
			projection,
			identity: IDENTITY,
		});
		expect(built).toMatchObject({
			ordinaryFormType: "close",
			ordinaryAction: {
				kind: "close",
				caseIds: [SECOND_SESSION_CASE, SESSION_CASE],
				caseType: "patient",
				selection: { kind: "multiple", maximum: 4 },
			},
		});
		expect(built.program?.ownCase).toEqual({
			caseType: "patient",
			formType: "close",
			closeCondition: doc.forms[formUuid]?.closeCondition,
		});
		const envelope = submissionEnvelopeArgs(mutation, APP_ID, {
			...built,
			submissionReceipt: {
				...buildSubmissionReceiptIdentity({
					appId: APP_ID,
					identity: IDENTITY,
					mutation,
					projection,
				}),
				expectedAppMutationSeq: 0,
				blueprintDigest: "0".repeat(64),
			},
		});

		const result = await store.applySubmission(envelope);
		expect(result.primaryCaseIds).toEqual([SECOND_SESSION_CASE, SESSION_CASE]);
		const rows = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		expect(
			rows
				.filter((row) =>
					[SESSION_CASE, SECOND_SESSION_CASE].includes(row.case_id),
				)
				.map((row) => row.status),
		).toEqual(["closed", "closed"]);
	});

	it("keeps every selected case open when the committed close condition is false", async () => {
		const { doc, formUuid } = conditionalCloseDoc();
		const store = makeStore();
		await seedSessionCase(store, doc);
		await seedSecondSessionCase(store);

		const engine = engineFor(doc, formUuid);
		engine.setValue("/data/close_when", "not yet");
		const mutation = engine.computeSubmissionMutation({
			caseIds: [SESSION_CASE, SECOND_SESSION_CASE],
			entryKey: ENTRY_KEY,
		});
		const projection = validateCaptureSubmissionProjection(mutation);
		const built = buildCaseOperationProgramFromDoc({
			device: webAppsDevice(),
			blueprint: doc,
			mutation,
			projection,
			identity: IDENTITY,
		});
		const envelope = submissionEnvelopeArgs(mutation, APP_ID, {
			...built,
			submissionReceipt: {
				...buildSubmissionReceiptIdentity({
					appId: APP_ID,
					identity: IDENTITY,
					mutation,
					projection,
				}),
				expectedAppMutationSeq: 0,
				blueprintDigest: "0".repeat(64),
			},
		});
		expect(envelope.ordinary.kind).toBe("close");

		await store.applySubmission(envelope);
		const rows = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		expect(
			rows
				.filter((row) =>
					[SESSION_CASE, SECOND_SESSION_CASE].includes(row.case_id),
				)
				.map((row) => row.status),
		).toEqual(["open", "open"]);
	});

	it("the own case and a later root operation each write their own values", async () => {
		const { doc, formUuid } = acceptanceDoc((ids) => [
			{
				uuid: OP_ROOT,
				id: "op_root",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [
					// Written from the free root answer.
					{ property: "op_status", value: term(formField(ids.note)) },
					// Written from a BLANK root answer — must land as an ABSENT
					// key, never null or "". (A root operation may read root
					// answers only — the validator's correlation rule.)
					{ property: "visit_note", value: term(formField(ids.extra)) },
				],
			} satisfies CaseOperation,
		]);
		const store = makeStore();
		await seedSessionCase(store, doc);

		const engine = engineFor(doc, formUuid);
		engine.setValue("/data/note", "from-operation");
		engine.setValue("/data/external_code", "from-own-case");

		const result = await submit(doc, engine, store);
		expect(result.primaryCaseIds).toEqual([SESSION_CASE]);
		// The own case first, as the array holds it.
		expect(
			result.operations.map(({ action, executed }) => [action, executed]),
		).toEqual([
			["own", true],
			["update", true],
		]);

		const row = await loadCase(store, SESSION_CASE);
		expect(row?.properties.op_status).toBe("from-operation");
		expect("visit_note" in (row?.properties ?? {})).toBe(false);
		expect(row?.external_id).toBe("from-own-case");
		expect(row?.properties).not.toHaveProperty("external_id");
	});

	it("a repeat-scoped create runs per live iteration with that iteration's answers", async () => {
		const { doc, formUuid } = acceptanceDoc((ids) => [
			{
				uuid: OP_REPEAT,
				id: "op_repeat",
				action: "create",
				caseType: "patient",
				target: { kind: "new" },
				forEach: { repeat: ids.visits },
				name: term(formField(ids.visitNote)),
				writes: [
					{ property: "visit_note", value: term(formField(ids.visitNote)) },
				],
			} satisfies CaseOperation,
		]);
		const store = makeStore();
		await seedSessionCase(store, doc);

		const engine = engineFor(doc, formUuid);
		engine.addRepeat("/data/visits");
		engine.addRepeat("/data/visits");
		engine.setValue("/data/visits[0]/visit_note", "first visit");
		engine.setValue("/data/visits[1]/visit_note", "second visit");

		const result = await submit(doc, engine, store);
		const executed = result.operations.filter(
			(op) => op.executed && op.operationUuid === OP_REPEAT,
		);
		expect(executed).toHaveLength(2);
		expect(executed.map((op) => op.iteration)).toEqual([0, 1]);

		const rows = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		const created = rows.filter((row) => row.case_id !== SESSION_CASE);
		expect(created.map((row) => row.case_name).sort()).toEqual([
			"first visit",
			"second visit",
		]);
	});

	it("a blank authored key rejects before the own case's write can commit", async () => {
		const { doc, formUuid } = acceptanceDoc((ids) => [
			{
				uuid: OP_ROOT,
				id: "op_keyed",
				action: "create",
				caseType: "patient",
				target: { kind: "new", idFrom: ids.note },
				name: term(literal("Keyed case")),
			} satisfies CaseOperation,
		]);
		const store = makeStore();
		await seedSessionCase(store, doc);

		const engine = engineFor(doc, formUuid);
		// The authored key's source answer stays BLANK; the own case still
		// saves a scalar that must not survive the rollback.
		engine.setValue("/data/external_code", "should-roll-back");

		await expect(submit(doc, engine, store)).rejects.toThrow(
			SubmissionRejectedError,
		);
		const row = await loadCase(store, SESSION_CASE);
		expect(row?.external_id).toBe("seed-external");
		expect(row?.properties).not.toHaveProperty("external_id");
	});

	it("a false condition skips the effect and records executed: false", async () => {
		const { doc, formUuid } = acceptanceDoc((ids) => [
			{
				uuid: OP_ROOT,
				id: "op_gated",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				condition: matchNone(),
				writes: [{ property: "op_status", value: term(formField(ids.note)) }],
			} satisfies CaseOperation,
		]);
		const store = makeStore();
		await seedSessionCase(store, doc);

		const engine = engineFor(doc, formUuid);
		engine.setValue("/data/note", "never-lands");

		const result = await submit(doc, engine, store);
		expect(
			result.operations.find((op) => op.operationUuid === OP_ROOT)?.executed,
		).toBe(false);
		const row = await loadCase(store, SESSION_CASE);
		// The gated operation is skipped, while the own case's blank
		// `external_id` write still executes under scalar semantics: blank
		// explicitly clears that optional scalar rather than preserving it.
		expect(row?.external_id).toBe("");
		expect(row?.properties).not.toHaveProperty("external_id");
	});

	it("a lookup-backed false condition skips its operation while the own case's write commits", async () => {
		const appDb = dbHandle.db as Kysely<AppDatabase>;
		/* A lookup writer reads its member's role on its own transaction, so the
		 * table below is written by a member of the Project. */
		await sql`
			CREATE TABLE auth_member (
				id text PRIMARY KEY,
				"userId" text NOT NULL,
				"organizationId" text NOT NULL,
				role text NOT NULL,
				UNIQUE ("organizationId", "userId")
			)
		`.execute(appDb);
		await sql`
			INSERT INTO auth_member (id, "userId", "organizationId", role)
			VALUES ('program-acceptance-member', ${ACTOR}, ${PROJECT}, 'owner')
		`.execute(appDb);
		const seeded = await appDb.transaction().execute(async (tx) =>
			applyLookupAuthoringBatchInTransaction(
				tx,
				await authorizeLookupWriteInTransaction(
					tx,
					{ projectId: PROJECT, actorId: ACTOR },
					"edit",
				),
				{
					createTables: [
						{
							key: "operation_gate",
							name: "Operation gate",
							tag: "operation_gate",
							columns: [
								{
									key: "status",
									wireName: "status",
									label: "Status",
									dataType: "text",
								},
							],
							rows: [],
						},
					],
				},
			),
		);
		const table = seeded.tables[0];
		const columnId = table?.columnIds[0]?.id;
		if (!table || !columnId) throw new Error("Lookup seed is incomplete.");
		const { doc, formUuid } = acceptanceDoc((ids) => [
			{
				uuid: OP_ROOT,
				id: "op_lookup_gated",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				condition: eq(
					tableLookup(
						table.tableId,
						columnId,
						eq(tableColumn(table.tableId, columnId), literal("enabled")),
					),
					literal("enabled"),
				),
				writes: [{ property: "op_status", value: term(formField(ids.note)) }],
			} satisfies CaseOperation,
		]);
		const store = makeStore();
		await seedSessionCase(store, doc);

		const lookupSnapshot = await appDb
			.transaction()
			.execute((tx) =>
				readLookupDefinitionsInTransaction(tx, PROJECT, [table.tableId]),
			);
		const engine = engineFor(doc, formUuid, {
			kind: "available",
			...lookupSnapshot,
		});
		engine.setValue("/data/note", "never-lands");
		engine.setValue("/data/external_code", "own-case-landed");
		const lookupTableSchemas: LookupTableSchemas = new Map(
			lookupSnapshot.definitions.map((definition) => [
				definition.id,
				new Map(
					definition.columns.map((column) => [column.id, column.dataType]),
				),
			]),
		);

		const result = await submit(doc, engine, store, lookupTableSchemas);
		expect(
			result.operations.find((op) => op.operationUuid === OP_ROOT),
		).toMatchObject({ executed: false });
		const row = await loadCase(store, SESSION_CASE);
		expect(row?.external_id).toBe("own-case-landed");
		expect(row?.properties).not.toHaveProperty("external_id");
		expect("op_status" in (row?.properties ?? {})).toBe(false);
	});
});
