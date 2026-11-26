/**
 * The one way a tool that needs a scope beyond the floor registers.
 *
 * `registerScopedTool` reads the tool's scopes from `scopes.ts::TOOL_SCOPES`
 * by its name, declares the SDK scope challenge for all of them (so an OAuth
 * client is asked for the missing grant before anything runs), and checks
 * each before the handler runs, answering the first one missing as
 * `scope_missing`. For each scope required on every call a tool's
 * challenge and its check can't name different scopes, and nothing a
 * handler reads or answers (an error included) is reached without them.
 */

import type {
	McpServer,
	RegisteredTool,
	StandardSchemaWithJSON,
	ToolAnnotations,
	ToolCallback,
} from "@modelcontextprotocol/server";
import { toMcpErrorResult } from "./errors";
import {
	isScopedToolName,
	McpScopeError,
	oauthScopeChallenge,
	requiredToolScopes,
	type ScopedToolName,
} from "./scopes";
import type { ToolContext } from "./types";

/**
 * The app and the Project a call names, as every tool's refusal echoes them:
 * a credential without the scope is told which target it was refused for and
 * learns nothing more, since no read has run.
 */
function namedTarget(args: unknown): {
	readonly appId?: string;
	readonly projectId?: string;
} {
	if (typeof args !== "object" || args === null) return {};
	const { app_id: appId, project_id: projectId } = args as Record<
		string,
		unknown
	>;
	return {
		...(typeof appId === "string" && { appId }),
		...(typeof projectId === "string" && { projectId }),
	};
}

export interface ScopedToolConfig<
	InputArgs extends StandardSchemaWithJSON | undefined,
> {
	readonly title?: string;
	readonly description: string;
	readonly inputSchema?: InputArgs;
	readonly annotations?: ToolAnnotations;
	readonly _meta?: Record<string, unknown>;
}

export function registerScopedTool<
	InputArgs extends StandardSchemaWithJSON | undefined = undefined,
>(
	server: McpServer,
	ctx: ToolContext,
	name: ScopedToolName,
	config: ScopedToolConfig<InputArgs>,
	handler: ToolCallback<InputArgs>,
): RegisteredTool {
	const gated = (...call: unknown[]) => {
		const required = requiredToolScopes(name, call[0]);
		const missing = required.find((scope) => !ctx.scopes.includes(scope));
		if (missing !== undefined)
			return toMcpErrorResult(new McpScopeError(missing, name, ctx.authKind), {
				userId: ctx.userId,
				toolName: name,
				...namedTarget(config.inputSchema === undefined ? undefined : call[0]),
			});
		return (handler as (...call: unknown[]) => ReturnType<typeof handler>)(
			...call,
		);
	};
	return server.registerTool<StandardSchemaWithJSON, InputArgs>(
		name,
		{
			...config,
			scopeChallenge:
				ctx.authKind === "oauth"
					? (input) => {
							const scopes = requiredToolScopes(
								name,
								input.request.params?.arguments,
							);
							return oauthScopeChallenge(ctx, scopes)?.(input);
						}
					: undefined,
		},
		gated as ToolCallback<InputArgs>,
	);
}

/** Both the canonical and saved-work paths of a shared tool pass through the
 * registered consent gate before they load an app, a work, or a receipt. */
export function registerSharedToolWithScopes<
	InputArgs extends StandardSchemaWithJSON,
>(
	server: McpServer,
	ctx: ToolContext,
	name: string,
	config: ScopedToolConfig<InputArgs>,
	handler: ToolCallback<InputArgs>,
): RegisteredTool {
	if (isScopedToolName(name))
		return registerScopedTool(server, ctx, name, config, handler);
	return server.registerTool<StandardSchemaWithJSON, InputArgs>(
		name,
		config,
		handler,
	);
}
