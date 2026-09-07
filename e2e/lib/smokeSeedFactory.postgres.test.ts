import { betterAuth } from "better-auth";
import { expect, it } from "vitest";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { withProjectContext } from "@/lib/case-store";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { listApps, softDeleteApp } from "@/lib/db/apps";
import {
	getLookupManifest,
	getLookupTable,
	updateLookupTableName,
} from "@/lib/lookup/service";
import { createSmokeBuilders } from "./smokeSeedFactory";

const h = setupAppStateTestDb("smoke_fixture_", {
	authSchema: "migrated",
	poolMax: 4,
});
it("separate scenario attempts preserve each other's sessions, memberships, app lists, cases and lookup data", async () => {
	const secret = "smoke-isolation-test-secret-32-characters";
	const baseUrl = "http://localhost:3000";
	const auth = betterAuth({
		...authMigrateOptions(h.pool()),
		secret,
		baseURL: baseUrl,
	});
	const environment = {
		pool: h.pool(),
		ctx: await auth.$context,
		secret,
		baseUrl,
	};
	const [a, b] = await Promise.all([
		createSmokeBuilders(environment),
		createSmokeBuilders(environment),
	]);
	const [left, right] = await Promise.all([
		a.builders.workspace(),
		b.builders.workspace(),
	]);
	// Concurrent factories exercise the real pending-index drain. No successful
	// setup may leave a durable pending marker or an invalid expression index.
	expect(
		(
			await h
				.pool()
				.query(
					"SELECT app_id FROM case_type_schemas WHERE app_id = ANY($1::text[]) AND index_pending_seq IS NOT NULL",
					[[left.caseWorkspace.appId, right.caseWorkspace.appId]],
				)
		).rows,
	).toEqual([]);
	expect(
		(
			await h
				.pool()
				.query(
					"SELECT indexrelid FROM pg_index WHERE indrelid = 'cases'::regclass AND NOT indisvalid",
				)
		).rows,
	).toEqual([]);
	expect(a.common.userId).not.toBe(b.common.userId);
	expect(a.common.projectId).not.toBe(b.common.projectId);
	expect(left.caseWorkspace.appId).not.toBe(right.caseWorkspace.appId);
	expect(
		left.caseWorkspace.caseIds.some((id) =>
			right.caseWorkspace.caseIds.includes(id),
		),
	).toBe(false);
	const scope = (common: typeof a.common) => ({
		projectId: common.projectId,
		actorId: common.userId,
		role: "owner" as const,
	});
	const [leftManifest, rightManifest] = await Promise.all([
		getLookupManifest(scope(a.common)),
		getLookupManifest(scope(b.common)),
	]);
	expect(leftManifest.tables).toHaveLength(2);
	expect(rightManifest.tables).toHaveLength(2);
	expect(
		leftManifest.tables.some((table) =>
			rightManifest.tables.some((other) => other.id === table.id),
		),
	).toBe(false);
	const rightRows = await Promise.all(
		rightManifest.tables.map((table) =>
			getLookupTable(scope(b.common), table.id),
		),
	);
	const leftCases = await withProjectContext(
		a.common.projectId,
		a.common.userId,
		a.common.userId,
	);
	const rightCases = await withProjectContext(
		b.common.projectId,
		b.common.userId,
		b.common.userId,
	);
	const rightQuery = {
		appId: right.caseWorkspace.appId,
		caseType: right.caseWorkspace.caseType,
	};
	const originalCases = await rightCases.query(rightQuery);
	expect(originalCases).toHaveLength(right.caseWorkspace.caseCount);
	const pagination = { limit: 50, sort: "updated_desc" as const };
	const originalApps = await listApps(b.common.projectId, pagination);
	const sessionHeaders = (common: typeof a.common) =>
		new Headers({
			cookie: common.storageState.cookies
				.map((cookie) => `${cookie.name}=${cookie.value}`)
				.join("; "),
		});
	const originalSession = await auth.api.getSession({
		headers: sessionHeaders(b.common),
	});
	expect(originalSession?.user.id).toBe(b.common.userId);
	const originalMembership = await h
		.pool()
		.query('SELECT * FROM auth_member WHERE "userId" = $1 ORDER BY id', [
			b.common.viewerUserId,
		]);
	const destination = await a.builders.move();
	await Promise.all([
		leftCases.update({
			appId: left.caseWorkspace.appId,
			caseId: left.caseWorkspace.caseIds[0],
			patch: { case_name: "Changed by another scenario" },
		}),
		updateLookupTableName(scope(a.common), {
			tableId: leftManifest.tables[0].id,
			expectedTableRevision: leftManifest.tables[0].tableRevision,
			name: "Changed table",
		}),
		environment.ctx.adapter.update({
			model: "session",
			where: [{ field: "userId", value: a.common.userId }],
			update: { activeOrganizationId: destination.moveDestinationProjectId },
		}),
		h
			.pool()
			.query(
				'UPDATE auth_member SET role = $1 WHERE "userId" = $2 AND "organizationId" = $3',
				["editor", a.common.viewerUserId, a.common.projectId],
			),
	]);
	await softDeleteApp(left.caseWorkspace.appId, a.common.userId);
	expect(await listApps(b.common.projectId, pagination)).toEqual(originalApps);
	expect(await rightCases.query(rightQuery)).toEqual(originalCases);
	expect(await getLookupManifest(scope(b.common))).toEqual(rightManifest);
	expect(
		await Promise.all(
			rightManifest.tables.map((table) =>
				getLookupTable(scope(b.common), table.id),
			),
		),
	).toEqual(rightRows);
	expect(
		await auth.api.getSession({ headers: sessionHeaders(b.common) }),
	).toEqual(originalSession);
	expect(
		(
			await h
				.pool()
				.query('SELECT * FROM auth_member WHERE "userId" = $1 ORDER BY id', [
					b.common.viewerUserId,
				])
		).rows,
	).toEqual(originalMembership.rows);
	// Positive controls: the first scenario really changed, and each cookie still identifies its owner.
	expect(await getLookupManifest(scope(a.common))).not.toEqual(leftManifest);
	expect(
		(await h.readAppRow(left.caseWorkspace.appId))?.deleted_at,
	).not.toBeNull();
	expect(
		(await auth.api.getSession({ headers: sessionHeaders(a.common) }))?.user.id,
	).toBe(a.common.userId);
	expect(
		(
			await h
				.pool()
				.query(
					'SELECT "activeOrganizationId" FROM auth_session WHERE "userId" = $1',
					[a.common.userId],
				)
		).rows,
	).toEqual([{ activeOrganizationId: destination.moveDestinationProjectId }]);
});
