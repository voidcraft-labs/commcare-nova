/**
 * `nova.refresh_managed_data` and `nova.set_lookup_table_management`: the
 * data CommCare HQ manages for a Project's apps, a lookup table Nova keeps a
 * copy of and an app's places, as the table page and the Organization banner
 * reach it (`lib/deployment/managedData.ts`).
 *
 * Every answer of a service is a result, not an error: its `message` is the
 * sentence the builder shows for that outcome (`lib/publish/managedData.ts`),
 * a refusal among them, which leaves the copy as it was. Only a Project or an
 * app the caller cannot reach is an error, collapsed to `not_found` as every
 * tool collapses it.
 *
 * Scopes, checked by each tool's registration before anything runs: a
 * refresh reads CommCare HQ with the caller's key and copies what it holds
 * into Nova (`nova.hq.import`); who manages a table decides what every later
 * publish to its project space writes, and handing it back copies CommCare
 * HQ's rows in, so `set_lookup_table_management` needs `nova.hq.write` and
 * `nova.hq.import`. The
 * Project resolves at `view`; the services decide the capability each act
 * needs, so the answer to a role that falls short names who can. Kept off
 * the Solutions Architect, as every deployment tool is.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { resolveAppScope } from "@/lib/db/appAccess";
import {
	inspectManagedLookupWorker,
	LOOKUP_TABLE_NOT_FOUND,
	letHqManageLookupTable,
	type ManagedTableOutcome,
	manageLookupTableInNova,
	readManagedLookupTableView,
	refreshManagedLookupTable,
	refreshManagedPlaces,
} from "@/lib/deployment/managedData";
import {
	attestSourceWorkbook,
	historicalSourceWorkbook,
	inspectInlineSourceRow,
	sourceWorkbookBytes,
} from "@/lib/deployment/managedLookupObservation";
import { LOOKUP_DISCARD_NOTE } from "@/lib/deployment/remoteChanges";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import type {
	LookupReferencingAppSummary,
	LookupScope,
} from "@/lib/lookup/types";
import { REFRESH_MANAGED_DATA_TARGET_MESSAGE } from "@/lib/publish/bringInCopy";
import {
	appsThatReadIt,
	columnsBecomeText,
	letHqManageBody,
	letHqManageTitle,
	MANAGEMENT_NEEDS_ADMIN,
	managedInNovaBanner,
	managedPlacesOutcomeLines,
	managedTableBanner,
	managedTableOutcomeLines,
	manageInNovaBody,
	manageInNovaTitle,
} from "@/lib/publish/managedData";
import {
	McpInvalidInputError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import {
	McpAccessError,
	requireProjectAccess,
	rethrowAsMcpAccess,
} from "../ownership";
import { registerScopedTool } from "../scopedTool";
import type { ToolContext } from "../types";

function jsonResult(payload: unknown): McpToolSuccessResult {
	return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

const projectIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(255)
	.describe(
		"The Project the lookup table or the app belongs to, from list_projects.",
	);

const tableIdSchema = z
	.string()
	.trim()
	.min(1)
	.describe(
		"The lookup table's id, as get_lookup_tables lists it with `managed_in_commcare_hq`.",
	);

/** The table's id where it is one; a malformed id names no table, as a missing one does. */
function parsedTableId(input: string): LookupTableId | null {
	const parsed = lookupTableIdSchema.safeParse(input);
	return parsed.success ? parsed.data : null;
}

/** The scope a table action runs under: the caller's role in the Project they named. */
async function lookupScope(
	ctx: ToolContext,
	projectId: string,
): Promise<LookupScope> {
	const access = await requireProjectAccess(ctx.userId, projectId, "view");
	return {
		projectId: access.projectId,
		actorId: ctx.userId,
		role: access.role,
	};
}

/** A table's answer as a refusal: the outcome's reason and its sentence. */
function refusedTable(
	projectId: string,
	tableId: string,
	reason: string,
	message: string,
) {
	return {
		project_id: projectId,
		table_id: tableId,
		ok: false,
		reason,
		message,
	};
}

/**
 * A table action's answer. A change that landed says what the builder says:
 * a refresh what changed, and a change of who manages it, where it moved no
 * column or row, the line the table's banner turns into.
 */
function tableAnswer(
	projectId: string,
	tableId: string,
	outcome: ManagedTableOutcome,
) {
	if (!outcome.ok) {
		return refusedTable(projectId, tableId, outcome.reason, outcome.message);
	}
	const hq = outcome.table.hq;
	if (hq === undefined) {
		throw new Error(
			"A lookup table that came from CommCare HQ answered a change with no CommCare HQ origin. The services in lib/deployment/managedData.ts answer only for such a table, so look at what wrote its origin.",
		);
	}
	const lines = managedTableOutcomeLines(outcome, hq.domain).lines;
	return {
		project_id: projectId,
		table_id: tableId,
		ok: true,
		reason: null,
		managed_by: hq.managedBy,
		message:
			lines.length > 0
				? lines.join(" ")
				: hq.managedBy === "nova"
					? managedInNovaBanner(hq.domain)
					: managedTableBanner(hq.domain),
	};
}

/** Read a lookup table, or an app's places, from CommCare HQ again. */
export function registerRefreshManagedData(
	server: McpServer,
	ctx: ToolContext,
): void {
	registerScopedTool(
		server,
		ctx,
		"inspect_lookup_source",
		{
			description:
				"Inspect the source access of one Project data table with the caller’s approved CommCare HQ connection. For worker, request a fresh check for a named mobile worker or your connected account and receive a bounded row sample. For workbook, use a freshly downloaded selected-table .xlsx file with the user’s approval to check its workers, groups and places and record a historical observation. Receipt reads the last recorded check. Historical workbook facts cannot authorize worker delivery or a new destination.",
			inputSchema: z.strictObject({
				project_id: projectIdSchema,
				table_id: tableIdSchema,
				operation: z.enum(["worker", "workbook", "receipt", "inventory-row"]),
				worker_username: z.string().max(128).optional(),
				ordinal: z.number().int().nonnegative().optional(),
				revision: z.string().regex(/^\d+$/).optional(),
				workbook_base64: z
					.string()
					.max(Math.ceil(sourceWorkbookBytes / 3) * 4)
					.optional(),
			}),
		},
		async (args) => {
			try {
				const tableId = parsedTableId(args.table_id);
				if (!ctx.grant || !tableId)
					throw new McpInvalidInputError(
						"This connection or table is unavailable. You can reconnect and open the table again.",
					);
				const access = {
					scope: await lookupScope(ctx, args.project_id),
					tableId,
					grant: ctx.grant,
				};
				if (
					(args.workbook_base64 !== undefined) !==
						(args.operation === "workbook") ||
					(args.worker_username !== undefined && args.operation !== "worker")
				)
					throw new McpInvalidInputError(
						"You can choose one source check for this table.",
					);
				if (args.operation === "inventory-row") {
					if (
						args.ordinal === undefined ||
						(args.ordinal > 0 && !args.revision)
					)
						throw new McpInvalidInputError(
							"A source row needs its position and the revision returned with the first row.",
						);
					return jsonResult(
						await inspectInlineSourceRow(access, args.ordinal, args.revision),
					);
				}
				if (args.ordinal !== undefined || args.revision !== undefined)
					throw new McpInvalidInputError(
						"An inventory row position belongs to the inventory-row operation.",
					);
				if (args.operation === "workbook") {
					const encoded = args.workbook_base64 ?? "";
					const bytes = Buffer.from(encoded, "base64");
					if (!bytes.length || bytes.toString("base64") !== encoded)
						throw new McpInvalidInputError(
							"Use the base64 bytes of the selected-table workbook.",
						);
					return jsonResult({
						receipt: await attestSourceWorkbook(access, bytes),
					});
				}
				if (args.operation === "receipt")
					return jsonResult({
						receipt: await historicalSourceWorkbook(access),
					});
				const checked = await inspectManagedLookupWorker(
					access,
					args.worker_username ?? "",
				);
				return jsonResult(
					checked.ok
						? {
								ok: true,
								inspection: {
									rows: checked.worker.rows.length,
									observedAt: checked.worker.observedAt,
									indexedFields: checked.worker.indexedFields,
								},
							}
						: checked,
				);
			} catch (error) {
				return toMcpErrorResult(error, {
					projectId: args.project_id,
					userId: ctx.userId,
				});
			}
		},
	);
	registerScopedTool(
		server,
		ctx,
		"refresh_managed_data",
		{
			description:
				"Read again a lookup table, or an app's places, that CommCare HQ manages, and update Nova's copy. Nova never changes that data in the project space that manages it. Use it after the user changed the table or the places in CommCare HQ and wants Preview to show it. The result's `message` says what changed, or why the copy was kept as it was.",
			/* Strict, so the served schema is closed: the SDK converts an input
			 * schema on its input side, where a plain object stays open. */
			inputSchema: z.strictObject({
				project_id: projectIdSchema,
				table_id: tableIdSchema
					.optional()
					.describe(
						"The lookup table to refresh, as get_lookup_tables lists it with `managed_in_commcare_hq`. Send this or `app_id`, not both.",
					),
				app_id: z
					.string()
					.trim()
					.min(1)
					.optional()
					.describe(
						"The app whose places to refresh, where get_organization shows `places_managed_in_commcare_hq`. Send this or `table_id`, not both.",
					),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				const { table_id: tableInput, app_id: appId } = args;
				if ((tableInput === undefined) === (appId === undefined)) {
					throw new McpInvalidInputError(REFRESH_MANAGED_DATA_TARGET_MESSAGE);
				}
				if (tableInput !== undefined) {
					const scope = await lookupScope(ctx, args.project_id);
					const tableId = parsedTableId(tableInput);
					if (tableId === null) {
						return jsonResult(
							refusedTable(
								args.project_id,
								tableInput,
								"not-found",
								LOOKUP_TABLE_NOT_FOUND,
							),
						);
					}
					return jsonResult(
						tableAnswer(
							args.project_id,
							tableInput,
							await refreshManagedLookupTable(scope, tableId, ctx.grant),
						),
					);
				}
				if (appId === undefined) {
					throw new McpInvalidInputError(REFRESH_MANAGED_DATA_TARGET_MESSAGE);
				}
				const access = await appInProject(ctx, appId, args.project_id);
				const outcome = await refreshManagedPlaces({
					appId,
					projectId: access.projectId,
					role: access.role,
					actorUserId: ctx.userId,
				});
				return jsonResult({
					project_id: args.project_id,
					app_id: appId,
					ok: outcome.ok,
					reason: outcome.ok ? null : outcome.reason,
					message: managedPlacesOutcomeLines(outcome).lines.join(" "),
				});
			} catch (err) {
				return toMcpErrorResult(err, {
					...(args.app_id !== undefined && { appId: args.app_id }),
					projectId: args.project_id,
					userId: ctx.userId,
				});
			}
		},
	);
}

/**
 * The caller's access to an app of the Project they named. An app in another
 * Project is not found there, so a caller learns nothing of where it is.
 */
async function appInProject(
	ctx: ToolContext,
	appId: string,
	projectId: string,
) {
	const access = await resolveAppScope(appId, ctx.userId, "view").catch(
		rethrowAsMcpAccess,
	);
	if (access.projectId !== projectId) throw new McpAccessError("not_found");
	return access;
}

/** Hand a lookup table that came from CommCare HQ to Nova, or back. */
export function registerSetLookupTableManagement(
	server: McpServer,
	ctx: ToolContext,
): void {
	registerScopedTool(
		server,
		ctx,
		"set_lookup_table_management",
		{
			description:
				'Change who manages a lookup table that came from CommCare HQ. Without `review_digest` this changes nothing: it returns what the change does, the apps that read the table and a `review_digest`. Show the user that answer and ask. Only after they agree, send the same call again with that `review_digest`. The change is made only while the table and the apps that read it are still what that answer showed; otherwise nothing changes, the answer\'s `reason` is `review-moved`, and it holds the change as it stands now with a new `review_digest`: show it and ask again. `managed_by: "nova"` means the table is edited in Nova from then on and each publish replaces it in CommCare HQ, and a later change there stops the next publish. `managed_by: "commcare-hq"` hands it back: Nova takes CommCare HQ\'s columns and rows and stops changing the table there. Never decide this for the user.',
			inputSchema: z.strictObject({
				current_workbook_base64: z
					.string()
					.max(Math.ceil(sourceWorkbookBytes / 3) * 4)
					.optional()
					.describe(
						"For a confirmed transfer of an assigned table, attach the current selected-table workbook downloaded from its source project space for this transfer.",
					),
				project_id: projectIdSchema,
				table_id: tableIdSchema,
				managed_by: z
					.enum(["nova", "commcare-hq"])
					.describe(
						"Who manages the table from now on: `nova`, or `commcare-hq` to hand it back.",
					),
				review_digest: z
					.string()
					.regex(/^[0-9a-f]{64}$/)
					.optional()
					.describe(
						"Leave this out to read what the change does without changing anything. Send the `review_digest` that answer returned only after the user agreed to it.",
					),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				const scope = await lookupScope(ctx, args.project_id);
				const tableId = parsedTableId(args.table_id);
				if (tableId === null) {
					return jsonResult(
						refusedTable(
							args.project_id,
							args.table_id,
							"not-found",
							LOOKUP_TABLE_NOT_FOUND,
						),
					);
				}
				if (args.review_digest !== undefined) {
					let workbook: Buffer | undefined;
					if (args.current_workbook_base64 !== undefined) {
						workbook = Buffer.from(args.current_workbook_base64, "base64");
						if (
							args.managed_by !== "nova" ||
							!workbook.length ||
							workbook.length > sourceWorkbookBytes ||
							workbook.toString("base64") !== args.current_workbook_base64
						)
							throw new McpInvalidInputError(
								"You can attach the current selected-table workbook with a confirmed transfer to Nova.",
							);
					}
					const outcome =
						args.managed_by === "nova"
							? await manageLookupTableInNova(
									scope,
									tableId,
									args.review_digest,
									ctx.grant,
									...(workbook ? [workbook] : []),
								)
							: await letHqManageLookupTable(
									scope,
									tableId,
									args.review_digest,
								);
					/* The table or its readers moved since the user agreed: answer
					 * the change as it stands now, to show and ask about again. */
					if (!outcome.ok && outcome.reason === "review-moved") {
						return jsonResult({
							...(await managementPreview(scope, tableId, args.managed_by, {
								projectId: args.project_id,
								tableId: args.table_id,
							})),
							ok: false,
							reason: outcome.reason,
							message: outcome.message,
						});
					}
					return jsonResult(
						tableAnswer(args.project_id, args.table_id, outcome),
					);
				}
				return jsonResult(
					await managementPreview(scope, tableId, args.managed_by, {
						projectId: args.project_id,
						tableId: args.table_id,
					}),
				);
			} catch (err) {
				return toMcpErrorResult(err, {
					projectId: args.project_id,
					userId: ctx.userId,
				});
			}
		},
	);
}

/**
 * What a change of who manages a table does, as its confirmation in the
 * builder says it, the apps that read the table, and the `review_digest` the
 * change is made under. Writes nothing. The same refusals as the change
 * itself: no such table, and a role that may not make the change. A table
 * already managed as asked answers with no lines, since nothing would change.
 */
async function managementPreview(
	scope: LookupScope,
	tableId: LookupTableId,
	managedBy: "nova" | "commcare-hq",
	ids: { readonly projectId: string; readonly tableId: string },
) {
	const view = await readManagedLookupTableView(scope, tableId);
	if (view === null) {
		return refusedTable(
			ids.projectId,
			ids.tableId,
			"not-found",
			LOOKUP_TABLE_NOT_FOUND,
		);
	}
	if (!roleAllowsApp(scope.role, "delete")) {
		return refusedTable(
			ids.projectId,
			ids.tableId,
			"not-permitted",
			MANAGEMENT_NEEDS_ADMIN,
		);
	}
	const domain = view.origin.domain;
	const readers = appsThatReadIt(view.apps);
	const unchanged = view.origin.managedBy === managedBy;
	const preview = (title: string, lines: readonly (string | null)[]) => ({
		project_id: ids.projectId,
		table_id: ids.tableId,
		ok: true,
		reason: null,
		managed_by: view.origin.managedBy,
		title: unchanged ? null : title,
		lines: unchanged
			? []
			: lines.filter((line): line is string => line !== null),
		apps: view.apps.map(appOf),
		review_digest: view.reviewDigest,
	});
	if (managedBy === "nova") {
		return preview(manageInNovaTitle(view.name), [
			...manageInNovaBody(domain),
			LOOKUP_DISCARD_NOTE,
			readers,
		]);
	}
	return preview(letHqManageTitle(view.name), [
		letHqManageBody(domain),
		columnsBecomeText(view.typedColumns),
		readers,
	]);
}

function appOf(app: LookupReferencingAppSummary) {
	return { app_id: app.appId, app_name: app.appName, deleted: app.deleted };
}
