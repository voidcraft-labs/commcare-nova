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
 * would not write. A document that writes D′ carries its edit as the batch
 * Nova's planner makes from D and the gate admits over D, so its edit is one
 * an editor could make too, and the edit is refused as the document is.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
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
});
