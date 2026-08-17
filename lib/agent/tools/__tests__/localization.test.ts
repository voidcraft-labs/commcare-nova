import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { z } from "zod";
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

function schemaIssues(result: { success: boolean; error?: unknown }): string {
	return result.success
		? ""
		: JSON.stringify(
				(result.error as { issues: readonly { message: string }[] }).issues.map(
					(issue) => issue.message,
				),
			);
}

describe("shared localization tools", () => {
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

	it("adds a target atomically with an explicit copied entry for every unit", async () => {
		const doc = makeCanonicalGenesisDoc("Clinic");
		const unitCount = collectTranslationUnits(doc).length;
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
		const decodedCursor = JSON.parse(
			Buffer.from(page.nextCursor, "base64url").toString("utf8"),
		) as { version: number; filters: { language: unknown } };
		expect(decodedCursor.version).toBe(2);
		expect(decodedCursor.filters.language).toEqual({ language: "spa" });

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
				language: { language: "spa" },
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
			language: { language: "spa" },
		});
		const appUnit = collectTranslationUnits(harness.currentDoc()).find(
			(unit) => unit.role === "app-name",
		);
		expect(appUnit).toBeDefined();
		if (appUnit === undefined) return;

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
		if (stale?.explicit === undefined) return;

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
		if (read === undefined) return;

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
		if (read?.explicit === undefined) return;

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
		if (appUnit === undefined) return;
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
		if (appUnit === undefined) return;
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
			{ kind: "relabelSourceLanguage", language: { language: "fra" } },
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

	it("keeps registry rejection through the MCP app_id extension", () => {
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

	it("keeps tool schemas closed and registers the exact SA/MCP family", () => {
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
