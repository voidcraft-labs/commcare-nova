/** Synthetic released entities and history. Only the archived release
 * applies the old authoring vocabulary and reads its carrier projections. */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { sql } from "kysely";
import { readReleasedFoldSnapshot } from "@/lib/case-store/migrations/20261208000000_connect_activity_roles";
import type { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	decomposeBlueprint,
	entityRowStatements,
} from "@/lib/db/blueprintRows";
import { OWNERSHIP } from "@/lib/deployment/__tests__/adoptedBirth";
import { canonicalAppGenesis, emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import { blueprintDocSchema, uuidSchema } from "@/lib/domain";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { convert as convertConnect } from "../../lib/db/releasedConnectShape.mjs";
import type { CompletionMigration } from "../lib/completionWorkspaces";

type Harness = ReturnType<typeof setupAppStateTestDb>;
type Role = "learn" | "deliver";
type Scope = { actor: string; project: string };
type ReleasedApp = {
	appId: string;
	role: Role | null;
	latestSeq: number;
	headSeq: number;
	latestText: string;
	headText: string;
};

function id(...parts: (string | number)[]) {
	const bytes = createHash("sha256").update(JSON.stringify(parts)).digest();
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.subarray(0, 16).toString("hex");
	return uuidSchema.parse(
		[
			hex.slice(0, 8),
			hex.slice(8, 12),
			hex.slice(12, 16),
			hex.slice(16, 20),
			hex.slice(20),
		].join("-"),
	);
}

export async function seedScaleApp(
	h: Harness,
	released: CompletionMigration,
	input: Scope & {
		index: number;
		archived: boolean;
		fields: number;
		forms: number;
		role: Role | null;
		baselines: number;
		suffix: number;
		suffixReadsOldRole: boolean;
	},
): Promise<ReleasedApp> {
	const { index, actor, project, role, forms, fields, baselines, suffix } =
		input;
	const appId = id("app", index);
	const name = `Synthetic outreach register ${index + 1}`;
	const root = released.privateBase({
		kind: "genesis",
		appId,
		projectId: project,
	}).snapshot;
	const seed = canonicalAppGenesis(emptyBlueprintDoc(appId), name);
	const firstField = seed.mutations.find((step) => step.kind === "addField");
	if (!firstField)
		throw new Error("Synthetic genesis is missing its opening question.");
	const mutations: unknown[] = [...seed.mutations];
	if (role) {
		mutations.push({
			kind: "setAppSettings",
			settings: { runsOnlyOn: "android" },
		});
		mutations.push({ kind: "setConnectType", connectType: role });
	}
	let questions = 1;
	for (let form = 0; form < forms; form++) {
		const formUuid = form === 0 ? seed.formUuid : id("form", index, form);
		if (form !== 0)
			mutations.push({
				kind: "addForm",
				moduleUuid: seed.moduleUuid,
				form: {
					uuid: formUuid,
					id: `visit_${form + 1}`,
					name: `Visit ${form + 1}`,
					type: "survey",
				},
			});
		if (role) {
			const block = {
				id: `activity_${form + 1}`,
				name: `Training ${form + 1}`,
			};
			const connect =
				role === "learn"
					? {
							learn_module: {
								...block,
								description: "Review the worker visit",
								time_estimate: 1,
							},
						}
					: { deliver_unit: block };
			mutations.push({
				kind: "updateForm",
				uuid: formUuid,
				patch: { connect },
			});
		}
		const end = Math.floor((fields * (form + 1)) / forms);
		while (questions < end) {
			questions++;
			mutations.push({
				kind: "addField",
				parentUuid: formUuid,
				field: {
					...firstField.field,
					uuid: id("field", index, questions),
					id: `question_${questions}`,
				},
			});
		}
	}
	const before = released.privateOverlay(root, mutations) as {
		forms: Record<string, Record<string, unknown>>;
		caseTypes: unknown;
		appSettings: unknown;
	};

	// Obtain IDs and ordering from the ordinary row decomposition, then
	// restore the old form JSON and omit each new activity carrier. The
	// archived reader's exact digest below rejects any difference in the
	// resulting source projection.
	const candidate = blueprintDocSchema.parse(
		convertConnect(before, {}, { appId }),
	);
	const rows = decomposeBlueprint(candidate)
		.filter((row) => row.data.kind !== "connect_activity")
		.map((row) => ({
			...row,
			data: row.kind === "form" ? before.forms[row.uuid] : row.data,
		}));
	await h.seedRawApp({
		id: appId,
		owner: actor,
		project_id: project,
		app_name: name,
		...(input.archived && {
			deleted_at: new Date("2026-01-01T00:00:00Z"),
			recoverable_until: new Date("2026-01-07T00:00:00Z"),
		}),
	});
	return h.withTransaction(async (tx) => {
		for (const chunk of entityRowStatements(rows)) {
			await tx
				.insertInto("blueprint_entities")
				.values(
					chunk.map((row) => ({
						app_id: appId,
						uuid: row.uuid,
						kind: row.kind,
						parent_uuid: row.parent_uuid,
						ordinal: row.ordinal,
						data: JSON.stringify(row.data),
					})),
				)
				.execute();
		}
		await sql`UPDATE apps SET connect_type = ${role},
			case_types = ${JSON.stringify(before.caseTypes)}::jsonb,
			app_settings = ${JSON.stringify(before.appSettings)}::jsonb,
			module_count = 1, form_count = ${forms} WHERE id = ${appId}`.execute(tx);
		for (let sequence = 1; sequence <= baselines; sequence++) {
			const horizon =
				sequence === baselines
					? "hq-round-trip-case-writes"
					: [
							"canonical-identity-foundation",
							"unified-authoring",
							"hq-round-trip-expressions",
						][sequence - 1];
			const title =
				sequence === baselines ? name : `${name} archive ${sequence}`;
			await sql`UPDATE apps SET app_name = ${title}, app_name_lower = lower(${title}), mutation_seq = ${sequence}
				WHERE id = ${appId}`.execute(tx);
			await sql`INSERT INTO app_changes (app_id, seq, batch_id, actor_id, kind, mutations)
				VALUES (${appId}, ${sequence}, ${`fold-baseline:${horizon}`}, ${`system:${horizon}`}, 'fold-baseline', '[]')`.execute(
				tx,
			);
			await sql`INSERT INTO app_change_fold_baselines (app_id, seq, project_id, snapshot, snapshot_digest)
				SELECT ${appId}, ${sequence}, ${project}, doc, nova_app_change_fold_snapshot_digest(doc)
				FROM (SELECT public.nova_current_app_change_fold_snapshot(${appId}) AS doc) AS snapshot`.execute(
				tx,
			);
		}
		const latestText = await readReleasedFoldSnapshot(tx, appId);
		if (
			canonicalJsonDigest(released.readHead(latestText)) !==
			canonicalJsonDigest(before)
		)
			throw new Error(
				"The synthetic entity projection differs from the archived reader.",
			);
		for (let ordinal = 0; ordinal < suffix; ordinal++) {
			const sequence = baselines + ordinal + 1;
			const title = `${name} edited ${ordinal + 1}`;
			const batch: unknown[] = [{ kind: "setAppName", name: title }];
			if (ordinal === 0 && input.suffixReadsOldRole)
				batch.push({ kind: "setConnectType", connectType: role });
			await sql`UPDATE apps SET app_name = ${title}, app_name_lower = lower(${title}), mutation_seq = ${sequence}
				WHERE id = ${appId}`.execute(tx);
			await sql`INSERT INTO app_changes (app_id, seq, batch_id, actor_id, kind, mutations)
				VALUES (${appId}, ${sequence}, ${id("change", index, sequence)}, ${actor}, 'autosave', ${JSON.stringify(batch)}::jsonb)`.execute(
				tx,
			);
		}
		return {
			appId,
			role,
			latestSeq: baselines,
			headSeq: baselines + suffix,
			latestText,
			headText: await readReleasedFoldSnapshot(tx, appId),
		};
	});
}

export async function seedScaleTarget(
	h: Harness,
	{ actor, project }: Scope,
	app: ReleasedApp,
	domain: string,
	options: { layout?: boolean; uncertain?: boolean } = {},
) {
	const target = await h
		.db()
		.insertInto("app_deployments")
		.values({
			app_id: app.appId,
			project_id: project,
			server: "india",
			domain,
			state: "uploaded",
			phases: "{}",
			created_by: actor,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	await h
		.db()
		.insertInto("app_deployment_resources")
		.values({
			deployment_id: target.id,
			kind: "app",
			nova_resource_id: app.appId,
			remote_id: domain,
			ownership: "nova-created",
			pushed_revision: app.latestSeq,
		})
		.execute();
	const source = JSON.stringify({
		doc_type: "Application",
		name: `Field visit ${domain}`,
		modules: [],
		_attachments: {},
		profile: {},
		langs: ["en"],
		build_spec: { version: "2.57.0" },
		build_profiles: {},
		translations: {},
		add_ons: {},
		...(options.layout && {
			use_grid_menus: true,
			auto_gps_capture: app.role === null,
		}),
	});
	await h
		.db()
		.insertInto("app_deployment_baselines")
		.values({
			deployment_id: target.id,
			origin: options.uncertain ? "unread" : "push",
			remote_app_id: domain,
			observed_by: actor,
			observed_at: new Date("2026-01-04T00:00:00Z"),
			...(!options.uncertain && {
				ownership: JSON.stringify(OWNERSHIP),
				nova_revision: app.latestSeq,
				source_gzip: gzipSync(source),
				source_digest: createHash("sha256").update(source).digest("hex"),
				source_bytes: Buffer.byteLength(source),
			}),
		})
		.execute();
}

export async function seedScaleWorkspace(
	h: Harness,
	released: CompletionMigration,
	{ actor, project }: Scope,
	options: {
		index: number;
		app?: ReleasedApp;
		stale: boolean;
		changes: number;
		oldShape: boolean;
	},
) {
	const { index, app, stale, changes, oldShape } = options;
	const session = id("session", index),
		workspace = id("workspace", index);
	const appId = app?.appId ?? id("proposed", index);
	const base = app
		? released.readHead(stale ? app.latestText : app.headText)
		: released.privateBase({ kind: "genesis", appId, projectId: project })
				.snapshot;
	const sequence = app ? (stale ? app.latestSeq : app.headSeq) : null;
	let overlay = base;
	await h.withTransaction(async (tx) => {
		await sql`INSERT INTO authoring_sessions (id, actor_user_id, project_id, origin, app_id, proposed_app_id, app_name, begin_request_id, begin_input_digest)
			VALUES (${session}, ${actor}, ${project}, 'mcp', ${app?.appId ?? null}, ${app ? null : appId}, 'Synthetic training', ${workspace}, ${canonicalJsonDigest(workspace)})`.execute(
			tx,
		);
		await sql`INSERT INTO authoring_workspaces (id, authoring_session_id, kind, app_id, proposed_app_id, base_seq, base_project_id, base_snapshot_digest, revision, next_ordinal, owner_user_id, status)
			VALUES (${workspace}, ${session}, ${app ? "app-edit" : "genesis"}, ${app?.appId ?? null}, ${app ? null : appId}, ${sequence}, ${project}, ${canonicalJsonDigest(base)}, ${changes}, ${changes}, ${actor}, 'open')`.execute(
			tx,
		);
		await sql`UPDATE authoring_sessions SET active_candidate_id = ${workspace} WHERE id = ${session}`.execute(
			tx,
		);
		for (let ordinal = 0; ordinal < changes; ordinal++) {
			const request = `edit-${ordinal}`;
			const name = `Private visits ${index + 1} (${ordinal + 1})`;
			const batch: unknown[] =
				!app && ordinal === 0
					? [...canonicalAppGenesis(emptyBlueprintDoc(appId), name).mutations]
					: [{ kind: "setAppName", name }];
			if (oldShape && ordinal === 0)
				batch.push({ kind: "setConnectType", connectType: app?.role ?? null });
			const mutationDigest = canonicalJsonDigest(batch);
			overlay = released.privateOverlay(overlay, batch);
			const receipt = {
				requestId: request,
				disposition: "staged",
				workspaceRevision: ordinal + 1,
				ordinal,
				mutationDigest,
				diagnostics: {
					candidateDigest: canonicalJsonDigest(overlay),
					findingCount: 0,
					findingFingerprints: [],
					canCommit: true,
				},
				replayResult: { kind: "mutate", mutations: [], result: { ok: true } },
			};
			await sql`INSERT INTO authoring_requests (change_set_id, request_id, tool_name, input_digest, expected_revision, resulting_revision, status, receipt)
				VALUES (${workspace}, ${request}, 'updateApp', ${canonicalJsonDigest({ name })}, ${ordinal}, ${ordinal + 1}, 'staged', ${JSON.stringify(receipt)}::jsonb)`.execute(
				tx,
			);
			await sql`INSERT INTO authoring_steps (change_set_id, ordinal, request_id, tool_name, mutations, mutation_digest)
				VALUES (${workspace}, ${ordinal}, ${request}, 'updateApp', ${JSON.stringify(batch)}::jsonb, ${mutationDigest})`.execute(
				tx,
			);
			await sql`INSERT INTO authoring_step_stages (change_set_id, step_ordinal, stage_ordinal, stage_name, mutation_start, mutation_count)
				VALUES (${workspace}, ${ordinal}, 0, 'Visit design', 0, ${batch.length})`.execute(
				tx,
			);
		}
	});
	return workspace;
}
