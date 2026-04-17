// lib/domain/modules.ts
import { z } from "zod";
import { type Uuid, uuidSchema } from "./uuid";

// CaseType currently lives in lib/schemas/blueprint.ts; re-export its shape
// here so consumers can stop importing from schemas/. The schemas/blueprint.ts
// file is deleted later in this phase (Task 22).

const caseListColumnSchema = z.object({
	field: z.string(),
	header: z.string(),
});
export type CaseListColumn = z.infer<typeof caseListColumnSchema>;

export const moduleSchema = z.object({
	uuid: uuidSchema,
	id: z.string(), // semantic id (snake_case display slug)
	name: z.string(),
	caseType: z.string().optional(),
	caseListOnly: z.boolean().optional(),
	purpose: z.string().optional(),
	caseListColumns: z.array(caseListColumnSchema).optional(),
	caseDetailColumns: z.array(caseListColumnSchema).nullable().optional(),
});
export type Module = z.infer<typeof moduleSchema>;

export type ModuleKindMetadata = {
	icon: string;
	saDocs: string;
};
export const moduleMetadata: ModuleKindMetadata = {
	icon: "tabler:stack",
	saDocs:
		"A module is a top-level menu in the CommCare app. It groups related forms under one case type.",
};
