/**
 * `nova.list_hq_apps`: the apps of one CommCare HQ project space that can be
 * brought in to Nova, each with whether a Nova app already manages it.
 *
 * The bring-in picker's own list (`listHqAppsForPicker`), read with the
 * caller's stored key. It writes nothing in Nova or in CommCare HQ. A list
 * that could not be read is a tool error carrying the circumstance's code,
 * title and next step; the two stops a client acts on the same way (a key
 * that does not list the project space, and an account CommCare HQ turned
 * away) share `domain_not_authorized`, each with its own message.
 *
 * Scope: `nova.hq.import`, checked by its registration before anything runs:
 * its answer is a project space's apps and who in Nova manages each. Kept off the Solutions
 * Architect, as every tool about CommCare HQ's apps is.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { COMMCARE_SERVERS, type CommCareServer } from "@/lib/commcare/servers";
import { getCommCareSettings } from "@/lib/db/settings";
import { listHqAppsForPicker } from "@/lib/deployment/reading";
import { LIST_HQ_APPS_NOT_CONFIGURED } from "@/lib/publish/bringInCopy";
import { alreadyInNovaNext } from "@/lib/publish/hqFindingCopy";
import type {
	CircumstanceFinding,
	HqAppClaimDetail,
} from "@/lib/publish/hqFindings";
import {
	BringInToolError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { registerScopedTool } from "../scopedTool";
import type { ToolContext } from "../types";
import {
	circumstanceContextFor,
	stopProjection,
	utcDay,
} from "./readingProjection";

/** Who manages one HQ app in Nova, as a client reads it; null where it is free. */
type InNova =
	| null
	| { kind: "open"; app_id: string; app_name: string }
	| {
			kind: "elsewhere";
			at: string;
			contact: { role: "person" | "owners"; names: readonly string[] };
			next: string;
	  };

interface ListHqAppsBody {
	server: CommCareServer;
	server_url: string;
	domain: string;
	apps: { hq_app_id: string; name: string; in_nova: InNova }[];
}

function inNova(claim: HqAppClaimDetail | null): InNova {
	if (claim === null) return null;
	if (claim.kind === "open")
		return { kind: "open", app_id: claim.appId, app_name: claim.appName };
	return {
		kind: "elsewhere",
		at: new Date(claim.at).toISOString(),
		contact: { role: claim.contact.role, names: claim.contact.names },
		next: alreadyInNovaNext(claim, utcDay),
	};
}

/** The tool error for a stop of the list, by the tags a client acts on. */
async function stopError(
	finding: CircumstanceFinding,
	userId: string,
	domain: string,
): Promise<BringInToolError> {
	/* Every stop the list meets came after the stored connection was read, so
	 * a connection that is gone now was removed in between, and says so. */
	const settings = await getCommCareSettings(userId);
	if (!settings.configured)
		return new BringInToolError(
			"hq_not_configured",
			LIST_HQ_APPS_NOT_CONFIGURED,
		);
	const block = stopProjection(
		finding,
		circumstanceContextFor({ server: settings.server, domain }, null),
	);
	const fields = {
		circumstance: finding.code,
		title: block.title,
		next: block.next,
	};
	switch (finding.code) {
		case "key-cannot-reach-space": {
			const reachable = settings.availableDomains
				.map((space) => space.name)
				.join(", ");
			return new BringInToolError(
				"domain_not_authorized",
				`Your stored CommCare HQ API key can't reach the “${domain}” project space. It reaches: ${reachable}. Pass one of those as \`domain\`, or update your key in Settings.`,
				fields,
			);
		}
		case "not-a-member":
			return new BringInToolError("domain_not_authorized", block.body, fields);
		default:
			return new BringInToolError("hq_read_stopped", block.body, fields);
	}
}

export function registerListHqApps(server: McpServer, ctx: ToolContext): void {
	registerScopedTool(
		server,
		ctx,
		"list_hq_apps",
		{
			description:
				"List the apps in one CommCare HQ project space that can be brought in to Nova. Call `get_hq_connection` first and pass the exact `domain` the user chose; never choose a project space for them. Each app has its `hq_app_id` and `name`. `in_nova` is null where the app is free to bring in. Otherwise it says a Nova app already manages it, since one CommCare HQ app is managed by one Nova app: `open` with the Nova `app_id` where the user can open it, or `elsewhere` with `next`, a sentence that says who to ask and the two ways forward. Relay `next` as written. Reads CommCare HQ with the user's own key and changes nothing.",
			inputSchema: z.strictObject({
				domain: z
					.string()
					.trim()
					.min(1)
					.describe(
						"Exact CommCare HQ project space the user chose. One of get_hq_connection's available_domains.",
					),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				const picker = await listHqAppsForPicker(
					{ userId: ctx.userId },
					{ domain: args.domain },
				);
				switch (picker.kind) {
					case "not-connected":
						throw new BringInToolError(
							"hq_not_configured",
							LIST_HQ_APPS_NOT_CONFIGURED,
						);
					case "stop":
						throw await stopError(picker.finding, ctx.userId, args.domain);
					case "apps": {
						const body: ListHqAppsBody = {
							server: picker.server,
							server_url: COMMCARE_SERVERS[picker.server].baseUrl,
							domain: picker.domain,
							apps: picker.apps.map((app) => ({
								hq_app_id: app.remoteAppId,
								name: app.name,
								in_nova: inNova(app.claim),
							})),
						};
						return {
							content: [{ type: "text", text: JSON.stringify(body) }],
						};
					}
				}
			} catch (err) {
				return toMcpErrorResult(err, {
					userId: ctx.userId,
					toolName: "list_hq_apps",
				});
			}
		},
	);
}
