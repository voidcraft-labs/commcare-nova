/**
 * The targeted documents are documents an editor could make, the same on
 * every build, and each expectation can run where it says.
 *
 * Contract: every targeted document is what Nova's planner makes from the
 * empty document and Nova's commit gate admits (`../build.ts`), whatever was
 * built before it in the process; and each expectation of its
 * `expected.json` names a form the document holds and, where it names a
 * restore, a file the document writes beside it. The plausible failures: a
 * document Nova's gate would refuse (it would be no editor's document, and
 * its symptom no user's), a planner that drops or reshapes part of what was
 * written (the corpus would then hold another document than the one fixed by
 * hand), an identity drawn from `buildDoc`'s counter (the document would move
 * with every document built before it, and a control retained from it would
 * no longer match its regenerated self), an expectation the lane's
 * observation would refuse only once HQ and Core have booted, and a file of
 * the document's own that would leave its directory or overwrite a file of
 * the corpus layout. The observations are the documents themselves, built
 * twice, and the refusals `targetedDocument` gives a document the gate
 * refuses, one the planner would not reproduce, and a file name the corpus
 * would not write, and an expectation on the local archive of a document
 * that declares no Android, which Nova offers no `.ccz` of. A document that writes D′ carries its edit as the batch
 * Nova's planner makes from D and the gate admits over D, so its edit is one
 * an editor could make too, and the edit is refused as the document is.
 *
 * A migration witness (`../documents/migrations.ts`) is a targeted document
 * whose A is the export of the app from before a migration, retained under
 * `proof/migrations/<id>/`, and whose B is Nova's republish of the migrated
 * document over that A, under the configurations A was published to. The
 * plausible failures: a witness its source does not mark (the lane would
 * judge it as any document and compare the old A with nothing), and a
 * witness spec whose content Nova's publish would refuse under a
 * configuration its A was published to, which the corpus writer finds only
 * once it captures. The observations are the witnesses' sources and Nova's
 * publish verdict of each, held to the configurations of its retained A, or,
 * before its A is retained, to the configurations the corpus derives for it.
 *
 * A query repeat's held placement is written in a document as a migration
 * writes it for a published app, which no editor's mutation does: the
 * document is made without it and the hold laid on what the gate committed,
 * which the gate admits whole. The plausible failures: a hold the corpus
 * drops (the witness would republish a placement its A never had), an edit
 * that changes a hold (no editor's edit can), and a witness whose repeats
 * take another placement than the one it witnesses. The observations are the
 * documents made, a refused edit, and each repeat's effective placement in
 * the two placement witnesses.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { planPlacements } from "@/lib/commcare/placement";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	type BlueprintDoc,
	fieldPreload,
	proseText,
	type Uuid,
} from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { effectiveQueryRepeatPlacement } from "@/lib/domain/queryRepeatPlacement";
import {
	type CorpusConfiguration,
	documentConfigurations,
} from "../../corpus/configurations";
import type { CorpusDocument } from "../../corpus/documents";
import { retainedMigrationA } from "../../corpus/inputs";
import { minimumConfiguration, novaPublishVerdict } from "../../corpus/publish";
import { targetedDocument, targetedUuid } from "../build";
import type { Expected } from "../expected";
import { TARGETED_DOCUMENTS, targetedDocuments } from "../index";

function formsOf(doc: { readonly forms: Record<string, unknown> }) {
	return new Set(Object.keys(doc.forms));
}

describe("the targeted documents", () => {
	it("are the same whatever was built before them", () => {
		const first = targetedDocuments();
		// Advance buildDoc's counter, which mints any identity a document leaves out.
		for (let i = 0; i < 3; i++) {
			buildDoc({
				modules: [
					{ name: "Other", forms: [{ name: "Other", type: "survey" }] },
				],
			});
		}
		const again = targetedDocuments();
		expect(again).toEqual(first);
		expect(new Set(first.map((document) => document.id)).size).toBe(
			TARGETED_DOCUMENTS.length,
		);
	});

	it("name in each expectation a form the document holds and a restore it writes", () => {
		for (const document of targetedDocuments()) {
			expect(document.source.kind).toBe("targeted");
			const expected = document.expected as Expected;
			expect(expected.intent.length).toBeGreaterThan(0);
			const forms = formsOf(document.doc);
			const files = new Set(Object.keys(document.files ?? {}));
			for (const entry of expected.intent) {
				expect(forms, `${document.id}: ${entry.id}`).toContain(entry.form);
				if (entry.restore !== undefined) {
					expect(files, `${document.id}: ${entry.id}`).toContain(entry.restore);
				}
				if (entry.request.caseList !== undefined) {
					expect(entry.export, `${document.id}: ${entry.id}`).toBe("local");
				}
			}
		}
	});
});

/** The configurations the corpus writes for a document no A is retained for (`../../corpus/entryWriter.ts`). */
function derivedConfigurations(document: CorpusDocument) {
	const verdict = novaPublishVerdict(hydratePersistedBlueprint(document.doc));
	const least = minimumConfiguration([verdict]);
	return documentConfigurations({
		flags: least.flags,
		caseSearchEnabled: least.caseSearchEnabled,
		singleFlags: document.singleFlags ?? [],
		namedPrivileges: document.privileges ?? [],
		...(document.projectSettings?.syncCasesOnFormEntry !== undefined && {
			syncCasesOnFormEntry: document.projectSettings.syncCasesOnFormEntry,
		}),
		...(document.projectSettings?.commtrack !== undefined && {
			commtrack: document.projectSettings.commtrack,
		}),
	});
}

describe("the migration witnesses", () => {
	it("admits each migration witness and gives it the configurations of its retained A", async () => {
		const documents = targetedDocuments();
		const witnesses = documents.filter(
			(document) =>
				document.source.kind === "targeted" &&
				document.source.migrationWitness === true,
		);
		// A witness is named for its migration, and only a witness is.
		expect(witnesses.map((document) => document.id)).toEqual(
			documents
				.map((document) => document.id)
				.filter((name) => name.startsWith("targeted-migration-")),
		);
		expect(witnesses.length).toBeGreaterThan(0);
		for (const document of witnesses) {
			const verdict = novaPublishVerdict(
				hydratePersistedBlueprint(document.doc),
			).minimumConfiguration;
			const retained = await retainedMigrationA(document.id);
			const configurations =
				retained?.configurations ?? derivedConfigurations(document);
			const named: [string, CorpusConfiguration][] = [
				["minimum", configurations.minimum],
				["maximum", configurations.maximum],
				...Object.entries(configurations.singleFlag),
			];
			for (const [name, configuration] of named) {
				const where = `${document.id} under ${name}`;
				// Nova's publish of the witness accepts each project space its A was published to.
				for (const flag of verdict.flags) {
					expect(configuration.flags, where).toContain(flag);
				}
				if (verdict.caseSearchEnabled) {
					expect(configuration.caseSearchEnabled, where).toBe(true);
				}
				expect(configuration.namedPrivileges, where).toEqual(
					[...(document.privileges ?? [])].sort(),
				);
			}
		}
		// The attachment witness's retained A was published where case attachments
		// are kept. Its migrated spec saves only links, so the flag is read from
		// the retained A alone: a spec's derived configurations no longer hold it.
		const retained = await retainedMigrationA("targeted-migration-attachment");
		expect(retained).toBeDefined();
		expect(retained?.configurations.minimum.flags).toContain(
			"MM_CASE_PROPERTIES",
		);
	});
});

describe("a targeted document", () => {
	const id = "targeted-planted";
	const uuid = (name: string) => targetedUuid(id, name);
	const expected: Expected = { intent: [] };

	it("is refused, by the gate's finding, when Nova's gate refuses it", () => {
		// A module with no forms and no case list: the gate's NO_FORMS_OR_CASE_LIST.
		const doc = buildDoc({
			appId: id,
			appName: "Planted",
			modules: [{ uuid: uuid("module"), name: "Empty", forms: [] }],
		});
		expect(() => targetedDocument({ id, rows: [], doc, expected })).toThrow(
			/commit gate refused the targeted document targeted-planted \(NO_FORMS_OR_CASE_LIST/,
		);
	});

	const survey = () =>
		buildDoc({
			appId: id,
			appName: "Planted",
			modules: [
				{
					uuid: uuid("module"),
					name: "Survey",
					forms: [
						{
							uuid: uuid("form"),
							name: "Survey",
							type: "survey",
							fields: [
								f({
									kind: "text",
									uuid: uuid("field"),
									id: "answer",
									label: proseText("Answer"),
								}),
							],
						},
					],
				},
			],
		});

	it("is refused where the planner makes another document than the one written, and named where it differs", () => {
		const doc = survey();
		expect(targetedDocument({ id, rows: [], doc, expected }).doc).toEqual(
			JSON.parse(JSON.stringify({ ...doc, fieldParent: undefined })),
		);
		// An empty catalog the gate admits, which Nova stores as no catalog.
		expect(() =>
			targetedDocument({
				id,
				rows: [],
				doc: { ...doc, caseTypes: [] },
				expected,
			}),
		).toThrow(/differ from the document written, first at \/caseTypes/);
	});

	it("carries the edit it writes as the batch Nova's planner makes and the gate admits, and is refused where the gate refuses it", () => {
		const doc = survey();
		const renamed = structuredClone(doc);
		renamed.appName = "Planted again";
		const made = targetedDocument({
			id,
			rows: [],
			doc,
			expected,
			edit: renamed,
		});
		expect(made.edit?.mutations.map((mutation) => mutation.kind)).toEqual([
			"setAppName",
		]);
		expect(made.edit?.nextDoc).toEqual(
			JSON.parse(JSON.stringify({ ...renamed, fieldParent: undefined })),
		);
		expect(made.doc).toEqual(
			JSON.parse(JSON.stringify({ ...doc, fieldParent: undefined })),
		);
		// An edit that empties the module of its forms: the gate's NO_FORMS_OR_CASE_LIST.
		const emptied = buildDoc({
			appId: id,
			appName: "Planted",
			modules: [{ uuid: uuid("module"), name: "Survey", forms: [] }],
		});
		expect(() =>
			targetedDocument({ id, rows: [], doc, expected, edit: emptied }),
		).toThrow(
			/commit gate refused the edit of the targeted document targeted-planted \(NO_FORMS_OR_CASE_LIST/,
		);
	});

	it("writes its own files only under a plain name in its directory that no corpus file takes", () => {
		const doc = survey();
		const restore = "<OpenRosaResponse/>\n";
		expect(
			targetedDocument({
				id,
				rows: [],
				doc,
				expected,
				files: { "restore.xml": restore },
			}).files,
		).toEqual({ "restore.xml": restore });
		for (const name of [
			"expected.json",
			"document.json",
			"hq-side.json",
			"../restore.xml",
			"edit/restore.xml",
			"Restore.xml",
			"restore.ccz",
		]) {
			expect(() =>
				targetedDocument({
					id,
					rows: [],
					doc,
					expected,
					files: { [name]: restore },
				}),
			).toThrow(
				`The corpus document ${id} names its own file ${JSON.stringify(name)}; a document's own file is a plain lower-case .xml or .json name in its directory`,
			);
		}
	});

	it("refuses an expectation on a local archive of a document that declares no Android, and runs the same one on HQ's build", () => {
		const doc = survey();
		doc.appSettings = { ...doc.appSettings, runsOnlyOn: "web-apps" };
		const expectation = (exportName: "local" | "A"): Expected => ({
			intent: [
				{
					id: "answer-held",
					export: exportName,
					form: uuid("form"),
					request: {
						answers: [{ path: "/data/answer", value: "seen" }],
						expressions: ["/data/answer"],
					},
					expect: [{ pointer: "/values/0/value", value: "seen" }],
				},
			],
		});
		expect(() =>
			targetedDocument({ id, rows: [], doc, expected: expectation("local") }),
		).toThrow(
			`The targeted document ${id} declares no Android, so Nova offers no local archive of it; run its expectation answer-held on HQ's build ("A").`,
		);
		expect(
			targetedDocument({ id, rows: [], doc, expected: expectation("A") })
				.expected,
		).toEqual(expectation("A"));
	});

	it("admits exact edit commands only when their replay makes the written document", () => {
		const doc = survey();
		const edit = { ...doc, appName: "Renamed" };
		const editMutations = Object.freeze([
			{ kind: "setAppName" as const, name: "Renamed" },
		]);
		const spec = { id, rows: [], doc, edit, editMutations, expected };
		expect(targetedDocument(spec).edit?.mutations).toEqual(editMutations);
		expect(() => targetedDocument({ ...spec, edit: doc })).toThrow(
			/differ from the document written, first at \/appName/,
		);
		expect(() =>
			targetedDocument({
				...spec,
				editMutations: [{ kind: "removeForm", uuid: uuid("form") }],
			}),
		).toThrow(/commit gate refused the edit/);
		expect(() => targetedDocument({ ...spec, edit: undefined })).toThrow(
			/edit commands without the document/,
		);
	});
});

/** Each query repeat of `document`'s one form by id: the placement it holds and
 * the one it takes. */
function placementsOf(document: CorpusDocument) {
	const doc = hydratePersistedBlueprint(document.doc);
	const [formUuid] = Object.keys(doc.forms) as Uuid[];
	const form =
		formUuid === undefined ? undefined : formStructure(doc, formUuid);
	if (form === undefined) throw new Error(`${document.id} holds no form.`);
	const placements: Record<string, { held?: string; taken: string }> = {};
	for (const field of Object.values(doc.fields)) {
		if (field.kind !== "repeat" || field.repeat_mode !== "query_bound")
			continue;
		placements[field.id] = {
			...(field.placement !== undefined && { held: field.placement }),
			taken: effectiveQueryRepeatPlacement(form, field.uuid),
		};
	}
	return placements;
}

describe("a query repeat's held placement", () => {
	const byId = (id: string) => {
		const found = targetedDocuments().find((document) => document.id === id);
		if (found === undefined) throw new Error(`No targeted document ${id}.`);
		return found;
	};

	it("is kept in the migration witness as the cutover writes it, beside repeats that hold none", () => {
		expect(placementsOf(byId("targeted-migration-query-repeats"))).toEqual({
			visits: { held: "model-iteration", taken: "model-iteration" },
			members: { taken: "count" },
			later: { taken: "count" },
		});
	});

	it("leaves every repeat of the placements witness to its shape: model iteration at the root over no answer, the count placement otherwise", () => {
		expect(placementsOf(byId("targeted-query-repeat-placements"))).toEqual({
			visits: { taken: "model-iteration" },
			stock: { taken: "count" },
			readings: { taken: "count" },
			children: { taken: "count" },
		});
	});

	const id = "targeted-held";
	const uuid = (name: string) => targetedUuid(id, name);
	const held = (placement?: "model-iteration" | "count") =>
		buildDoc({
			appId: id,
			appName: "Held",
			modules: [
				{
					uuid: uuid("module"),
					name: "Survey",
					forms: [
						{
							uuid: uuid("form"),
							name: "Survey",
							type: "survey",
							fields: [
								f({
									kind: "repeat",
									uuid: uuid("rows"),
									id: "rows",
									label: proseText("Rows"),
									repeat_mode: "query_bound",
									data_source: { ids_query: "'a b'" },
									...(placement !== undefined && { placement }),
									children: [
										f({
											kind: "text",
											uuid: uuid("note"),
											id: "note",
											label: proseText("Note"),
										}),
									],
								}),
							],
						},
					],
				},
			],
		});

	it("is carried into the document made, and an edit that changes it is refused", () => {
		const doc = held("model-iteration");
		const made = targetedDocument({
			id,
			rows: [],
			doc,
			expected: { intent: [] },
		});
		expect(made.doc.fields[uuid("rows")]).toMatchObject({
			placement: "model-iteration",
		});
		// An edit that keeps the hold and renames the app is an editor's edit.
		const renamed = { ...doc, appName: "Held again" };
		expect(
			targetedDocument({
				id,
				rows: [],
				doc,
				expected: { intent: [] },
				edit: renamed,
			}).edit?.nextDoc.fields[uuid("rows")],
		).toMatchObject({ placement: "model-iteration" });
		for (const edit of [held("count"), held()]) {
			expect(() =>
				targetedDocument({ id, rows: [], doc, expected: { intent: [] }, edit }),
			).toThrow(
				`The edit of the targeted document ${id} changes a held placement, which no editor's edit writes; hold the same placements in both documents.`,
			);
		}
	});
});

/**
 * A case change's held placement, and the explicit preload.
 *
 * Contract: a migration witness holds each case change, and each own close
 * kept in a Save to Case block, where its retained A keeps it, as the
 * cutover writes it for a published app, and Nova's placement plan keeps
 * every hold, so B republishes each change where A has it. The plausible
 * failure: a hold the corpus drops or the plan cannot express, so B would
 * move a case change no migration decides (proof 1 would then report a move
 * with no entry). The observations are the documents made and the plan over
 * each witness form. Beside them, `targeted-load-time-values`: its weight
 * writer opens with the read of the patient's weight, and its export holds
 * no `case_preload`, the plausible failure being a preload written back into
 * Case Management, where HQ loads it after every other default.
 */
describe("a case change's held placement", () => {
	const byId = (id: string) => {
		const found = targetedDocuments().find((document) => document.id === id);
		if (found === undefined) throw new Error(`No targeted document ${id}.`);
		return hydratePersistedBlueprint(found.doc);
	};
	/** Each form's holds, by form name, with what the plan does with each. */
	const holdsOf = (doc: BlueprintDoc) =>
		Object.fromEntries(
			Object.values(doc.forms).flatMap((form) => {
				const planned = planPlacements(doc, form.uuid).placements;
				const holds = [
					...(form.caseOperations ?? []).flatMap((operation) =>
						operation.placement === undefined
							? []
							: [[operation.id, operation.placement, operation.uuid] as const],
					),
					...(form.ownClosePlacement === undefined
						? []
						: [["own close", form.ownClosePlacement, "own-close"] as const]),
				];
				return holds.length === 0
					? []
					: [
							[
								form.name,
								Object.fromEntries(
									holds.map(([name, placement, key]) => [
										name,
										{
											placement,
											kept:
												planned.get(key)?.held === true &&
												JSON.stringify(planned.get(key)?.placement) ===
													JSON.stringify(placement),
										},
									]),
								),
							],
						];
			}),
		);
	const basic = (slot: "own" | "usercase" | "subcase-row") => ({
		placement: { kind: "basic", slot },
		kept: true,
	});
	const block = (path: string[], repeat?: Uuid) => ({
		placement: {
			kind: "save-to-case",
			...(repeat !== undefined && { repeat }),
			path,
		},
		kept: true,
	});

	it("is every case change of the case-writes witness at the place its A keeps it, and the plan keeps each", () => {
		const doc = byId("targeted-migration-case-writes");
		const arrivals = targetedUuid("targeted-migration-case-writes", "arrivals");
		expect(holdsOf(doc)).toEqual({
			Register: {
				household: basic("own"),
				head: {
					placement: { kind: "basic", slot: "subcase", index: 0 },
					kept: true,
				},
				member: basic("subcase-row"),
			},
			Visit: {
				household: basic("own"),
				add_referral: block([
					"nova_operations",
					"nova_keyed_add_referral",
					"add_referral",
				]),
				mark_visited: block(["nova_operations", "mark_visited"]),
				flag_household: block([
					"nova_operations",
					"nova_condition_flag_household",
					"flag_household",
				]),
				commcare_user: basic("usercase"),
				add_arrival: block(["nova_operations", "add_arrival"], arrivals),
			},
			Discharge: {
				household: basic("own"),
				"own close": block([
					"nova_operations",
					"nova_condition_discharge_household",
					"discharge_household",
				]),
			},
			Close: { household: basic("own") },
			"Close in repeat": {
				household: basic("own"),
				"own close": block([
					"nova_operations",
					"nova_condition_close",
					"nova_close",
				]),
			},
			"Batch update": {
				household: block([
					"nova_selected_cases",
					"item",
					"nova_operations",
					"nova_condition_update_selected_cases",
					"nova_update_selected_cases",
				]),
			},
		});
		// Discharge closed its case through an operation; it is a close form now.
		const discharge = Object.values(doc.forms).find(
			(form) => form.name === "Discharge",
		);
		expect(discharge?.type).toBe("close");
		expect(
			(discharge?.caseOperations ?? []).map((operation) => operation.action),
		).toEqual(["own"]);
	});

	it("is the own case of the groups-preloads witness, whose weight opens with the patient's weight", () => {
		const doc = byId("targeted-migration-groups-preloads");
		expect(holdsOf(doc)).toEqual({ Check: { patient: basic("own") } });
		const weight =
			doc.fields[targetedUuid("targeted-migration-groups-preloads", "weight")];
		expect(weight === undefined ? undefined : fieldPreload(weight)).toEqual({
			caseType: "patient",
			property: "weight",
		});
	});

	it("leaves the load-time values document's weight opening with the patient's weight, and its export with no case_preload", () => {
		const doc = byId("targeted-load-time-values");
		const weight =
			doc.fields[targetedUuid("targeted-load-time-values", "weight")];
		expect(weight === undefined ? undefined : fieldPreload(weight)).toEqual({
			caseType: "patient",
			property: "weight",
		});
		const app = expandDoc(doc) as unknown as {
			modules: {
				forms: { actions: { case_preload: { preload: object } } }[];
			}[];
		};
		expect(
			app.modules.flatMap((module) =>
				module.forms.map((form) => form.actions.case_preload.preload),
			),
		).toEqual([{}]);
	});
});

/**
 * `targeted-case-writes-one-concept` holds each shape of a case change its
 * manifest entries name, in the place each takes.
 *
 * Contract: the registration's own case, its open and close conditions, its
 * two children and its write of the worker's record are Case Management's,
 * the follow-up's explicit preload, `via` write and save-only-if-changed
 * write are its own case's update keys, the computed write alone takes a
 * Save to Case block, and the document's configurations hold the flag that
 * makes HQ compare the changed answer. The plausible failure: a shape that
 * falls to Save to Case or leaves the export (the manifest entries it flips
 * would then be held by no document), or a configuration without the flag,
 * where HQ's build saves the answer every time. The observations are the
 * placement plan, the HQ import body's form actions, and Nova's publish
 * verdict's minimum configuration.
 */
describe("the case-writes document", () => {
	const made = () => {
		const found = targetedDocuments().find(
			(document) => document.id === "targeted-case-writes-one-concept",
		);
		if (found === undefined)
			throw new Error("No targeted document targeted-case-writes-one-concept.");
		return found;
	};

	it("keeps every change in Case Management but the computed write, which alone takes Save to Case", () => {
		const doc = hydratePersistedBlueprint(made().doc);
		const placed = Object.fromEntries(
			Object.values(doc.forms).map((form) => [
				form.name,
				Object.fromEntries(
					[...planPlacements(doc, form.uuid).placements].map(
						([key, planned]) => [
							key === "own-close"
								? "own close"
								: form.caseOperations?.find((op) => op.uuid === key)?.id,
							planned.placement,
						],
					),
				),
			]),
		);
		const own = { kind: "basic", slot: "own" };
		expect(placed).toEqual({
			"Register patient": {
				patient: own,
				"own close": own,
				contact: { kind: "basic", slot: "subcase", index: 0 },
				dose: { kind: "basic", slot: "subcase-row" },
				commcare_user: { kind: "basic", slot: "usercase" },
			},
			"Check patient": { patient: own },
			"Score patient": {
				patient: { kind: "save-to-case", path: ["nova_operations", "patient"] },
			},
			Discharge: { patient: own, "own close": own },
		});
	});

	it("exports the open and close conditions, the children, the update keys and no case_preload", () => {
		const app = expandDoc(hydratePersistedBlueprint(made().doc)) as unknown as {
			modules: {
				forms: {
					actions: {
						open_case: { condition: object };
						close_case: { condition: object };
						update_case: { update: Record<string, object> };
						subcases: {
							case_type: string;
							repeat_context: string;
							condition: object;
						}[];
						usercase_update: { update: Record<string, object> };
						case_preload: { preload: object };
					};
				}[];
			}[];
		};
		const [register, check, , discharge] = app.modules[0]?.forms ?? [];
		const when = (question: string, answer: string) => ({
			type: "if",
			question,
			answer,
			operator: "=",
		});
		expect(register?.actions.open_case.condition).toMatchObject(
			when("/data/consent", "yes"),
		);
		expect(register?.actions.close_case.condition).toMatchObject(
			when("/data/outcome", "moved"),
		);
		expect(
			register?.actions.subcases.map((subcase) => [
				subcase.case_type,
				subcase.repeat_context,
			]),
		).toEqual([
			["contact", ""],
			["dose", "/data/doses"],
		]);
		expect(register?.actions.subcases[1]?.condition).toMatchObject(
			when("/data/doses/given", "yes"),
		);
		expect(Object.keys(register?.actions.usercase_update.update ?? {})).toEqual(
			["last_village"],
		);
		expect(check?.actions.update_case.update).toMatchObject({
			weight: { question_path: "/data/weight", update_mode: "always" },
			note: { question_path: "/data/note", update_mode: "always" },
			"parent/district": {
				question_path: "/data/district",
				update_mode: "always",
			},
			risk: { question_path: "/data/risk", update_mode: "edit" },
		});
		expect(discharge?.actions.close_case.condition).toMatchObject(
			when("/data/reason", "recovered"),
		);
		for (const form of app.modules[0]?.forms ?? [])
			expect(form.actions.case_preload.preload).toEqual({});
	});

	it("is published only where HQ compares a changed answer, and its edit renames the choice its close condition holds", () => {
		const document = made();
		const verdict = novaPublishVerdict(hydratePersistedBlueprint(document.doc));
		expect(minimumConfiguration([verdict]).flags).toContain(
			"SAVE_ONLY_EDITED_FORM_FIELDS",
		);
		const outcome = targetedUuid("targeted-case-writes-one-concept", "outcome");
		const edited = document.edit?.nextDoc.fields[outcome];
		expect(
			edited !== undefined && "optionsSource" in edited
				? edited.optionsSource
				: undefined,
		).toMatchObject({
			options: [{ value: "staying" }, { value: "relocated" }],
		});
		expect(document.edit?.mutations.map((mutation) => mutation.kind)).toEqual([
			"updateOption",
		]);
	});
});
