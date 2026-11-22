import type { Kysely, Transaction } from "kysely";
import {
	greatestFoldBaselineSeq,
	loadCanonicalBlueprintAtSequence,
} from "@/lib/agent/change-set/baseLoader";
import { publishedQuestionPaths } from "@/lib/commcare/hq/publishedQuestionPaths";
import type { AppDatabase } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { PersistableDoc, Uuid } from "@/lib/domain";
import { sourceFromBaseline } from "./hqChanges/baselineSource";
import { verifiedBaselineSource } from "./verifiedBaselineSource";

type Db = Kysely<AppDatabase> | Transaction<AppDatabase>;

export function publishedQuestionSources(
	db: Db,
	appId: string,
	projectId: string,
) {
	return db
		.selectFrom("app_deployments as d")
		.innerJoin("app_deployment_resources as r", "r.deployment_id", "d.id")
		.leftJoin("app_deployment_baselines as b", (join) =>
			join
				.onRef("b.deployment_id", "=", "d.id")
				.onRef("b.remote_app_id", "=", "r.remote_id"),
		)
		.select([
			"d.id",
			"r.pushed_revision",
			"b.origin",
			"b.nova_revision",
			"b.source_digest",
		])
		.where("d.project_id", "=", projectId)
		.where("d.app_id", "=", appId)
		.where("r.kind", "=", "app")
		.where("r.superseded_at", "is", null)
		.orderBy("d.id")
		.execute();
}

/** Existing submitted question identities for a reader already authorized
 * to read this app in this Project. The same revision on multiple targets
 * needs only one reconstruction. A historical revision before the current
 * fold horizon is compared to the verified source HQ retained. */
export async function publishedQuestions(
	db: Db,
	appId: string,
	projectId: string,
	headSeq: number,
	head: PersistableDoc,
	existing?: Awaited<ReturnType<typeof publishedQuestionSources>>,
): Promise<Uuid[]> {
	const targets =
		existing ?? (await publishedQuestionSources(db, appId, projectId));
	if (targets.length === 0) return [];
	const found = new Set<Uuid>();
	const revisions = new Set<number>();
	const all = () => Object.values(head.fields).map((field) => field.uuid);
	let horizon: number | null | undefined;
	for (const target of targets) {
		const known =
			target.origin === "read" || target.origin === "changes"
				? target.nova_revision
				: target.pushed_revision;
		if (known !== null && Number(known) === headSeq) return all();
		if (horizon === undefined)
			horizon = await greatestFoldBaselineSeq(db, appId);
		if (known !== null && horizon !== null && Number(known) >= horizon) {
			revisions.add(Number(known));
			continue;
		}
		if (target.origin === "create" && known === null) continue;
		// A confirmed upload behind the replay horizon still has historical answers
		// even if the retained source became unreadable. Review any changed path.
		if (target.origin === null || target.origin === "unread") {
			if (known !== null) return all();
			continue;
		}
		const row = await db
			.selectFrom("app_deployment_baselines as b")
			.innerJoin("app_deployments as d", "d.id", "b.deployment_id")
			.select([
				"b.deployment_id",
				"b.source_gzip",
				"b.source_digest",
				"b.ownership",
			])
			.where("d.project_id", "=", projectId)
			.where("d.app_id", "=", appId)
			.where("d.id", "=", target.id)
			.executeTakeFirst();
		if (row === undefined) return all();
		const verified = verifiedBaselineSource(row);
		if (verified === null) return all();
		const originals = await db
			.selectFrom("app_deployment_identities as i")
			.innerJoin("app_deployments as d", "d.id", "i.deployment_id")
			.select(["i.nova_entity_uuid", "i.xmlns"])
			.where("d.project_id", "=", projectId)
			.where("d.app_id", "=", appId)
			.where("d.id", "=", target.id)
			.where("i.entity_kind", "=", "form")
			.execute();
		const names = new Map(
			originals.flatMap((item) =>
				item.xmlns === null
					? []
					: [[item.nova_entity_uuid, item.xmlns] as const],
			),
		);
		for (const id of publishedQuestionPaths(
			hydratePersistedBlueprint(head),
			sourceFromBaseline(verified.source),
			names,
		))
			found.add(id);
	}
	for (const seq of revisions) {
		const previous = await loadCanonicalBlueprintAtSequence(db, {
			appId,
			seq,
			expectedDigest: null,
		});
		if (previous.projectId !== projectId) continue;
		for (const field of Object.values(previous.doc.fields))
			if (Object.hasOwn(head.fields, field.uuid)) found.add(field.uuid);
	}
	return [...found];
}
