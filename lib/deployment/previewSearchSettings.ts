import "server-only";
import { type QueryExecutorProvider, sql } from "kysely";
import {
	AppAccessError,
	resolveAppScopeInTransaction,
} from "@/lib/db/appAccess";
import { APP_STREAM_CHANNEL, withAppTx } from "@/lib/db/pg";
import type { OrganizationScope } from "@/lib/organization/types";
import { authorizeOrganizationWriteInTransaction } from "@/lib/organization/writerTransaction";
import {
	localSearchDefaults,
	type PreviewSearchCatalog,
	type PreviewSearchProfile,
	type PreviewSearchTarget,
	type PreviewSearchValues,
	previewSearchTargetKey,
	previewSearchValuesSchema,
	resolvePreviewSearchFacts,
	unconfirmedSearchValues,
} from "@/lib/preview/searchSettings";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { readPreviewDeploymentRecordsIn } from "./previewRecords";
import { deploymentDisplaysAsReached } from "./stateMachine";

type SearchScope = { readonly appId: string; readonly projectId: string };

function targetsOf(
	records: Awaited<ReturnType<typeof readPreviewDeploymentRecordsIn>>,
): PreviewSearchTarget[] {
	const targets = new Map<string, PreviewSearchTarget>();
	for (const record of records) {
		if (!deploymentDisplaysAsReached(record, "uploaded")) continue;
		const target = {
			kind: "destination",
			server: record.server,
			domain: record.domain,
		} as const;
		targets.set(previewSearchTargetKey(target), target);
	}
	return targets.size ? [...targets.values()] : [{ kind: "local" }];
}

function qualified(target: PreviewSearchTarget) {
	return target.kind === "local" ? { server: "local", domain: "" } : target;
}

/** Caller holds the app/actor authorization in this snapshot. A case query
 * and its configuration can therefore observe exactly one database version. */
export async function previewSearchCatalogIn(
	db: QueryExecutorProvider,
	scope: SearchScope,
	records?: Awaited<ReturnType<typeof readPreviewDeploymentRecordsIn>>,
): Promise<PreviewSearchCatalog> {
	const targets = targetsOf(
		records ?? (await readPreviewDeploymentRecordsIn(db, scope)),
	);
	const pairs = targets.map((t) => {
		const { server, domain } = qualified(t);
		return sql`(${server}, ${domain})`;
	});
	const { rows } = await sql<{
		server: string;
		domain: string;
		revision: string;
		settings: unknown;
	}>`
		SELECT server, domain, revision::text, settings FROM preview_search_settings
		WHERE project_id = ${scope.projectId} AND (server,domain) IN (${sql.join(pairs)})
	`.execute(db);
	const profiles = targets.map((target): PreviewSearchProfile => {
		const { server, domain } = qualified(target);
		const row = rows.find((r) => r.server === server && r.domain === domain);
		return {
			target,
			revision: row?.revision ?? "0",
			values: row
				? previewSearchValuesSchema.parse(row.settings)
				: target.kind === "local"
					? localSearchDefaults
					: unconfirmedSearchValues,
		};
	});
	return { projectId: scope.projectId, profiles };
}

export async function readPreviewSearchFacts(
	db: QueryExecutorProvider,
	scope: SearchScope,
	target?: PreviewSearchTarget,
) {
	return resolvePreviewSearchFacts(
		await previewSearchCatalogIn(db, scope),
		target,
	);
}

export async function readAuthorizedPreviewSearchCatalog(
	appId: string,
	projectId: string,
	actorId: string,
) {
	return withAppTx(
		async (tx) => {
			const access = await resolveAppScopeInTransaction(
				tx,
				appId,
				actorId,
				"view",
			);
			if (access.projectId !== projectId) throw new AppAccessError("not_found");
			return previewSearchCatalogIn(tx, { appId, projectId });
		},
		{ isolationLevel: "repeatable read" },
	);
}

export type SetSearchSettingsResult =
	| { kind: "saved"; catalog: PreviewSearchCatalog; savedRevision: string }
	| { kind: "changed"; catalog: PreviewSearchCatalog }
	| { kind: "target-unavailable"; catalog: PreviewSearchCatalog };

export type SearchToolScope = OrganizationScope & { requestId: string };

async function previousReceipt(
	db: QueryExecutorProvider,
	tool: SearchToolScope,
) {
	const {
		rows: [prior],
	} = await sql<{ input_digest: string; saved_revision: string }>`
		SELECT input_digest, saved_revision::text FROM preview_search_setting_receipts
		WHERE app_id=${tool.appId} AND project_id=${tool.projectId} AND actor_id=${tool.actorUserId}
		AND request_id=${tool.requestId}
	`.execute(db);
	return prior;
}

export async function recoverPreviewSearchSettings(tool: SearchToolScope) {
	return withAppTx(async (tx) => {
		await authorizeOrganizationWriteInTransaction(tx, tool, {
			capability: "edit",
			exclusiveApp: true,
		});
		return (await previousReceipt(tx, tool))?.saved_revision;
	});
}

export async function setPreviewSearchSettings(
	scope: SearchScope,
	actorId: string,
	target: PreviewSearchTarget,
	expectedRevision: string,
	values: PreviewSearchValues,
	authority?: Pick<
		SearchToolScope,
		"requestId" | "chatRunHolder" | "authoringSessionId" | "ordinaryAuthoring"
	>,
): Promise<SetSearchSettingsResult> {
	const checked = previewSearchValuesSchema.parse(values);
	const tool: SearchToolScope | undefined = authority && {
		...authority,
		...scope,
		role: "tool",
		actorUserId: actorId,
	};
	return withAppTx(async (tx) => {
		const digest = tool
			? canonicalJsonDigest({ target, expectedRevision, values: checked })
			: undefined;
		if (tool) {
			await authorizeOrganizationWriteInTransaction(tx, tool, {
				capability: "edit",
				exclusiveApp: true,
			});
			const prior = await previousReceipt(tx, tool);
			if (prior) {
				if (prior.input_digest !== digest)
					throw new Error(
						"This request already saved different search settings.",
					);
				return {
					kind: "saved",
					savedRevision: prior.saved_revision,
					catalog: await previewSearchCatalogIn(tx, scope),
				};
			}
			if (tool.ordinaryAuthoring) {
				const pending = await tx
					.selectFrom("authoring_sessions as s")
					.innerJoin(
						"authoring_workspaces as w",
						"w.id",
						"s.active_candidate_id",
					)
					.select("w.next_ordinal")
					.where("s.id", "=", tool.ordinaryAuthoring.sessionId)
					.executeTakeFirst();
				if (pending && BigInt(pending.next_ordinal) > BigInt(0))
					throw new Error(
						"Save the pending app edits before confirming Preview search settings.",
					);
			}
		}
		const access = await resolveAppScopeInTransaction(
			tx,
			scope.appId,
			actorId,
			"edit",
		);
		if (access.projectId !== scope.projectId)
			throw new AppAccessError("not_found");
		const catalog = await previewSearchCatalogIn(tx, scope);
		const key = previewSearchTargetKey(target);
		const profile = catalog.profiles.find(
			(p) => previewSearchTargetKey(p.target) === key,
		);
		if (!profile) return { kind: "target-unavailable", catalog };
		if (profile.revision !== expectedRevision)
			return { kind: "changed", catalog };
		const { server, domain } = qualified(target);
		const json = JSON.stringify(checked);
		let savedRevision = expectedRevision;
		if (
			expectedRevision === "0" ||
			canonicalJsonDigest(profile.values) !== canonicalJsonDigest(checked)
		) {
			const changed =
				expectedRevision === "0"
					? await sql`INSERT INTO preview_search_settings(project_id,server,domain,revision,settings)
				VALUES (${scope.projectId},${server},${domain},1,${json}::jsonb)
				ON CONFLICT (project_id,server,domain) DO NOTHING RETURNING revision`.execute(
							tx,
						)
					: await sql`UPDATE preview_search_settings SET settings=${json}::jsonb, revision=revision+1
				WHERE project_id=${scope.projectId} AND server=${server} AND domain=${domain}
				AND revision=${expectedRevision}::bigint RETURNING revision`.execute(
							tx,
						);
			if (changed.rows.length === 0)
				return {
					kind: "changed",
					catalog: await previewSearchCatalogIn(tx, scope),
				};
			// Other apps in this Project that preview this very destination share
			// the setting. A local profile can be chosen by any unpublished app.
			await sql`SELECT pg_notify(${APP_STREAM_CHANNEL}, json_build_object('appId',a.id,'deploymentChanged',true)::text)
			FROM apps a WHERE a.project_id=${scope.projectId} AND a.deleted_at IS NULL
			AND (${server}::text='local' OR EXISTS (
				SELECT 1 FROM app_deployments d WHERE d.app_id=a.id AND d.project_id=a.project_id
				AND d.server=${server} AND d.domain=${domain}
			))`.execute(tx);
			savedRevision = (BigInt(expectedRevision) + BigInt(1)).toString();
		}
		if (tool && digest)
			await sql`INSERT INTO preview_search_setting_receipts(app_id,project_id,actor_id,request_id,input_digest,saved_revision)
			VALUES (${scope.appId},${scope.projectId},${actorId},${tool.requestId},${digest},${savedRevision}::bigint)`.execute(
				tx,
			);
		return {
			kind: "saved",
			savedRevision,
			catalog: await previewSearchCatalogIn(tx, scope),
		};
	});
}
