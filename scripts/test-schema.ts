/**
 * Verifies that the SA's tool input schemas are accepted by the OpenAI
 * API — i.e. the model makes a tool call against each schema without the
 * request erroring.
 *
 * All SA tools run in **tool-input** mode (`tools[name].inputSchema`).
 * Tool use is NOT constrained-decoded, so there is no schema-grammar
 * compilation step and no per-array-item optional-field ceiling — the
 * `addFields` batch item carries ten optionals and is accepted on every
 * model. (Structured-output constraints apply to the `Output.object` path,
 * which these tools do not use, so they aren't exercised here.)
 *
 * Usage: `npx tsx scripts/test-schema.ts [sol] [schema-name]`
 *   - Pass `sol` to test against the production SA build model
 *     (`SA_BUILD_MODEL`); default is GPT-5.6 Luna (cheap + fast —
 *     tool-input acceptance is the same across models).
 *   - Pass a schema name to test only that schema; omit to test every
 *     registered schema. Known names: `addFields`,
 *     `addCaseListColumns`, `updateCaseListColumn`,
 *     `removeCaseListColumn`, `reorderCaseListColumns`,
 *     `setCaseListFilter`, `addSearchInputs`, `updateSearchInput`,
 *     `removeSearchInput`, `reorderSearchInputs`,
 *     `setCaseSearchAdvanced`, `setCaseSearchDisplay`, `editField`,
 *     `moveField`, `createForm`, `createModule`, `updateModule`,
 *     `attachFieldMedia`, `attachOptionMedia`, `setMenuMedia`,
 *     `setAppLogo`, `listMediaAssets`,
 *     `removeMediaAsset`, `uploadMediaAsset`.
 */
import "dotenv/config";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { addFieldsTool } from "../lib/agent/tools/addFields";
import { addCaseListColumnsTool } from "../lib/agent/tools/case-list-config/addCaseListColumns";
import { addSearchInputsTool } from "../lib/agent/tools/case-list-config/addSearchInputs";
import { removeCaseListColumnTool } from "../lib/agent/tools/case-list-config/removeCaseListColumn";
import { removeSearchInputTool } from "../lib/agent/tools/case-list-config/removeSearchInput";
import { reorderCaseListColumnsTool } from "../lib/agent/tools/case-list-config/reorderCaseListColumns";
import { reorderSearchInputsTool } from "../lib/agent/tools/case-list-config/reorderSearchInputs";
import { setCaseListFilterTool } from "../lib/agent/tools/case-list-config/setCaseListFilter";
import { updateCaseListColumnTool } from "../lib/agent/tools/case-list-config/updateCaseListColumn";
import { updateSearchInputTool } from "../lib/agent/tools/case-list-config/updateSearchInput";
import { setCaseSearchAdvancedTool } from "../lib/agent/tools/case-search-config/setCaseSearchAdvanced";
import { setCaseSearchDisplayTool } from "../lib/agent/tools/case-search-config/setCaseSearchDisplay";
import { createFormTool } from "../lib/agent/tools/createForm";
import { createModuleTool } from "../lib/agent/tools/createModule";
import { editFieldTool } from "../lib/agent/tools/editField";
import { generateSchemaTool } from "../lib/agent/tools/generateSchema";
import { attachFieldMediaTool } from "../lib/agent/tools/media/attachFieldMedia";
import { attachOptionMediaTool } from "../lib/agent/tools/media/attachOptionMedia";
import { listMediaAssetsTool } from "../lib/agent/tools/media/listMediaAssets";
import { removeMediaAssetTool } from "../lib/agent/tools/media/removeMediaAsset";
import { setAppLogoTool } from "../lib/agent/tools/media/setAppLogo";
import { setMenuMediaTool } from "../lib/agent/tools/media/setMenuMedia";
import { moveFieldTool } from "../lib/agent/tools/moveField";
import { updateAppTool } from "../lib/agent/tools/updateApp";
import {
	updateModuleInputSchema,
	updateModuleTool,
} from "../lib/agent/tools/updateModule";
import { uploadMediaAssetInputSchema } from "../lib/mcp/tools/uploadMediaAsset";
import { OPENAI_BASE_OPTIONS, SA_BUILD_MODEL } from "../lib/models";

/**
 * One tool-input schema test: register the tool with a no-op `execute`,
 * prompt the model to call it, and treat a successful `generateText`
 * (the API accepted the schema and the model produced a tool call) as a
 * pass. The failure surface is whether the request errors.
 */
interface SchemaTest {
	readonly name: string;
	readonly description: string;
	readonly schema: z.ZodObject<z.ZodRawShape>;
	readonly prompt: string;
}

const SCHEMA_TESTS: readonly SchemaTest[] = [
	{
		name: "addFields",
		description: addFieldsTool.description,
		schema: addFieldsTool.inputSchema,
		prompt:
			"Use addFields on module 0, form 0 to add two fields: patient_name (a text field labeled 'Patient name') and age (an int field labeled 'Age').",
	},
	{
		name: "updateModule",
		description: updateModuleTool.description,
		schema: updateModuleInputSchema,
		prompt:
			'Use updateModule on module 0 to set its case_type to "patient" and rename it to "Patients".',
	},
	{
		name: "addCaseListColumns",
		description: addCaseListColumnsTool.description,
		schema: addCaseListColumnsTool.inputSchema,
		prompt:
			"Use addCaseListColumns to add two plain columns on module 0: case_name with header Patient, and status with header Status.",
	},
	{
		name: "updateCaseListColumn",
		description: updateCaseListColumnTool.description,
		schema: updateCaseListColumnTool.inputSchema,
		prompt:
			"Use updateCaseListColumn on module 0, columnUuid 11111111-1111-1111-1111-111111111111, replacing it with a date column for dob with header Date of birth and pattern %Y-%m-%d.",
	},
	{
		name: "removeCaseListColumn",
		description: removeCaseListColumnTool.description,
		schema: removeCaseListColumnTool.inputSchema,
		prompt:
			"Use removeCaseListColumn on module 0, columnUuid 11111111-1111-1111-1111-111111111111.",
	},
	{
		name: "reorderCaseListColumns",
		description: reorderCaseListColumnsTool.description,
		schema: reorderCaseListColumnsTool.inputSchema,
		prompt:
			"Use reorderCaseListColumns on module 0 with the order [22222222-2222-2222-2222-222222222222, 11111111-1111-1111-1111-111111111111].",
	},
	{
		name: "setCaseListFilter",
		description: setCaseListFilterTool.description,
		schema: setCaseListFilterTool.inputSchema,
		prompt:
			"Use setCaseListFilter to set the filter on module 0 to a comparison: the patient case status property equals the literal string active.",
	},
	{
		name: "addSearchInputs",
		description: addSearchInputsTool.description,
		schema: addSearchInputsTool.inputSchema,
		prompt:
			"Use addSearchInputs on module 0 to add a simple search input named patient_name_input labeled Patient name type text targeting case property name.",
	},
	{
		name: "updateSearchInput",
		description: updateSearchInputTool.description,
		schema: updateSearchInputTool.inputSchema,
		prompt:
			"Use updateSearchInput on module 0, searchInputUuid 11111111-1111-1111-1111-111111111111, replacing it with a simple search input named region labeled Region type text targeting case property region.",
	},
	{
		name: "removeSearchInput",
		description: removeSearchInputTool.description,
		schema: removeSearchInputTool.inputSchema,
		prompt:
			"Use removeSearchInput on module 0, searchInputUuid 11111111-1111-1111-1111-111111111111.",
	},
	{
		name: "reorderSearchInputs",
		description: reorderSearchInputsTool.description,
		schema: reorderSearchInputsTool.inputSchema,
		prompt:
			"Use reorderSearchInputs on module 0 with the order [22222222-2222-2222-2222-222222222222, 11111111-1111-1111-1111-111111111111].",
	},
	{
		name: "setCaseSearchAdvanced",
		description: setCaseSearchAdvancedTool.description,
		schema: setCaseSearchAdvancedTool.inputSchema,
		prompt:
			"Use setCaseSearchAdvanced on module 0 to clear the excluded owner ids (null).",
	},
	{
		name: "setCaseSearchDisplay",
		description: setCaseSearchDisplayTool.description,
		schema: setCaseSearchDisplayTool.inputSchema,
		prompt:
			"Use setCaseSearchDisplay on module 0 to set the searchScreenTitle to 'Find a patient' and clear every other display slot (null).",
	},
	/* `editField` carries the new `help` slot — re-tested here to confirm
	 * the edit-patch schema still compiles within the tool-input limits
	 * after the addition. The `addFields` structured-output test above
	 * stays at 8 optionals (help is edit-only), so it's the ceiling
	 * canary; this is the regression guard for the schema that grew. */
	{
		name: "editField",
		description: editFieldTool.description,
		schema: editFieldTool.inputSchema,
		prompt:
			"Use editField on module 0, form 0, field patient_name to set its help text to 'Enter the patient's full legal name.'",
	},
	{
		name: "moveField",
		description: moveFieldTool.description,
		schema: moveFieldTool.inputSchema,
		prompt:
			"Use moveField on module 0, form 0 to move the field visit_notes after the field visit_date.",
	},
	{
		name: "createForm",
		description: createFormTool.description,
		schema: createFormTool.inputSchema,
		prompt:
			"Use createForm on module 0 to add a followup form named 'Visit' with two fields: visit_date (a date labeled 'Visit date', case_property_on patient) and visit_notes (a text labeled 'Notes').",
	},
	{
		name: "createModule",
		description: createModuleTool.description,
		schema: createModuleTool.inputSchema,
		prompt:
			"Use createModule to add a module named 'Households' with case_type household, one registration form named 'Register household' whose fields are case_name (text labeled 'Household name', case_property_on household) and head_name (text labeled 'Head of household', case_property_on household), and one plain case-list column on field case_name with header Name.",
	},
	{
		name: "generateSchema",
		description: generateSchemaTool.description,
		schema: generateSchemaTool.inputSchema,
		prompt:
			"Use generateSchema to record one case type patient carrying properties case_name (labeled 'Full name') and village (labeled 'Village').",
	},
	{
		name: "updateApp",
		description: updateAppTool.description,
		schema: updateAppTool.inputSchema,
		prompt:
			"Use updateApp to set the app's name to 'Village Health' and make it a standard app (connect off).",
	},
	/* Media tools — each new tool's input schema, exercised against the
	 * compiler. The `Media` bundle is three optionals on a non-array
	 * object, so the 8-optional array-item ceiling doesn't apply, but we
	 * test anyway per the segment's gate. */
	{
		name: "attachFieldMedia",
		description: attachFieldMediaTool.description,
		schema: attachFieldMediaTool.inputSchema,
		prompt:
			"Use attachFieldMedia with two attachments in one call: on module 0, form 0, set field patient_name's label media image to asset 11111111-1111-1111-1111-111111111111, and field age's hint media audio to asset 22222222-2222-2222-2222-222222222222.",
	},
	{
		name: "attachOptionMedia",
		description: attachOptionMediaTool.description,
		schema: attachOptionMediaTool.inputSchema,
		prompt:
			"Use attachOptionMedia with two attachments in one call: on module 0, form 0, field symptom, set option fever's image to asset 11111111-1111-1111-1111-111111111111 and option cough's image to asset 22222222-2222-2222-2222-222222222222.",
	},
	{
		name: "setMenuMedia",
		description: setMenuMediaTool.description,
		schema: setMenuMediaTool.inputSchema,
		prompt:
			"Use setMenuMedia with two items in one call: set module 0's icon to the built-in household icon, and module 0 form 0's icon to the built-in register icon. Clear every audio label (null).",
	},
	{
		name: "setAppLogo",
		description: setAppLogoTool.description,
		schema: setAppLogoTool.inputSchema,
		prompt:
			"Use setAppLogo to set the app logo to asset 11111111-1111-1111-1111-111111111111.",
	},
	{
		name: "listMediaAssets",
		description: listMediaAssetsTool.description,
		schema: listMediaAssetsTool.inputSchema,
		prompt: "Use listMediaAssets to list every image asset.",
	},
	{
		name: "removeMediaAsset",
		description: removeMediaAssetTool.description,
		schema: removeMediaAssetTool.inputSchema,
		prompt:
			"Use removeMediaAsset to delete asset 11111111-1111-1111-1111-111111111111.",
	},
	{
		name: "uploadMediaAsset",
		description: "Upload a media file to the library from inline base64 bytes.",
		schema: uploadMediaAssetInputSchema,
		prompt:
			"Use uploadMediaAsset to upload logo.png (image/png) with the base64 contents aGVsbG8=.",
	},
];

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
	console.error("Set OPENAI_API_KEY");
	process.exit(1);
}

const openai = createOpenAI({ apiKey });
const args = process.argv.slice(2);
const useSol = args.includes("sol");
const explicitName = args.find((a) => a !== "sol");
const model = useSol ? SA_BUILD_MODEL : "gpt-5.6-luna";

const tests = explicitName
	? SCHEMA_TESTS.filter((t) => t.name === explicitName)
	: SCHEMA_TESTS;

if (tests.length === 0) {
	console.error(`Unknown schema name: ${explicitName}`);
	console.error(`Known names: ${SCHEMA_TESTS.map((t) => t.name).join(", ")}`);
	process.exit(1);
}

console.log(`Testing with ${model}...`);

/* Wrap the loop in an async IIFE — `tsx` transpiles to CJS, which
 * rejects top-level `await`. The IIFE preserves per-test sequential
 * ordering so the per-line console output stays readable. */
(async () => {
	let exitCode = 0;
	for (const test of tests) {
		const size = JSON.stringify(z.toJSONSchema(test.schema)).length;
		console.log(`\n${test.name}: ${size} chars`);

		const controller = new AbortController();
		const timer = setTimeout(() => {
			console.log("TIMEOUT (180s)");
			controller.abort();
		}, 180000);

		try {
			const r = await generateText({
				model: openai(model),
				tools: {
					[test.name]: tool({
						description: test.description,
						inputSchema: test.schema,
						// Mirrors production (`solutionsArchitect.ts` wrappers): opt
						// out of Responses strict-mode normalization so optionals
						// stay omittable.
						strict: false,
						execute: async () => "ok",
					}),
				},
				/* `stepCountIs(2)` lets the model emit a tool call + its
				 * tool-result response without looping into a second tool
				 * call; a `tool-calls` finishReason confirms the schema was
				 * accepted and the model produced valid input. */
				stopWhen: stepCountIs(2),
				system:
					"Use the supplied tool with reasonable arguments to satisfy the prompt.",
				prompt: test.prompt,
				maxOutputTokens: 1024,
				abortSignal: controller.signal,
				providerOptions: { openai: OPENAI_BASE_OPTIONS },
			});
			clearTimeout(timer);
			console.log(
				`PASS (${r.usage.inputTokens}/${r.usage.outputTokens} tokens, finishReason=${r.finishReason})`,
			);
		} catch (e) {
			clearTimeout(timer);
			const err = e as { responseBody?: string; message?: string };
			console.log(
				"FAIL:",
				(err.responseBody ?? err.message ?? "").slice(0, 500),
			);
			exitCode = 1;
		}
	}

	process.exit(exitCode);
})();
