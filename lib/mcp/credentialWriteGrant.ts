import "server-only";
import type { Transaction } from "kysely";
import { lockCurrentProjectGrant } from "@/lib/auth/dataGrant";
import { NOVA_MCP_FLOOR_SCOPES } from "@/lib/auth-public";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import { assertScope, McpCredentialInactiveError, type Scope } from "./scopes";
import { requiredToolScopes, type ScopedToolName } from "./scopes";
import type { ToolContext } from "./types";

/** Check the request before remote work and its durable credential again in
 * the transaction that authorizes the write. The operation receives no bearer. */
export function credentialWriteGrant(
	ctx: ToolContext,
	toolName: string,
	required: readonly Scope[],
) {
	const scopes = [...required, ...NOVA_MCP_FLOOR_SCOPES];
	const check = async (tx: Transaction<AppDatabase>) => {
		for (const scope of scopes) assertScope(ctx, scope, toolName);
		if (
			!ctx.grant ||
			ctx.grant.kind !== ctx.authKind ||
			!(await lockCurrentProjectGrant(tx, ctx.userId, ctx.grant, scopes))
		)
			throw new McpCredentialInactiveError(ctx.authKind);
	};
	return (tx?: Transaction<AppDatabase>) => (tx ? check(tx) : withAppTx(check));
}

/** The same scopes the request preflight required, checked when the write lands. */
export function toolWriteGrant(ctx: ToolContext, name: ScopedToolName, args?: unknown) {
	return credentialWriteGrant(ctx, name, requiredToolScopes(name, args));
}
