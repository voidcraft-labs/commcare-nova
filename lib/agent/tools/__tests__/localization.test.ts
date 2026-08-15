import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	makeCanonicalGenesisDoc,
	makeToolWorkspaceHarness,
} from "@/lib/agent/__tests__/fixtures";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { updateAppTool } from "@/lib/agent/tools/updateApp";
import { applyMutation } from "@/lib/doc/mutations";
import {
	collectLocalizedTranslationUnits,
	collectTranslationUnits,
	effectiveAppLocalization,
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

function mutateResult(value: unknown): {
	readonly mutations: readonly unknown[];
	readonly result: Record<string, unknown>;
} {
	return value as {
		readonly mutations: readonly unknown[];
		readonly result: Record<string, unknown>;
	};
}

function readData(value: unknown): Record<string, unknown> {
	return (value as { readonly data: Record<string, unknown> }).data;
}

describe("shared localization tools", () => {
	it("reads the effective legacy language without materializing it", async () => {
		const doc = makeCanonicalGenesisDoc("Clinic");
		const harness = makeToolWorkspaceHarness(doc);
		const result = readData(await harness.runTool(getLanguagesTool, {}));

		expect(result).toMatchObject({
			sourceLanguage: "en",
			defaultLanguage: "en",
			classicCatalogSize: 487,
			languages: [
				{
					code: "en",
					name: "English",
					isSource: true,
					isDefault: true,
					coverage: { ready: expect.any(Number) },
				},
			],
		});
		expect(harness.currentDoc()).toBe(doc);
		expect(harness.recordMutations).not.toHaveBeenCalled();
	});

	it("adds a target atomically with an explicit copied entry for every unit", async () => {
		const doc = makeCanonicalGenesisDoc("Clinic");
		const unitCount = collectTranslationUnits(doc).length;
		const harness = makeToolWorkspaceHarness(doc);
		const outcome = mutateResult(
			await harness.runTool(addLanguageTool, {
				code: "es",
				name: "Español",
				direction: "ltr",
				copyFrom: "en",
			}),
		);

		expect(outcome.result).not.toHaveProperty("error");
		expect(outcome.mutations).toHaveLength(unitCount + 1);
		expect(outcome.mutations[0]).toEqual({
			kind: "addLanguage",
			language: { code: "es", name: "Español", direction: "ltr" },
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
		expect(Object.keys(state.translations.es ?? {})).toHaveLength(unitCount);
		expect(
			collectLocalizedTranslationUnits(harness.currentDoc(), "es"),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					status: "needs-review",
					explicit: expect.objectContaining({
						origin: "copied",
						translatedFrom: "en",
					}),
				}),
			]),
		);
		const languages = readData(await harness.runTool(getLanguagesTool, {}))
			.languages as Array<Record<string, unknown>>;
		expect(languages.find((language) => language.code === "es")).toMatchObject({
			automaticTranslation: {
				sourceLanguage: "en",
				targetLanguage: "es",
				status: "available",
			},
		});
		expect(harness.recordMutations).toHaveBeenCalledTimes(1);
	});

	it("pages a filtered inventory and rejects a cursor after relevant state changes", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		await harness.runTool(addLanguageTool, {
			code: "es",
			name: "Español",
			copyFrom: "en",
		});
		const first = readData(
			await harness.runTool(getTranslatableContentTool, {
				language: "es",
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
			language: "es",
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
				language: "es",
				limit: 1,
				cursor: page.nextCursor,
			}),
		);
		expect(stalePage.error).toContain("changed");
	});

	it("invalidates a filtered cursor when only returned context changes", async () => {
		const genesis = makeCanonicalGenesisDoc("Clinic");
		const form = Object.values(genesis.forms)[0];
		expect(form).toBeDefined();
		if (form === undefined) return;
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
			code: "es",
			name: "Español",
			copyFrom: "en",
		});
		const module = Object.values(firstHarness.currentDoc().modules)[0];
		const first = readData(
			await firstHarness.runTool(getTranslatableContentTool, {
				language: "es",
				role: "field-label",
				limit: 1,
			}),
		);
		const cursor = (first.page as { nextCursor: string }).nextCursor;
		expect(cursor).toEqual(expect.any(String));
		expect(module).toBeDefined();
		if (module === undefined) return;

		const renamed = produce(firstHarness.currentDoc(), (draft) => {
			applyMutation(draft, {
				kind: "renameModule",
				uuid: module.uuid,
				newId: "Community intake",
			});
		});
		const secondHarness = makeToolWorkspaceHarness(renamed);
		const stalePage = readData(
			await secondHarness.runTool(getTranslatableContentTool, {
				language: "es",
				role: "field-label",
				limit: 1,
				cursor,
			}),
		);
		expect(stalePage.error).toContain("changed");
	});

	it("writes machine-authored values as Needs review and reviews with an exact stale-value fence", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		await harness.runTool(addLanguageTool, {
			code: "es",
			name: "Español",
			copyFrom: "en",
		});
		const appUnit = collectTranslationUnits(harness.currentDoc()).find(
			(unit) => unit.role === "app-name",
		);
		expect(appUnit).toBeDefined();
		if (appUnit === undefined) return;

		const set = mutateResult(
			await harness.runTool(updateTranslationsTool, {
				language: "es",
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
				.es?.[appUnit.id],
		).toMatchObject({
			value: "Clínica",
			origin: "ai",
			review: "needs-review",
			translatedFrom: "en",
		});

		await harness.runTool(updateAppTool, { name: "Health clinic" });
		const stale = collectLocalizedTranslationUnits(
			harness.currentDoc(),
			"es",
		).find((unit) => unit.id === appUnit.id);
		expect(stale).toMatchObject({
			status: "out-of-date",
			effective: "Health clinic",
			explicit: { value: "Clínica" },
		});
		if (stale?.explicit === undefined) return;

		const reviewed = mutateResult(
			await harness.runTool(updateTranslationsTool, {
				language: "es",
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
			collectLocalizedTranslationUnits(harness.currentDoc(), "es").find(
				(unit) => unit.id === appUnit.id,
			),
		).toMatchObject({ status: "ready", effective: "Clínica" });
	});

	it("rejects a set translated from source content a peer has changed", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		await harness.runTool(addLanguageTool, {
			code: "es",
			name: "Español",
			copyFrom: "en",
		});
		const read = collectTranslationUnits(harness.currentDoc()).find(
			(unit) => unit.role === "app-name",
		);
		expect(read).toBeDefined();
		if (read === undefined) return;

		await harness.runTool(updateAppTool, { name: "Health clinic" });
		const writesBefore = harness.recordMutations.mock.calls.length;
		const outcome = mutateResult(
			await harness.runTool(updateTranslationsTool, {
				language: "es",
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
			code: "es",
			name: "Español",
			copyFrom: "en",
		});
		await harness.runTool(updateAppTool, { name: "Health clinic" });
		const read = collectLocalizedTranslationUnits(
			harness.currentDoc(),
			"es",
		).find((unit) => unit.role === "app-name");
		expect(read?.explicit).toBeDefined();
		if (read?.explicit === undefined) return;

		await harness.runTool(updateAppTool, { name: "Community health clinic" });
		const writesBefore = harness.recordMutations.mock.calls.length;
		const outcome = mutateResult(
			await harness.runTool(updateTranslationsTool, {
				language: "es",
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
			code: "es",
			name: "Español",
			copyFrom: "en",
		});
		const appUnit = collectTranslationUnits(harness.currentDoc()).find(
			(unit) => unit.role === "app-name",
		);
		expect(appUnit).toBeDefined();
		if (appUnit === undefined) return;
		const writesBefore = harness.recordMutations.mock.calls.length;
		const outcome = mutateResult(
			await harness.runTool(updateTranslationsTool, {
				language: "es",
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

	it("changes the runtime default before allowing target removal", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc("Clinic"));
		await harness.runTool(addLanguageTool, {
			code: "es",
			name: "Español",
			copyFrom: "en",
		});
		await harness.runTool(updateLanguageTool, {
			action: "set-default",
			code: "es",
		});
		const refused = mutateResult(
			await harness.runTool(removeLanguageTool, { code: "es" }),
		);
		expect(refused.result.error).toContain("default");

		await harness.runTool(updateLanguageTool, {
			action: "set-default",
			code: "en",
		});
		const removed = mutateResult(
			await harness.runTool(removeLanguageTool, { code: "es" }),
		);
		expect(removed.result).not.toHaveProperty("error");
		expect(harness.currentDoc().localization).toBeUndefined();
	});

	it("keeps tool schemas closed and registers the exact SA/MCP family", () => {
		expect(
			addLanguageInputSchema.safeParse({
				code: "fra",
				copyFrom: "en",
				autoTranslate: true,
			}).success,
		).toBe(false);
		expect(
			updateLanguageInputSchema.safeParse({
				action: "set-default",
				code: "es",
				patch: { direction: "ltr" },
			}).success,
		).toBe(false);
		expect(
			updateTranslationsInputSchema.safeParse({
				language: "es",
				updates: [
					{ operation: "clear", unitId: "tu1:1:a" },
					{ operation: "clear", unitId: "tu1:1:a" },
				],
			}).success,
		).toBe(false);

		const family = SHARED_TOOL_REGISTRY.filter((entry) =>
			[
				"getLanguages",
				"getTranslatableContent",
				"addLanguage",
				"updateLanguage",
				"removeLanguage",
				"updateTranslations",
			].includes(entry.saName),
		).map(({ saName, mcpName, requires }) => ({
			saName,
			mcpName,
			requires,
		}));
		expect(family).toEqual([
			{ saName: "getLanguages", mcpName: "get_languages", requires: "view" },
			{
				saName: "getTranslatableContent",
				mcpName: "get_translatable_content",
				requires: "view",
			},
			{ saName: "addLanguage", mcpName: "add_language", requires: "edit" },
			{
				saName: "updateLanguage",
				mcpName: "update_language",
				requires: "edit",
			},
			{
				saName: "removeLanguage",
				mcpName: "remove_language",
				requires: "edit",
			},
			{
				saName: "updateTranslations",
				mcpName: "update_translations",
				requires: "edit",
			},
		]);
	});
});
