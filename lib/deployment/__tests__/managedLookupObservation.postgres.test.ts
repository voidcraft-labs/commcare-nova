import { sql } from "kysely";
import { beforeEach, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { decrypt } from "@/lib/commcare/encryption";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { v7 } from "uuid";
import { canonicalTestBlueprint } from "@/lib/db/__tests__/appStateTestDb";
import { asUuid } from "@/lib/domain/uuid";
import { readManagedTableReview } from "@/lib/lookup/managed";
import { manageLookupTableInNova } from "../managedData";
import { readWorkerLookupProjection } from "../workerLookupProjection";
import { getLookupManifest } from "@/lib/lookup/service";
import { attestSourceWorkbook } from "../managedLookupObservation";
import {
	connect,
	hqRowsOf,
	makeManagedCopy,
	serveRows,
	serveTableList,
} from "./managedFixtures";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
const h = setupAppStateTestDb("managed_lookup_observations_", {
	authSchema: "migrated",
});
const scope = {
	actorId: "source-editor",
	projectId: "program",
	role: "editor",
} as const;
const table = {
	id: "a".repeat(32),
	tag: "district",
	isGlobal: false,
	fields: ["name"],
	rows: [{ name: "North" }],
};
const origin = { server: "india", domain: "clinic" } as const;
const grant = { kind: "session", sessionId: "source-session" } as const;
const workbook = () => {
	const book = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(
		book,
		XLSX.utils.aoa_to_sheet([
			[
				"Delete(Y/N)",
				"table_id",
				"is_global?",
				"field 1",
				"field 1: is_indexed?",
			],
			["N", "district", "no", "name", "yes"],
		]),
		"types",
	);
	XLSX.utils.book_append_sheet(
		book,
		XLSX.utils.aoa_to_sheet([
			["UID", "Delete(Y/N)", "field: name"],
			[hqRowsOf(table)[0].id, "N", "North"],
		]),
		"district",
	);
	return XLSX.write(book, { bookType: "xlsx", type: "buffer" }) as Buffer;
};
beforeEach(async () => {
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
	await h.seedProjectMember(scope.actorId, scope.projectId, "editor");
	await connect(h, scope.actorId, "india", ["clinic"]);
	await sql`INSERT INTO auth_session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES
  (${grant.sessionId},'fixture-token',${scope.actorId},now()+interval '1 hour',now(),now())`.execute(
		h.db(),
	);
});
it.each([false, true])(
	"checks source workbook under the current credential and revision, including revocation during its read (%s)",
	async (revoked) => {
		const { tableId } = await makeManagedCopy(h, scope, table, origin);
		const data = workbook();
		await withHttpPeer(async (peer) => {
			serveTableList(peer, "clinic", [table]);
			serveRows(
				peer,
				"clinic",
				table,
				undefined,
				revoked
					? async () => {
							await sql`DELETE FROM auth_session WHERE id=${grant.sessionId}`.execute(
								h.db(),
							);
						}
					: undefined,
			);
			peer
				.get("https://india.commcarehq.org")
				.intercept({
					method: "GET",
					path: `/a/clinic/api/lookup_table/v1/${table.id}/`,
				})
				.reply(200, {
					id: table.id,
					tag: table.tag,
					is_global: false,
					item_attributes: [],
					fields: [{ field_name: "name", properties: [] }],
				});
			const result = attestSourceWorkbook({ scope, grant, tableId }, data);
			if (revoked) await expect(result).rejects.toThrow();
			else
				expect(await result).toMatchObject({
					rows: 1,
					assignedRows: 0,
					indexedFields: ["name"],
					source: "selected-workbook",
				});
		});
		const saved = await h
			.db()
			.selectFrom("lookup_tables")
			.select(["hq_canonical", "hq_source_observation"])
			.where("id", "=", tableId)
			.executeTakeFirstOrThrow();
		expect(saved.hq_canonical?.source).toMatchObject({
			distribution: "assigned",
			indexEvidence: "unobserved",
		});
		if (revoked) expect(saved.hq_source_observation).toBeNull();
		else
			expect(saved.hq_source_observation?.receipt).toMatchObject({
				rows: 1,
				indexedFields: ["name"],
			});
		const manifest = await getLookupManifest(scope);
		expect(JSON.stringify(manifest)).not.toContain("workbookDigest");
	},
);

it.each(["match", "revoked", "wrong-target"] as const)(
	"transfers the selected assigned source only with its current scoped principals and worker restores (%s)",
	async (mode) => {
		const admin = { ...scope, role: "owner" } as const;
		const source = {
			...table,
			rows: [{ name: "North" }, { name: "North" }, { name: "South" }],
		};
		const { tableId } = await makeManagedCopy(h, admin, source, origin);
		const [ada, bea] = [asUuid(v7()), asUuid(v7())];
		const appId = "source-assignments";
		await h.seedAppWithBlueprint(
			{
				...canonicalTestBlueprint(appId),
				personas: {
					[ada]: { uuid: ada, name: "Worker" },
					[bea]: { uuid: bea, name: "Worker" },
				},
				personaOrder: [ada, bea],
			},
			{ id: appId, owner: scope.actorId, projectId: scope.projectId },
		);
		const users = [
			{ id: "mobile-ada", username: "ada@clinic.commcarehq.org", uuid: ada },
			{ id: "mobile-bea", username: "bea@clinic.commcarehq.org", uuid: bea },
		];
		for (const domain of ["clinic", "nearby"]) {
			const d = await sql<{
				id: string;
			}>`INSERT INTO app_deployments(app_id,project_id,server,domain,state,created_by) VALUES (${appId},${scope.projectId},'india',${domain},'preflight',${scope.actorId}) RETURNING id`.execute(
				h.db(),
			);
			for (const u of users)
				await sql`INSERT INTO app_deployment_resources(deployment_id,kind,nova_resource_id,remote_id,pushed_identity,ownership) VALUES (${d.rows[0].id},'worker',${u.uuid},${(domain === "nearby") === (mode === "wrong-target") ? u.id : "unrelated-" + u.id},${u.username},'nova-created')`.execute(
					h.db(),
				);
		}
		const book = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(
			book,
			XLSX.utils.aoa_to_sheet([
				["Delete(Y/N)", "table_id", "is_global?", "field 1"],
				["N", source.tag, "no", "name"],
			]),
			"types",
		);
		XLSX.utils.book_append_sheet(
			book,
			XLSX.utils.aoa_to_sheet([
				["UID", "Delete(Y/N)", "field: name", "user 1"],
				...hqRowsOf(source).map((row, i) => [
					row.id,
					"N",
					source.rows[i].name,
					i === 1 ? "bea" : "ada",
				]),
			]),
			source.tag,
		);
		const bytes = XLSX.write(book, {
			bookType: "xlsx",
			type: "buffer",
		}) as Buffer;
		const review = await readManagedTableReview(scope.projectId, tableId);
		if (!review) throw new Error("Expected a source table");
		expect(
			await manageLookupTableInNova(admin, tableId, review.reviewDigest, grant),
		).toMatchObject({ ok: false, reason: "unsupported" });
		const outcome = await withHttpPeer(async (peer) => {
			const host = "https://india.commcarehq.org";
			serveTableList(peer, "clinic", [source]);
			serveRows(peer, "clinic", source);
			if (mode === "match") serveRows(peer, "clinic", source);
			const api = peer.get(host);
			api
				.intercept({
					method: "GET",
					path: "/a/clinic/api/lookup_table/v1/" + source.id + "/",
				})
				.reply(200, {
					id: source.id,
					tag: source.tag,
					is_global: false,
					item_attributes: [],
					fields: [{ field_name: "name", properties: [] }],
				})
				.persist();
			api
				.intercept({
					method: "GET",
					path: /^\/a\/clinic\/api\/bulk-user\/v1\//,
				})
				.reply(200, { objects: users })
				.persist();
			const restore = (
				name: string,
				id: string,
				mobile: boolean,
				rows: string[],
			) =>
				'<OpenRosaResponse xmlns="http://openrosa.org/http/response"><message nature="ota_restore_success"/><Sync xmlns="http://commcarehq.org/sync"><restore_id>fresh</restore_id></Sync><Registration xmlns="http://openrosa.org/user/registration"><username>' +
				name +
				"</username><uuid>" +
				id +
				'</uuid><user_data><data key="commcare_user_type">' +
				(mobile ? "commcare" : "web") +
				'</data><data key="commcare_project">clinic</data></user_data></Registration><fixture user_id="' +
				id +
				'" id="item-list:district"><district_list>' +
				rows
					.map((val) => "<district><name>" + val + "</name></district>")
					.join("") +
				"</district_list></fixture></OpenRosaResponse>";
			if (mode !== "wrong-target") {
				api
					.intercept({
						method: "GET",
						path: "/a/clinic/phone/restore/?overwrite_cache=true",
					})
					.reply(200, restore("account", "web-account", false, []));
				for (const [i, u] of users.entries()) {
					if (mode === "revoked" && i === 1) continue;
					const route = new URLSearchParams({
						as: u.username,
						overwrite_cache: "true",
					});
					api
						.intercept({
							method: "GET",
							path: "/a/clinic/phone/restore/?" + route,
						})
						.reply(
							200,
							restore(
								u.username.split("@")[0],
								u.id,
								true,
								i === 1
									? ["North"]
									: mode === "revoked"
										? ["North"]
										: ["North", "South"],
							),
						)
						.persist();
				}
			}
			return await manageLookupTableInNova(
				admin,
				tableId,
				review.reviewDigest,
				grant,
				bytes,
			);
		});
		const saved = await h
			.db()
			.selectFrom("lookup_tables")
			.select(["hq_taken_over_at", "worker_access"])
			.where("id", "=", tableId)
			.executeTakeFirstOrThrow();
		if (mode !== "match") {
			expect(outcome).toMatchObject({ ok: false });
			expect(saved.hq_taken_over_at).toBeNull();
			return;
		}
		expect(outcome).toMatchObject({ ok: true });
		expect(saved.worker_access).toBe("assigned");
		const actual = await sql<{
			row: string;
			persona: string;
		}>`SELECT r.hq_row_id "row",a.principal_id persona FROM lookup_rows r JOIN lookup_row_assignments a ON (a.project_id,a.table_id,a.row_id)=(r.project_id,r.table_id,r.id) WHERE r.table_id=${tableId} ORDER BY r.order_key`.execute(
			h.db(),
		);
		expect(actual.rows).toEqual(
			hqRowsOf(source).map((row, i) => ({
				row: row.id,
				persona: i === 1 ? bea : ada,
			})),
		);
		const predicted = await readWorkerLookupProjection(
			{
				scope: {
					projectId: scope.projectId,
					appId,
					actorUserId: scope.actorId,
				},
				grant,
				personaUuid: bea,
			},
			[tableId],
		);
		expect(predicted.rowsByTable.get(tableId)).toHaveLength(1);
	},
);
