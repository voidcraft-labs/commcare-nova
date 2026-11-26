import { z } from "zod";
import { isValidDomainSlug } from "@/lib/commcare/hq/http";
import { COMMCARE_SERVER_IDS } from "@/lib/commcare/servers";
import { uuidSchema } from "@/lib/domain/uuid";
import { deploymentAppIdSchema } from "./types";

export const projectSearchDestinationInput = z.strictObject({
	appId: deploymentAppIdSchema,
	server: z.enum(COMMCARE_SERVER_IDS),
	domain: z
		.string()
		.refine(isValidDomainSlug, "Choose a valid project space name."),
});
export const projectSearchDestinationEdit = z.strictObject({
	version: z.string().regex(/^[a-f0-9]{64}$/),
	bindings: z.array(
		z.strictObject({
			searchUuid: uuidSchema,
			endpointId: z.number().int().min(1).max(2147483647).nullable(),
		}),
	),
});
export type ProjectSearchDestinationEdit = z.infer<
	typeof projectSearchDestinationEdit
>;
