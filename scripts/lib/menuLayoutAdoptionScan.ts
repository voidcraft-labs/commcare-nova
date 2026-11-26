import type { Transaction } from "kysely";
import { isCommCareServer } from "@/lib/commcare/servers";
import { targetWireIdentity } from "@/lib/commcare/wireIdentity";
import { loadSchemaAdmittedAppForInspection } from "@/lib/db/apps";
import type { AppDatabase } from "@/lib/db/pg";
import { sourceFromBaseline } from "@/lib/deployment/hqChanges/baselineSource";
import {
	readFoldOperatorBaseline,
	readTargetIdentityRows,
} from "@/lib/deployment/store";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { MenuLayoutDecision } from "../migrations/step7-menu-layouts";
import {
	type MenuLayoutSourceDoc,
	planMenuLayoutAdoption,
} from "./menuLayoutAdoption";

type LayoutHeadReader = (appId: string) => Promise<{
	doc: MenuLayoutSourceDoc;
	mutationSeq: number;
} | null>;

const readCurrentLayoutHead =
	(tx: Transaction<AppDatabase>): LayoutHeadReader =>
	async (appId) => {
		const stored = await loadSchemaAdmittedAppForInspection(appId, tx);
		return (
			stored && { doc: stored.blueprint, mutationSeq: stored.mutation_seq }
		);
	};

export async function scanMenuLayoutAdoptions(
	tx: Transaction<AppDatabase>,
	appId?: string,
	readHead = readCurrentLayoutHead(tx),
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
			"r.push_token as mappingToken",
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
	const decisions: (MenuLayoutDecision & {
		deploymentId: string;
		remoteId: string;
		mappingToken: string;
		sourceDigest: string;
		headSeq: number;
	})[] = [];
	for (const row of targets) {
		const {
			appId,
			projectId,
			deploymentId,
			server,
			domain,
			remoteId,
			mappingToken,
		} = row;
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
		const stored = await readHead(appId);
		if (stored === null) {
			outcomes.push({ ...identity, standing: "unreadable-document" });
			continue;
		}
		const record = await readTargetIdentityRows(tx, deploymentId, {
			appId,
			server,
		});
		const wire = targetWireIdentity(record.entities, record.columnWords);
		const plan = planMenuLayoutAdoption(
			stored.doc,
			wire,
			sourceFromBaseline(baseline.source),
		);
		const standing =
			plan.unresolved.length > 0
				? "review"
				: plan.mutations.length === 0
					? "current"
					: counts.get(appId) === 1
						? "adopt"
						: "multiple-targets";
		if (standing === "adopt" && remoteId && mappingToken) {
			decisions.push({
				appId,
				projectId,
				deploymentId,
				remoteId,
				mappingToken,
				sourceDigest: baseline.sourceDigest,
				headSeq: stored.mutationSeq,
				settings: plan.settings,
				gridMenus: plan.gridMenus,
			});
		}
		outcomes.push({
			...identity,
			standing:
				standing === "adopt" && (!remoteId || !mappingToken)
					? "unreadable-claim"
					: standing,
			mutations: plan.mutations.length,
			unresolved: plan.unresolved.length,
		});
	}
	return { outcomes, decisions, digest: canonicalJsonDigest(decisions) };
}

/** Re-read the exact claims and revisions after the release transaction has
 * fenced writers. The converter receives the same decisions this compares. */
export async function checkMenuLayoutSourceFacts(
	tx: Transaction<AppDatabase>,
	reviewed: Pick<
		Awaited<ReturnType<typeof scanMenuLayoutAdoptions>>,
		"decisions" | "digest"
	>,
	readHead?: LayoutHeadReader,
): Promise<void> {
	const current = await scanMenuLayoutAdoptions(tx, undefined, readHead);
	if (
		current.digest !== reviewed.digest ||
		canonicalJsonDigest(reviewed.decisions) !== reviewed.digest
	) {
		throw new Error(
			"The retained menu layout sources changed. Scan the active deployments again.",
		);
	}
}
