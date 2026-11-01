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
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { proseText } from "@/lib/domain";
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
		// The attachment witness's A is published where case attachments are kept.
		const attachment = witnesses.find(
			(document) => document.id === "targeted-migration-attachment",
		);
		expect(attachment).toBeDefined();
		if (attachment !== undefined) {
			const retained = await retainedMigrationA(attachment.id);
			expect(
				(retained?.configurations ?? derivedConfigurations(attachment)).minimum
					.flags,
			).toContain("MM_CASE_PROPERTIES");
		}
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
