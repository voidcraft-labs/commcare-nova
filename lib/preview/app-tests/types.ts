import { z } from "zod";
import type { PersistableDoc, Uuid } from "@/lib/domain";
import { uuidSchema } from "@/lib/domain";
import {
	appLanguageIdentitySchema,
	type LanguageTag,
} from "@/lib/domain/localization";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import type {
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import type { StoredLocation } from "@/lib/organization/types";
import { evaluationScenarioSchema } from "@/lib/preview/engine/evaluationScenario";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
import { formAnswerValueSchema } from "../engine/formAnswerValue";
import type { FormEvaluationEntry } from "../engine/formEvaluationTypes";
import type { PreviewSessionUser } from "../engine/identity";
import type { SearchEvaluationInput } from "../engine/searchEvaluation";
import type { CaseDatabaseSnapshot } from "../engine/xpathInstances";

const answer = z.strictObject({
	path: z.string().min(1).max(1024),
	value: formAnswerValueSchema,
});
const testOwner = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("me") }),
	z.strictObject({ kind: z.literal("persona"), personaUuid: uuidSchema }),
	z.strictObject({ kind: z.literal("place"), locationUuid: uuidSchema }),
]);
export const appTestSessionIdSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/)
	.describe(
		"A test-local session label, one to forty letters, digits, underscores or hyphens, starting with a letter or digit. This is not an app entity address.",
	);

export const appTestStartSchema = z.strictObject({
	sessions: z
		.array(
			z.strictObject({
				id: appTestSessionIdSchema,
				personaUuid: z
					.string()
					.min(1)
					.max(1024)
					.nullable()
					.optional()
					.describe(
						"A saved Preview identity's name or stable ID; null or omitted means yourself.",
					),
				language: appLanguageIdentitySchema.optional(),
			}),
		)
		.min(1)
		.max(4)
		.optional()
		.describe(
			"Up to four retained worker sessions sharing this test's isolated records. IDs must be unique. The first is primary; omitting sessions creates one default session. Each retains its own identity, language, navigation, answers and open-form record snapshot.",
		),
	language: appLanguageIdentitySchema
		.optional()
		.describe(
			"A language configured in the saved app. Omit to use its default worker language.",
		),
	purpose: z
		.string()
		.min(1)
		.max(1000)
		.describe("The worker journey and expected result to investigate."),
	scenario: evaluationScenarioSchema
		.optional()
		.describe(
			"Optional starting records in isolated test storage. Omit to exercise creation from no business records. Supplied records are test prerequisites, not evidence that the app creates or provides them. IDs are test labels; parentId refers to another supplied record. Live case rows are never copied.",
		),
	owners: z
		.array(
			z.strictObject({
				recordId: z.string().min(1).max(200),
				owner: testOwner,
			}),
		)
		.max(200)
		.optional()
		.describe(
			"Owners of supplied records. Omitted records belong to you; role and place visibility still apply.",
		),
	places: z
		.array(
			z.strictObject({
				uuid: uuidSchema,
				name: z.string().min(1).max(255),
				levelUuid: uuidSchema,
				parentUuid: uuidSchema.optional(),
				values: z.record(uuidSchema, z.string().max(1000)).optional(),
			}),
		)
		.max(100)
		.optional()
		.describe(
			"Fictional places for this test only. Use the app's existing organization levels. They are never deployment data.",
		),
	assignments: z
		.array(
			z.strictObject({
				personaUuid: uuidSchema,
				locationUuids: z
					.array(uuidSchema)
					.max(100)
					.describe(
						"Assigned places, primary first. An empty list clears this test assignment.",
					),
			}),
		)
		.max(100)
		.optional()
		.describe(
			"Place assignments for this test only, for Preview identities already saved in the app.",
		),
});
export type AppTestStartInput = z.infer<typeof appTestStartSchema>;

function actionSchema<R extends z.ZodType<string>>(reference: R) {
	return z.discriminatedUnion("kind", [
		z.strictObject({
			kind: z.literal("language"),
			language: appLanguageIdentitySchema,
		}),
		z.strictObject({
			kind: z.literal("section"),
			sectionUuid: reference.describe(
				"A section offered by the current form. Forward navigation validates earlier pages.",
			),
		}),
		z.strictObject({ kind: z.literal("observe") }),
		z.strictObject({ kind: z.literal("continue") }),
		z.strictObject({ kind: z.literal("back") }),
		z.strictObject({ kind: z.literal("routeContinue") }),
		z.strictObject({ kind: z.literal("routeBack") }),
		z.strictObject({ kind: z.literal("pageNext") }),
		z.strictObject({ kind: z.literal("pagePrevious") }),
		z.strictObject({
			kind: z.literal("identity"),
			personaUuid: reference
				.nullable()
				.describe(
					"A saved Preview identity, or null for yourself. Returns to app entry.",
				),
		}),
		z.strictObject({ kind: z.literal("menu"), moduleUuid: reference }),
		z.strictObject({ kind: z.literal("records") }),
		z.strictObject({
			kind: z.literal("page"),
			offset: z.number().int().min(0).max(2000),
		}),
		z.strictObject({ kind: z.literal("form"), formUuid: reference }),
		z.strictObject({
			kind: z.literal("select"),
			caseIds: z.array(z.string().min(1).max(255)).min(1).max(100),
		}),
		z.strictObject({
			kind: z.literal("search"),
			answers: z
				.array(
					z.strictObject({
						name: z.string().min(1).max(200),
						value: z.string().max(1000),
					}),
				)
				.max(100),
		}),
		z.strictObject({
			kind: z.literal("answer"),
			answers: z.array(answer).max(200),
			repeats: z
				.array(
					z.strictObject({
						path: z.string().min(1).max(1024),
						count: z.number().int().min(1).max(100),
					}),
				)
				.max(50)
				.optional(),
		}),
		z.strictObject({ kind: z.literal("submit") }),
		z.strictObject({ kind: z.literal("home") }),
		z.strictObject({ kind: z.literal("sync") }),
		z.strictObject({ kind: z.literal("finish") }),
	]);
}
export const appTestActionSchema = actionSchema(uuidSchema);
export const appTestAuthoredActionSchema = actionSchema(
	z
		.string()
		.min(1)
		.max(1024)
		.describe(
			"Saved entity name or stable ID; sections also accept their full field path in the current form.",
		),
);
export type AppTestAuthoredAction = z.infer<typeof appTestAuthoredActionSchema>;
export type AppTestAction = z.infer<typeof appTestActionSchema>;

export const appTestExpectationSchema = z.strictObject({
	screen: z
		.enum([
			"home",
			"menu",
			"browse",
			"search",
			"results",
			"details",
			"form",
			"after-submit",
		])
		.optional(),
	moduleUuid: z
		.string()
		.min(1)
		.max(1024)
		.optional()
		.describe("Expected menu name or stable ID."),
	formUuid: z
		.string()
		.min(1)
		.max(1024)
		.optional()
		.describe("Expected form name or stable ID."),
	submitted: z
		.boolean()
		.optional()
		.describe(
			"Whether this action committed a form submission to test records.",
		),
});
export const appTestActionItemSchema = z.strictObject({
	sessionId: appTestSessionIdSchema
		.optional()
		.describe(
			"Session to advance. Omit to use the primary session. Other sessions keep their open forms and answers.",
		),
	action: appTestAuthoredActionSchema,
	expect: appTestExpectationSchema.optional(),
});
export const appTestActionsSchema = z
	.array(appTestActionItemSchema)
	.min(1)
	.max(8)
	.describe(
		"Ordered worker actions. Stops at the first refusal, failed forward validation, unavailable destination or unmet expectation. Each item consumes one of the journey's 200 steps.",
	);
export type AppTestExpectation = z.infer<typeof appTestExpectationSchema>;

export interface AppTestSnapshot {
	purpose: string;
	blueprint: PersistableDoc;
	user: PreviewSessionUser;
	projectSpace: string | null;
	lookup: {
		projectRevision: string;
		definitions: readonly LookupTableDefinition[];
		rows: readonly (readonly [LookupTableId, readonly LookupFixtureRow[]])[];
	};
	organizationRevision: string;
	locations: readonly StoredLocation[];
	testPlaceIds: readonly string[];
	testAssignmentPersonaIds: readonly string[];
}
export type AppTestScreen =
	| { kind: "home" }
	| { kind: "after-submit"; moduleUuid: Uuid; message: string }
	| {
			kind: "menu";
			moduleUuid: Uuid;
			/** A leaf record's inline form chooser, not a persistent menu datum. */
			selection?: PreviewMenuCaseSelection;
	  }
	| {
			kind: "details";
			moduleUuid: Uuid;
			caseId: string;
			source: Extract<AppTestScreen, { kind: "records" }>;
	  }
	| {
			kind: "records";
			moduleUuid: Uuid;
			formUuid?: Uuid;
			returnModules?: readonly Uuid[];
			searchEntry?: SearchEvaluationInput["entry"];
			registeredCaseId?: string;
			searchAnswers?: readonly { name: string; value: string }[];
			offset?: number;
	  }
	| {
			kind: "form";
			moduleUuid: Uuid;
			formUuid: Uuid;
			caseIds: readonly string[];
			entry?: FormEvaluationEntry;
			entryCases: CaseDatabaseSnapshot;
			searchAnswers?: readonly { name: string; value: string }[];
	  };
export interface AppTestSessionState {
	language: LanguageTag;
	personaUuid: Uuid | null;
	screen: AppTestScreen;
	history: readonly AppTestScreen[];
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>;
	/** The worker's device holds this snapshot until sync or identity switch;
	 * submissions overlay their transaction-captured patch, including closed rows. */
	deviceCases: CaseDatabaseSnapshot;
}

/** One bounded journey and record namespace, with independent retained workers. */
export interface AppTestState {
	primarySessionId: string;
	/** JSONB object-key order is not the authored session order. */
	sessionOrder: readonly string[];
	sessions: Readonly<Record<string, AppTestSessionState>>;
}
