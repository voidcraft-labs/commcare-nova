/** Actual localization commands, schema admission and workspace state. Writer
 * receipts are controlled; sequential stale-state checks do not prove SQL
 * races, and this suite neither invokes a model nor tests MCP transport. */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import {
	makeCanonicalGenesisDoc,
	makeToolWorkspaceHarness as makeRawHarness,
} from "@/lib/agent/__tests__/fixtures";
import { updateAppTool } from "@/lib/agent/tools/updateApp";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import { expandDoc } from "@/lib/commcare/expander";
import {
	mutationCommitVerdict,
	type PreparedMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { workerWording } from "@/lib/doc/localizationWorkspace";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutation } from "@/lib/doc/mutations";
import {
	collectLocalizedTranslationUnits,
	collectTranslationUnits,
	effectiveAppLocalization,
	makeTranslationUnitId,
	proseText,
} from "@/lib/domain";
import {
	addLanguageInputSchema,
	addLanguageTool,
	getLanguagesTool,
	getTranslatableContentTool,
	removeLanguageTool,
	updateLanguageInputSchema,
	updateLanguageTool,
	updateTranslationsInputSchema,
	updateTranslationsTool,
} from "../localization";
import { updateModuleTool } from "../updateModule";

function makeToolWorkspaceHarness(doc: Parameters<typeof makeRawHarness>[0]) {
	return makeRawHarness(expectAdmittedDoc(doc));
}

function mutateResult(value: unknown) {
	return z
		.object({
			mutations: z.array(z.unknown()),
			result: z.record(z.string(), z.unknown()),
		})
		.parse(value);
}

function readData(value: unknown): Record<string, unknown> {
	return z.object({ data: z.record(z.string(), z.unknown()) }).parse(value)
		.data;
}

function schemaIssues(
	result: { success: true } | { success: false; error: z.ZodError },
): string {
	return result.success
		? ""
		: JSON.stringify(result.error.issues.map((issue) => issue.message));
}

describe("shared localization tools", () => {
	it("creates a project language, edits its writing direction and keeps its own translations", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		const language = { kind: "project", language: "qaa" } as const;
		await harness.runTool(addLanguageTool, { language });
		const units = readData(
			await harness.runTool(getTranslatableContentTool, { language }),
		);
		expect(units).toMatchObject({
			items: expect.arrayContaining([
				expect.objectContaining({ effective: "Clinic" }),
			]),
		});
		await harness.runTool(updateLanguageTool, {
			action: "set-direction",
			language,
			direction: "rtl",
		});
		const languages = readData(await harness.runTool(getLanguagesTool, {}));
		expect(languages).toMatchObject({
			languages: expect.arrayContaining([
				expect.objectContaining({
					language,
					commcareCode: "qaa",
					endonym: "qaa",
					direction: "rtl",
					automaticTranslation: expect.objectContaining({
						status: "not-evaluated",
					}),
				}),
			]),
		});
	});

	it("reads the effective sentinel identity without materializing it", async () => {
		const doc = makeCanonicalGenesisDoc("Clinic");
		const harness = makeToolWorkspaceHarness(doc);
		const result = readData(await harness.runTool(getLanguagesTool, {}));

		expect(result).toMatchObject({
			sourceLanguage: { language: "eng" },
			defaultLanguage: { language: "eng" },
			languages: [
				{
					language: { language: "eng" },
					commcareCode: "en",
					endonym: "English",
					qualifiers: [],
					direction: "ltr",
					isSource: true,
					isDefault: true,
					automaticTranslation: null,
					coverage: { ready: expect.any(Number) },
				},
			],
		});
		expect(result.codePolicy).toContain("ISO 639:2023 Set 3");
		expect(harness.currentDoc()).toBe(doc);
		expect(harness.recordMutations).not.toHaveBeenCalled();
	});

	it("returns each language's stored CommCare code, a suffixed one included", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		for (const language of [
			{ language: "cmn", script: "Hans" },
			{ language: "cmn", script: "Hant" },
		]) {
			expect(
				mutateResult(await harness.runTool(addLanguageTool, { language }))
					.result,
			).not.toHaveProperty("error");
		}
		const languages = readData(await harness.runTool(getLanguagesTool, {}))
			.languages as Array<Record<string, unknown>>;
		expect(
			languages.map((entry) => [entry.language, entry.commcareCode]),
		).toEqual([
			[{ language: "eng" }, "en"],
			[{ language: "cmn", script: "Hans" }, "zho"],
			[{ language: "cmn", script: "Hant" }, "cmn-hant"],
		]);
		// Changing Simplified to Singapore Simplified adds the replacement
		// before removing the old language, so it mints beside the code the
		// old one still holds.
		expect(
			mutateResult(
				await harness.runTool(updateLanguageTool, {
					action: "change-identity",
					language: { language: "cmn", script: "Hans" },
					replacement: { language: "cmn", script: "Hans", region: "SG" },
				}),
			).result,
		).not.toHaveProperty("error");
		expect(
			effectiveAppLocalization(harness.currentDoc().localization).wireCodes,
		).toEqual({
			eng: "en",
			"cmn-Hant": "cmn-hant",
			"cmn-Hans-SG": "cmn-hanssg",
		});
	});

	it("adds a target atomically with explicit copies of the authored text and inherited control wording", async () => {
		const doc = makeCanonicalGenesisDoc("Clinic");
		const unitCount = collectTranslationUnits(doc).filter(
			(unit) => !unit.generated,
		).length;
		const harness = makeToolWorkspaceHarness(doc);
		const outcome = mutateResult(
			await harness.runTool(addLanguageTool, {
				language: { language: "spa" },
			}),
		);

		expect(outcome.result).not.toHaveProperty("error");
		expect(outcome.mutations).toHaveLength(unitCount + 1);
		expect(outcome.mutations[0]).toEqual({
			kind: "addLanguage",
			language: { language: "spa" },
			wireCode: "es",
		});
		expect(
			outcome.mutations
				.slice(1)
				.every(
					(mutation) =>
						(mutation as { kind?: string }).kind === "setTranslation",
				),
		).toBe(true);

		const state = effectiveAppLocalization(harness.currentDoc().localization);
		expect(state.languageOrder).toEqual(["eng", "spa"]);
		expect(Object.keys(state.translations.spa ?? {})).toHaveLength(unitCount);
		expect(
			collectLocalizedTranslationUnits(harness.currentDoc(), "spa"),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					status: "needs-review",
					explicit: expect.objectContaining({
						origin: "copied",
						translatedFrom: "eng",
					}),
				}),
			]),
		);
		const languages = readData(await harness.runTool(getLanguagesTool, {}))
			.languages as Array<Record<string, unknown>>;
		expect(
			languages.find(
				(entry) => (entry.language as { language: string }).language === "spa",
			),
		).toMatchObject({
			automaticTranslation: { status: "available" },
		});
		expect(harness.recordMutations).toHaveBeenCalledTimes(1);
	});

	// A search with no title holds its title unit with a blank source, which can't
	// be a translation (the title's role needs text): the copy leaves it out, and
	// the new language shows no title, as the copied one does.
	it("adds a language by copy beside a search with no title", async () => {
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					caseSearchConfig: { searchScreenTitle: { kind: "none" } },
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "note", label: "Note" })],
						},
					],
				},
			],
		});
		const harness = makeToolWorkspaceHarness(doc);
		const outcome = mutateResult(
			await harness.runTool(addLanguageTool, {
				language: { language: "spa" },
			}),
		);
		expect(outcome.result).not.toHaveProperty("error");
		const moduleUuid = harness.currentDoc().moduleOrder[0];
		const title = collectLocalizedTranslationUnits(
			harness.currentDoc(),
			"spa",
		).find(
			(unit) =>
				unit.id === makeTranslationUnitId("module", moduleUuid, "search-title"),
		);
		expect(title).toMatchObject({ effective: "", status: "ready" });
	});

	it("pages a filtered inventory and rejects a cursor after relevant state changes", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		await harness.runTool(addLanguageTool, {
			language: { language: "spa" },
		});
		const first = readData(
			await harness.runTool(getTranslatableContentTool, {
				language: { language: "spa" },
				limit: 1,
			}),
		);
		const firstItems = first.items as Array<Record<string, unknown>>;
		const page = first.page as { nextCursor: string; complete: boolean };
		expect(page.complete).toBe(false);
		expect(firstItems).toHaveLength(1);
		expect(firstItems[0]).toMatchObject({
			role: "app-name",
			status: "needs-review",
			breadcrumb: ["Clinic"],
			protectedParts: [],
		});

		await harness.runTool(updateTranslationsTool, {
			language: { language: "spa" },
			updates: [
				{
					operation: "set",
					unitId: firstItems[0]?.id,
					expectedSourceFingerprint: firstItems[0]?.sourceFingerprint,
					value: "Clínica",
				},
			],
		});
		const stalePage = readData(
			await harness.runTool(getTranslatableContentTool, {
				language: { language: "spa" },
				limit: 1,
				cursor: page.nextCursor,
			}),
		);
		expect(stalePage.error).toContain("changed");
	});

	it("traverses a multipage inventory to completion without duplicates or omissions", async () => {
		const doc = buildDoc({
			appName: "Large clinic",
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Intake",
							type: "survey",
							fields: Array.from({ length: 123 }, (_, i) =>
								f({
									kind: "text",
									id: `question_${i}`,
									label: proseText(`Question ${i}`),
								}),
							),
						},
					],
				},
			],
		});
		const h = makeToolWorkspaceHarness(doc);
		await h.runTool(addLanguageTool, { language: { language: "spa" } });
		const expected = collectTranslationUnits(h.currentDoc())
			.filter((unit) => !unit.generated?.dormant)
			.map((unit) => unit.id);
		expect(expected.length).toBeGreaterThan(123);
		const ids: string[] = [];
		const seen = new Set<string>();
		let cursor: string | null = null;
		for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
			const data = z
				.object({
					items: z.array(z.object({ id: z.string() })),
					page: z.object({
						returned: z.number(),
						complete: z.boolean(),
						nextCursor: z.string().nullable(),
					}),
				})
				.parse(
					readData(
						await h.runTool(getTranslatableContentTool, {
							language: { language: "spa" },
							limit: 17,
							cursor,
						}),
					),
				);
			expect(data.items.length).toBeGreaterThan(0);
			expect(data.items.length).toBeLessThanOrEqual(17);
			expect(data.page.returned).toBe(data.items.length);
			ids.push(...data.items.map((item) => item.id));
			if (data.page.complete) {
				expect(data.page.nextCursor).toBeNull();
				cursor = null;
				break;
			}
			expect(data.page.nextCursor).not.toBeNull();
			if (data.page.nextCursor === null)
				throw new Error("incomplete without cursor");
			expect(seen.has(data.page.nextCursor)).toBe(false);
			seen.add(data.page.nextCursor);
			cursor = data.page.nextCursor;
		}
		expect(cursor).toBeNull();
		expect(ids).toEqual(expected);
	});

	it("refuses an entire mixed update batch before a write when its later entry is invalid", async () => {
		const h = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		await h.runTool(addLanguageTool, { language: { language: "spa" } });
		const units = collectTranslationUnits(h.currentDoc()).filter(
			(unit) => unit.valueKind === "text",
		);
		if (units.length < 2) throw new Error("missing text units");
		const updates = units.slice(0, 2).map((unit, index) => ({
			operation: "set",
			unitId: unit.id,
			expectedSourceFingerprint: unit.sourceFingerprint,
			value: index === 0 ? "Clínica" : " ",
		}));
		const before = structuredClone(h.currentDoc());
		const writes = h.recordMutations.mock.calls.length;
		const refused = mutateResult(
			await h.runTool(updateTranslationsTool, {
				language: { language: "spa" },
				updates,
			}),
		);
		expect(refused.result.error).toEqual(
			expect.stringContaining("cannot be blank"),
		);
		expect(h.currentDoc()).toEqual(before);
		expect(h.recordMutations).toHaveBeenCalledTimes(writes);
		updates[1].value = "Encuesta";
		const accepted = mutateResult(
			await h.runTool(updateTranslationsTool, {
				language: { language: "spa" },
				updates,
			}),
		);
		expect(accepted.result).not.toHaveProperty("error");
		expect(h.recordMutations).toHaveBeenCalledTimes(writes + 1);
		expectAdmittedDoc(h.currentDoc());
	});

	it("rejects a version-1 cursor with a restart message", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		await harness.runTool(addLanguageTool, {
			language: { language: "spa" },
		});
		const staleV1Cursor = Buffer.from(
			JSON.stringify({
				version: 1,
				digest: "0".repeat(64),
				offset: 1,
				filters: { language: "es" },
			}),
			"utf8",
		).toString("base64url");
		const result = readData(
			await harness.runTool(getTranslatableContentTool, {
				language: { language: "spa" },
				limit: 1,
				cursor: staleV1Cursor,
			}),
		);
		expect(result.error).toContain("Restart the read without a cursor");
	});

	it("invalidates a filtered cursor when only returned context changes", async () => {
		const genesis = makeCanonicalGenesisDoc("Clinic");
		const form = Object.values(genesis.forms)[0];
		expect(form).toBeDefined();
		if (form === undefined) throw new Error("missing fixture form");
		const initial = produce(genesis, (draft) => {
			applyMutation(draft, {
				kind: "addField",
				parentUuid: form.uuid,
				field: {
					kind: "text",
					uuid: testUuid("translation-cursor-second-field"),
					id: "second_question",
					label: proseText("Second question"),
				},
			});
		});
		const firstHarness = makeToolWorkspaceHarness(initial);
		await firstHarness.runTool(addLanguageTool, {
			language: { language: "spa" },
		});
		const module = Object.values(firstHarness.currentDoc().modules)[0];
		const first = readData(
			await firstHarness.runTool(getTranslatableContentTool, {
				language: { language: "spa" },
				role: "field-label",
				limit: 1,
			}),
		);
		const cursor = (first.page as { nextCursor: string }).nextCursor;
		expect(cursor).toEqual(expect.any(String));
		expect(module).toBeDefined();
		if (module === undefined) throw new Error("missing fixture module");

		await firstHarness.runTool(updateModuleTool, {
			moduleUuid: module.uuid,
			name: "Community intake",
		});
		const stalePage = readData(
			await firstHarness.runTool(getTranslatableContentTool, {
				language: { language: "spa" },
				role: "field-label",
				limit: 1,
				cursor,
			}),
		);
		expect(stalePage.error).toContain("changed");
	});

	it("writes, reviews and restores default wording for a generated source-language message", async () => {
		const harness = makeToolWorkspaceHarness(
			localizationWireFixture("prompts"),
		);
		const row = collectTranslationUnits(harness.currentDoc()).find(
			(unit) =>
				unit.context.systemMessageDescription === "Search whole-number format",
		);
		if (!row) throw Error("Missing generated search message");
		const language = { language: "eng" };
		const wording = "Enter an integer.";
		const run = (
			update: z.infer<typeof updateTranslationsInputSchema>["updates"][number],
		) =>
			harness.runTool(updateTranslationsTool, { language, updates: [update] });
		expect(
			mutateResult(
				await run({
					operation: "set",
					unitId: row.id,
					expectedSourceFingerprint: row.sourceFingerprint,
					value: wording,
				}),
			).result,
		).not.toHaveProperty("error");
		const current = () =>
			collectLocalizedTranslationUnits(harness.currentDoc(), "eng").find(
				(unit) => unit.id === row.id,
			);
		expect(current()).toMatchObject({
			effective: wording,
			explicit: { origin: "ai", review: "needs-review" },
		});
		expect(
			mutateResult(
				await run({
					operation: "review",
					unitId: row.id,
					expectedSourceFingerprint: row.sourceFingerprint,
					expectedCurrentSourceFingerprint: current()?.sourceFingerprint ?? "",
					expectedValue: wording,
				}),
			).result,
		).not.toHaveProperty("error");
		expect(current()).toMatchObject({
			effective: wording,
			explicit: { origin: "ai", review: "reviewed" },
		});
		expect(
			mutateResult(await run({ operation: "clear", unitId: row.id })).result,
		).not.toHaveProperty("error");
		expect(current()?.effective).toBe(row.source);
		expect(current()?.explicit).toBeUndefined();
	});
	it("fences a reviewed generated translation against edited original wording through the shared tools, Preview and publish", async () => {
		const harness = makeToolWorkspaceHarness(
			localizationWireFixture("prompts"),
		);
		const lang = { language: "spa" };
		const read = () =>
			harness.runTool(getTranslatableContentTool, {
				language: lang,
				role: "generated-wording",
				ownerKind: "form",
				limit: 20,
			});
		const rowSchema = z.object({
			id: z.string(),
			source: z.string(),
			status: z.string(),
			explicit: z
				.object({
					sourceFingerprint: z.string(),
					value: z.string(),
					review: z.string(),
				})
				.optional(),
			sourceFingerprint: z.string(),
			defaultText: z.string(),
			effective: z.string(),
			output: z.object({ role: z.string() }),
		});
		const row = async () => {
			const response = await read();
			const entries = z
				.object({ items: z.array(rowSchema) })
				.parse(readData(response));
			const button = entries.items.find(
				(item) => item.output.role === "submitButton",
			);
			if (!button) throw Error("The form needs a submit button");
			return button;
		};
		const original = { language: "eng" };
		const set = (
			language: { language: string },
			text: string,
			expected: string,
			id: string,
		) =>
			harness
				.runTool(updateTranslationsTool, {
					language,
					updates: [
						{
							operation: "set",
							unitId: id,
							value: text,
							expectedSourceFingerprint: expected,
						},
					],
				})
				.then(mutateResult);
		const before = await row();
		expect(before.defaultText).toBe("Submit");
		expect(
			(
				await set(
					original,
					"Complete this visit",
					before.sourceFingerprint,
					before.id,
				)
			).result,
		).not.toHaveProperty("error");
		const first = await row();
		expect(first).toMatchObject({
			source: "Complete this visit",
			effective: "Submit",
		});
		expect(first.sourceFingerprint).not.toBe(before.sourceFingerprint);
		expect(
			(await set(lang, "Guardar visita", first.sourceFingerprint, first.id))
				.result,
		).not.toHaveProperty("error");
		const review = (
			expectedSourceFingerprint: string,
			expectedCurrentSourceFingerprint: string,
		) =>
			harness
				.runTool(updateTranslationsTool, {
					language: lang,
					updates: [
						{
							operation: "review",
							unitId: first.id,
							expectedValue: "Guardar visita",
							expectedSourceFingerprint,
							expectedCurrentSourceFingerprint,
						},
					],
				})
				.then(mutateResult);
		expect(
			(await review(first.sourceFingerprint, first.sourceFingerprint)).result,
		).not.toHaveProperty("error");
		expect((await row()).status).toBe("ready");
		const wire = () =>
			expandDoc(harness.currentDoc()).translations?.es[
				"forms.m0f0.submit_label"
			];
		const preview = () => workerWording(harness.currentDoc(), "spa", first.id);
		expect(preview()).toBe("Guardar visita");
		expect(wire()).toBe("Guardar visita");
		expect(
			(
				await set(
					original,
					"Send the completed visit",
					first.sourceFingerprint,
					first.id,
				)
			).result,
		).not.toHaveProperty("error");
		const revised = await row();
		expect(revised).toMatchObject({
			source: "Send the completed visit",
			effective: "Submit",
			status: "out-of-date",
			explicit: {
				value: "Guardar visita",
				review: "reviewed",
				sourceFingerprint: first.sourceFingerprint,
			},
		});
		expect(revised.sourceFingerprint).not.toBe(first.sourceFingerprint);
		expect(
			(await set(lang, "old write", first.sourceFingerprint, first.id)).result
				.error,
		).toContain("changed");
		expect(
			(await review(first.sourceFingerprint, first.sourceFingerprint)).result
				.error,
		).toContain("changed");
		expect(preview()).toBe("Submit");
		expect(wire()).toBeUndefined();
		expect(
			(await review(first.sourceFingerprint, revised.sourceFingerprint)).result,
		).not.toHaveProperty("error");
		expect((await row()).status).toBe("ready");
		expect(preview()).toBe("Guardar visita");
		expect(wire()).toBe("Guardar visita");
		await harness.runTool(updateTranslationsTool, {
			language: lang,
			updates: [{ operation: "clear", unitId: first.id }],
		});
		expect((await row()).effective).toBe("Submit");
	});

	it("writes machine-authored values as Needs review and reviews with an exact stale-value fence", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		await harness.runTool(addLanguageTool, {
			language: { language: "spa" },
		});
		const appUnit = collectTranslationUnits(harness.currentDoc()).find(
			(unit) => unit.role === "app-name",
		);
		expect(appUnit).toBeDefined();
		if (appUnit === undefined) throw new Error("missing app unit");

		const set = mutateResult(
			await harness.runTool(updateTranslationsTool, {
				language: { language: "spa" },
				updates: [
					{
						operation: "set",
						unitId: appUnit.id,
						expectedSourceFingerprint: appUnit.sourceFingerprint,
						value: "Clínica",
					},
				],
			}),
		);
		expect(set.result).not.toHaveProperty("error");
		expect(
			effectiveAppLocalization(harness.currentDoc().localization).translations
				.spa?.[appUnit.id],
		).toMatchObject({
			value: "Clínica",
			origin: "ai",
			review: "needs-review",
			translatedFrom: "eng",
		});

		await harness.runTool(updateAppTool, { name: "Health clinic" });
		const stale = collectLocalizedTranslationUnits(
			harness.currentDoc(),
			"spa",
		).find((unit) => unit.id === appUnit.id);
		expect(stale).toMatchObject({
			status: "out-of-date",
			effective: "Health clinic",
			explicit: { value: "Clínica" },
		});
		if (stale?.explicit === undefined) throw new Error("missing stale entry");

		const reviewed = mutateResult(
			await harness.runTool(updateTranslationsTool, {
				language: { language: "spa" },
				updates: [
					{
						operation: "review",
						unitId: stale.id,
						expectedSourceFingerprint: stale.explicit.sourceFingerprint,
						expectedCurrentSourceFingerprint: stale.sourceFingerprint,
						expectedValue: stale.explicit.value,
					},
				],
			}),
		);
		expect(reviewed.result).not.toHaveProperty("error");
		expect(
			collectLocalizedTranslationUnits(harness.currentDoc(), "spa").find(
				(unit) => unit.id === appUnit.id,
			),
		).toMatchObject({ status: "ready", effective: "Clínica" });
	});

	it("rejects a set translated from source content a peer has changed", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		await harness.runTool(addLanguageTool, {
			language: { language: "spa" },
		});
		const read = collectTranslationUnits(harness.currentDoc()).find(
			(unit) => unit.role === "app-name",
		);
		expect(read).toBeDefined();
		if (read === undefined) throw new Error("missing read unit");

		await harness.runTool(updateAppTool, { name: "Health clinic" });
		const writesBefore = harness.recordMutations.mock.calls.length;
		const outcome = mutateResult(
			await harness.runTool(updateTranslationsTool, {
				language: { language: "spa" },
				updates: [
					{
						operation: "set",
						unitId: read.id,
						expectedSourceFingerprint: read.sourceFingerprint,
						value: "Clínica",
					},
				],
			}),
		);
		expect(outcome.result.error).toContain("source content changed");
		expect(harness.recordMutations).toHaveBeenCalledTimes(writesBefore);
	});

	it("rejects a review when a peer changes the current source after it was read", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		await harness.runTool(addLanguageTool, {
			language: { language: "spa" },
		});
		await harness.runTool(updateAppTool, { name: "Health clinic" });
		const read = collectLocalizedTranslationUnits(
			harness.currentDoc(),
			"spa",
		).find((unit) => unit.role === "app-name");
		expect(read?.explicit).toBeDefined();
		if (read?.explicit === undefined) throw new Error("missing explicit entry");

		await harness.runTool(updateAppTool, { name: "Community health clinic" });
		const writesBefore = harness.recordMutations.mock.calls.length;
		const outcome = mutateResult(
			await harness.runTool(updateTranslationsTool, {
				language: { language: "spa" },
				updates: [
					{
						operation: "review",
						unitId: read.id,
						expectedSourceFingerprint: read.explicit.sourceFingerprint,
						expectedCurrentSourceFingerprint: read.sourceFingerprint,
						expectedValue: read.explicit.value,
					},
				],
			}),
		);
		expect(outcome.result.error).toContain("source content changed");
		expect(harness.recordMutations).toHaveBeenCalledTimes(writesBefore);
	});

	it("rejects blank required content before it reaches the commit gate", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		await harness.runTool(addLanguageTool, {
			language: { language: "spa" },
		});
		const appUnit = collectTranslationUnits(harness.currentDoc()).find(
			(unit) => unit.role === "app-name",
		);
		expect(appUnit).toBeDefined();
		if (appUnit === undefined) throw new Error("missing app unit");
		const writesBefore = harness.recordMutations.mock.calls.length;
		const outcome = mutateResult(
			await harness.runTool(updateTranslationsTool, {
				language: { language: "spa" },
				updates: [
					{
						operation: "set",
						unitId: appUnit.id,
						expectedSourceFingerprint: appUnit.sourceFingerprint,
						value: "  ",
					},
				],
			}),
		);
		expect(outcome.result.error).toContain("cannot be blank");
		expect(harness.recordMutations).toHaveBeenCalledTimes(writesBefore);
	});

	it("reports complete language removal when a peer adds a translation before commit", async () => {
		const h = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		await h.runTool(addLanguageTool, { language: { language: "spa" } });
		const peer = makeToolWorkspaceHarness(h.currentDoc());
		const unit = collectTranslationUnits(peer.currentDoc()).find(
			(item) => item.role === "app-name",
		);
		if (unit === undefined) throw new Error("Missing app name");
		await peer.runTool(updateTranslationsTool, {
			language: { language: "spa" },
			updates: [
				{
					operation: "set",
					unitId: unit.id,
					expectedSourceFingerprint: unit.sourceFingerprint,
					value: "Clínica",
				},
			],
		});
		expect(
			effectiveAppLocalization(peer.currentDoc().localization).translations.spa,
		).toHaveProperty(unit.id);
		h.recordMutations.mockImplementation(
			async (prepared: PreparedMutationCandidate) => {
				const committed = mutationCommitVerdict(
					peer.currentDoc(),
					prepared.mutations,
					LOOKUP_CONTEXT_UNAVAILABLE,
				);
				if (!committed.ok) throw new Error(JSON.stringify(committed));
				return { events: [], committedDoc: committed.nextDoc };
			},
		);
		const result = await h.runTool(removeLanguageTool, {
			language: { language: "spa" },
		});
		expect(result.result).toMatchObject({
			ok: true,
			translationsRemoved: "all-explicit",
		});
		expect(
			effectiveAppLocalization(h.currentDoc().localization).translations.spa,
		).toBeUndefined();
	});

	it("moves an existing language and keeps its reviewed and copied text attached", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		for (const language of ["spa", "fra"])
			await harness.runTool(addLanguageTool, { language: { language } });
		const before = effectiveAppLocalization(harness.currentDoc().localization);
		const response = await harness.runTool(updateLanguageTool, {
			action: "move",
			language: { language: "eng" },
			after: { language: "spa" },
		});
		expect(mutateResult(response).result).toMatchObject({
			ok: true,
			default: false,
		});
		expect(effectiveAppLocalization(harness.currentDoc().localization)).toEqual(
			{
				...before,
				defaultLanguage: "spa",
				languageOrder: ["spa", "eng", "fra"],
			},
		);
	});

	it("changes the runtime default before allowing target removal", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		await harness.runTool(addLanguageTool, {
			language: { language: "spa" },
		});
		await harness.runTool(updateLanguageTool, {
			action: "set-default",
			language: { language: "spa" },
		});
		const refused = mutateResult(
			await harness.runTool(removeLanguageTool, {
				language: { language: "spa" },
			}),
		);
		expect(refused.result.error).toContain("default");

		await harness.runTool(updateLanguageTool, {
			action: "set-default",
			language: { language: "eng" },
		});
		const removed = mutateResult(
			await harness.runTool(removeLanguageTool, {
				language: { language: "spa" },
			}),
		);
		expect(removed.result).not.toHaveProperty("error");
		expect(harness.currentDoc().localization).toBeUndefined();
	});

	it("re-keys a target identity while carrying every explicit translation", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		await harness.runTool(addLanguageTool, {
			language: { language: "spa" },
		});
		const appUnit = collectTranslationUnits(harness.currentDoc()).find(
			(unit) => unit.role === "app-name",
		);
		expect(appUnit).toBeDefined();
		if (appUnit === undefined) throw new Error("missing app unit");
		await harness.runTool(updateTranslationsTool, {
			language: { language: "spa" },
			updates: [
				{
					operation: "set",
					unitId: appUnit.id,
					expectedSourceFingerprint: appUnit.sourceFingerprint,
					value: "Clínica",
				},
			],
		});

		const outcome = mutateResult(
			await harness.runTool(updateLanguageTool, {
				action: "change-identity",
				language: { language: "spa" },
				replacement: { language: "spa", region: "MX" },
			}),
		);
		expect(outcome.result).not.toHaveProperty("error");
		const state = effectiveAppLocalization(harness.currentDoc().localization);
		expect(state.languageOrder).toEqual(["eng", "spa-MX"]);
		expect(state.translations["spa-MX"]?.[appUnit.id]).toMatchObject({
			value: "Clínica",
			origin: "ai",
			translatedFrom: "eng",
		});
		expect(state.translations.spa).toBeUndefined();
	});

	it("relabels the sole source language in place", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		const outcome = mutateResult(
			await harness.runTool(updateLanguageTool, {
				action: "change-identity",
				language: { language: "eng" },
				replacement: { language: "fra" },
			}),
		);
		expect(outcome.result).not.toHaveProperty("error");
		expect(outcome.mutations).toEqual([
			{
				kind: "relabelSourceLanguage",
				language: { language: "fra" },
				wireCode: "fra",
			},
		]);
		const state = effectiveAppLocalization(harness.currentDoc().localization);
		expect(state.sourceLanguage).toBe("fra");
		expect(state.defaultLanguage).toBe("fra");
		expect(state.languageOrder).toEqual(["fra"]);
	});

	it("refuses changing a multilingual app's source identity", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		await harness.runTool(addLanguageTool, {
			language: { language: "spa" },
		});
		const outcome = mutateResult(
			await harness.runTool(updateLanguageTool, {
				action: "change-identity",
				language: { language: "eng" },
				replacement: { language: "fra" },
			}),
		);
		expect(outcome.result.error).toContain("sole language");
	});

	it("rejects each non-member identity at the schema with the identifiers to use", () => {
		const macro = addLanguageInputSchema.safeParse({
			language: { language: "zho" },
		});
		expect(macro.success).toBe(false);
		expect(schemaIssues(macro)).toContain("macrolanguage");
		expect(schemaIssues(macro)).toContain("cmn (Mandarin Chinese)");

		const alias = addLanguageInputSchema.safeParse({
			language: { language: "fr" },
		});
		expect(alias.success).toBe(false);
		expect(schemaIssues(alias)).toContain("use fra");

		const nonLiving = addLanguageInputSchema.safeParse({
			language: { language: "lat" },
		});
		expect(nonLiving.success).toBe(false);
		expect(schemaIssues(nonLiving)).toContain("living");

		const unknown = addLanguageInputSchema.safeParse({
			language: { language: "xxx" },
		});
		expect(unknown.success).toBe(false);
		expect(schemaIssues(unknown)).toContain(
			"not a current ISO 639:2023 Set 3 language identifier",
		);

		const scriptMissing = addLanguageInputSchema.safeParse({
			language: { language: "cmn" },
		});
		expect(scriptMissing.success).toBe(false);
		expect(schemaIssues(scriptMissing)).toContain(
			"written in more than one script",
		);
		expect(schemaIssues(scriptMissing)).toContain("Hans (Simplified Chinese)");

		const scriptForeign = addLanguageInputSchema.safeParse({
			language: { language: "cmn", script: "Latn" },
		});
		expect(scriptForeign.success).toBe(false);
		expect(schemaIssues(scriptForeign)).toContain("writing systems");

		const regionForeign = addLanguageInputSchema.safeParse({
			language: { language: "cmn", script: "Hans", region: "TW" },
		});
		expect(regionForeign.success).toBe(false);
		expect(schemaIssues(regionForeign)).toContain("regional conventions");

		expect(
			addLanguageInputSchema.safeParse({
				language: { language: "cmn", script: "Hans" },
			}).success,
		).toBe(true);
		expect(
			addLanguageInputSchema.safeParse({
				language: { language: "spa", region: "MX" },
			}).success,
		).toBe(true);
	});

	it("preserves language membership and action refinements through schema safeExtend", () => {
		// The MCP adapter mounts every shared tool as
		// inputSchema.safeExtend({ app_id }), so the membership refinement
		// must survive extension for add_language to reject a macrolanguage
		// over MCP exactly as it does in chat.
		const extended = addLanguageTool.inputSchema.safeExtend({
			app_id: z.string(),
		});
		const macro = extended.safeParse({
			app_id: "app-1",
			language: { language: "zho" },
		});
		expect(macro.success).toBe(false);
		expect(schemaIssues(macro)).toContain("macrolanguage");
		expect(schemaIssues(macro)).toContain("cmn (Mandarin Chinese)");
		expect(
			extended.safeParse({
				app_id: "app-1",
				language: { language: "cmn", script: "Hans" },
			}).success,
		).toBe(true);

		// update_language carries an object-level refinement, the exact shape
		// safeExtend exists to preserve.
		const extendedUpdate = updateLanguageTool.inputSchema.safeExtend({
			app_id: z.string(),
		});
		expect(
			extendedUpdate.safeParse({
				app_id: "app-1",
				action: "set-default",
				language: { language: "spa" },
				replacement: { language: "fra" },
			}).success,
		).toBe(false);
		expect(
			extendedUpdate.safeParse({
				app_id: "app-1",
				action: "set-default",
				language: { language: "spa" },
			}).success,
		).toBe(true);
	});

	it("refuses unknown fields, incompatible actions and duplicate translation updates", () => {
		expect(
			addLanguageInputSchema.safeParse({
				language: { language: "fra" },
				copyFrom: { language: "eng" },
				autoTranslate: true,
			}).success,
		).toBe(false);
		expect(
			updateLanguageInputSchema.safeParse({
				action: "set-default",
				language: { language: "spa" },
				replacement: { language: "fra" },
			}).success,
		).toBe(false);
		expect(
			updateLanguageInputSchema.safeParse({
				action: "change-identity",
				language: { language: "spa" },
			}).success,
		).toBe(false);
		expect(
			updateTranslationsInputSchema.safeParse({
				language: { language: "spa" },
				updates: [
					{ operation: "clear", unitId: "tu1:1:a" },
					{ operation: "clear", unitId: "tu1:1:a" },
				],
			}).success,
		).toBe(false);
	});
});
