/** Schema-derived inventory of canonical identity slots in shared tools. */
import { z } from "zod";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import {
	type AuthorableIdentityPointer,
	collectIdentitySchemaPointers,
} from "./identitySchema";

export {
	type AuthorableIdentityFamily,
	type AuthorableIdentityPointer,
	collectIdentitySchemaPointers,
} from "./identitySchema";

type JsonNode = Record<string, unknown>;

export function buildAuthorableIdentityPointerRegistry(): AuthorableIdentityPointer[] {
	return SHARED_TOOL_REGISTRY.flatMap(({ mcpName, tool }) =>
		collectIdentitySchemaPointers(
			mcpName,
			z.toJSONSchema(tool.inputSchema, {
				target: "draft-7",
				io: "input",
			}) as JsonNode,
		),
	);
}

export const AUTHORABLE_IDENTITY_POINTER_REGISTRY =
	buildAuthorableIdentityPointerRegistry();
