import type { Transaction } from "kysely";
import { isCommCareServer } from "@/lib/commcare/servers";
import { loadSchemaAdmittedAppForInspection } from "@/lib/db/apps";
import type { AppDatabase } from "@/lib/db/pg";
import { sourceFromBaseline } from "@/lib/deployment/hqChanges/baselineSource";
import {
	readFoldOperatorBaseline,
	readTargetIdentityRows,
} from "@/lib/deployment/store";
import { exportIdentityOf } from "@/lib/deployment/targetIdentity";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { planMenuLayoutAdoption } from "./menuLayoutAdoption";

export async function scanMenuLayoutAdoptions(
	tx: Transaction<AppDatabase>,
	appId?: string,
) {
	let query = tx
		.selectFrom("app_deployments as d")
		.innerJoin("apps as a", (join) =>
			join
				.onRef("a.id", "=", "d.app_id")
				.onRef("a.project_id", "=", "d.project_id"),
		)
		.innerJoin("app_deployment_resources as r", (join) =>
			join
				.onRef("r.deployment_id", "=", "d.id")
				.onRef("r.nova_resource_id", "=", "a.id")
				.on("r.kind", "=", "app")
				.on("r.superseded_at", "is", null)
				.on("r.released_at", "is", null),
		)
		.select([
			"a.id as appId",
			"a.project_id as projectId",
			"d.id as deploymentId",
			"d.server",
			"d.domain",
			"r.remote_id as remoteId",
		])
		.where("a.deleted_at", "is", null)
		.where("d.state", "!=", "ended")
		.orderBy("a.id")
		.orderBy("d.id");
	if (appId !== undefined) query = query.where("a.id", "=", appId);
	const targets = await query.execute();

	const counts = new Map<string, number>();
	for (const row of targets)
		counts.set(row.appId, (counts.get(row.appId) ?? 0) + 1);
	const outcomes = [];
	for (const row of targets) {
		const { appId, projectId, deploymentId, server, domain, remoteId } = row;
		const identity = { appId, deploymentId };
		if (!isCommCareServer(server)) {
			outcomes.push({ ...identity, standing: "unreadable-destination" });
			continue;
		}
		const baseline = await readFoldOperatorBaseline(
			tx,
			{ appId, projectId },
			{ server, domain },
			"prior",
		);
		if (
			!baseline ||
			baseline.origin === "unread" ||
			baseline.origin === "create" ||
			baseline.remoteAppId !== remoteId
		) {
			outcomes.push({ ...identity, standing: "no-source" });
			continue;
		}
		if (baseline.ownership.menuLayouts) {
			outcomes.push({ ...identity, standing: "owned" });
			continue;
		}
		const stored = await loadSchemaAdmittedAppForInspection(appId, tx);
		if (stored === null) {
			outcomes.push({ ...identity, standing: "unreadable-document" });
			continue;
		}
		const doc = hydratePersistedBlueprint(stored.blueprint);
		const record = await readTargetIdentityRows(tx, deploymentId, {
			appId,
			server,
		});
		const wire = exportIdentityOf(doc, record).identity;
		const plan = planMenuLayoutAdoption(
			doc,
			wire,
			sourceFromBaseline(baseline.source),
		);
		outcomes.push({
			...identity,
			standing:
				plan.unresolved.length > 0
					? "review"
					: plan.mutations.length === 0
						? "current"
						: counts.get(appId) === 1
							? "adopt"
							: "multiple-targets",
			mutations: plan.mutations.length,
			unresolved: plan.unresolved.length,
		});
	}
	return outcomes;
}
