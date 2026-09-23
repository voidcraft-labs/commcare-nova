import { z } from "zod";
import type { PersistableDoc, Uuid } from "@/lib/domain";
import { uuidSchema } from "@/lib/domain";
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

export const appTestStartSchema = z.strictObject({
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

export const appTestActionSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("observe") }),
	z.strictObject({ kind: z.literal("continue") }),
	z.strictObject({ kind: z.literal("back") }),
	z.strictObject({
		kind: z.literal("identity"),
		personaUuid: uuidSchema
			.nullable()
			.describe(
				"A saved Preview identity, or null for yourself. Returns to app entry.",
			),
	}),
	z.strictObject({ kind: z.literal("menu"), moduleUuid: uuidSchema }),
	z.strictObject({ kind: z.literal("records") }),
	z.strictObject({
		kind: z.literal("page"),
		offset: z.number().int().min(0).max(2000),
	}),
	z.strictObject({ kind: z.literal("form"), formUuid: uuidSchema }),
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
export type AppTestAction = z.infer<typeof appTestActionSchema>;

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
	| { kind: "menu"; moduleUuid: Uuid }
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
export interface AppTestState {
	personaUuid: Uuid | null;
	screen: AppTestScreen;
	history: readonly AppTestScreen[];
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>;
	/** The worker's device holds this snapshot until sync or identity switch;
	 * submissions overlay their transaction-captured patch, including closed rows. */
	deviceCases: CaseDatabaseSnapshot;
}
