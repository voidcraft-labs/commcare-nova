import { expect, it } from "vitest";
import { getAuthDb } from "@/lib/auth/db";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import { commitGuardedBatch, loadApp } from "@/lib/db/apps";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import {
	beginWork,
	discardWork,
	executeWorkTool,
	getWork,
	getWorkSnapshot,
	listWork,
	saveWork,
} from "../session";

const h = setupAppStateTestDb("ordinary_authoring_", {
	authSchema: "migrated",
	poolMax: 3,
});
const actorUserId = "ordinary-author";
const projectId = "ordinary-project";
const host = { kind: "mcp" } as const;
function pendingRevision(work: { revision: string | null }) {
	if (work.revision === null)
		throw new Error("Expected pending candidate revision");
	return work.revision;
}

async function existing() {
	await h.seedProjectMember(actorUserId, projectId, "owner");
	const app = await createExplicitBlankApp(
		actorUserId,
		projectId,
		crypto.randomUUID(),
		{ name: "Original", status: "complete" },
	);
	const work = await beginWork({
		actorUserId,
		projectId,
		host,
		target: { appId: app.appId },
		requestId: "open",
	});
	return { appId: app.appId, args: { actorUserId, host, workId: work.workId } };
}

it("constructs a named app privately through focused operations and publishes one valid first checkpoint", async () => {
	await h.seedProjectMember(actorUserId, projectId, "owner");
	const begun = await beginWork({
		actorUserId,
		projectId,
		host,
		target: { name: "Patient visits" },
		requestId: "open",
	});
	const args = { actorUserId, host, workId: begun.workId };
	expect(begun).toMatchObject({ appId: null });
	expect(await getWork(args)).toMatchObject({
		revision: null,
		pendingChanges: 0,
	});
	expect(
		await h.db().selectFrom("authoring_workspaces").select("id").execute(),
	).toEqual([]);
	const module = await executeWorkTool({
		...args,
		requestId: "module",
		toolName: "createModule",
		input: { name: "Patients", case_type: "patient" },
	});
	expect(module).toMatchObject({
		kind: "mutate",
		result: { ok: true, saved: false },
	});
	const incomplete = await getWork(args);
	expect(
		await saveWork({
			...args,
			requestId: "incomplete-save",
			expectedRevision: pendingRevision(incomplete),
		}),
	).toMatchObject({ saved: false });
	expect(await h.db().selectFrom("apps").select("id").execute()).toEqual([]);
	await executeWorkTool({
		...args,
		requestId: "form",
		toolName: "createForm",
		input: { moduleUuid: "Patients", name: "Register", type: "registration" },
	});
	const empty = await getWorkSnapshot(args);
	expect(
		empty.doc.fieldOrder[
			Object.keys(empty.doc.forms)[0] as keyof typeof empty.doc.fieldOrder
		],
	).toEqual([]);
	await executeWorkTool({
		...args,
		requestId: "fields",
		toolName: "addFields",
		input: {
			formUuid: "Register",
			fields: [{ kind: "text", id: "name", label: "Patient name" }],
		},
	});
	await executeWorkTool({
		...args,
		requestId: "name",
		toolName: "updateForm",
		input: { formUuid: "Register", recordName: "#form/name" },
	});
	const ready = await getWork(args);
	const saved = await saveWork({
		...args,
		requestId: "save",
		expectedRevision: pendingRevision(ready),
	});
	expect(saved).toMatchObject({
		saved: true,
		savedRevision: 1,
		revision: null,
	});
	const app = await loadApp(saved.appId as string);
	expect(app?.blueprint.appName).toBe("Patient visits");
	if (!app) throw new Error("Expected published app");
	expect(Object.keys(app.blueprint.modules)).toHaveLength(1);
	expect(
		await saveWork({
			...args,
			requestId: "save",
			expectedRevision: pendingRevision(ready),
		}),
	).toEqual(saved);
	expect(
		await beginWork({
			actorUserId,
			projectId,
			host,
			target: { name: "Patient visits" },
			requestId: "open",
		}),
	).toEqual(begun);
	await expect(
		saveWork({
			...args,
			requestId: "stale-published-token",
			expectedRevision: pendingRevision(incomplete),
		}),
	).rejects.toThrow(/changed/);
	expect(
		await executeWorkTool({
			...args,
			requestId: "module",
			toolName: "createModule",
			input: { name: "Patients", case_type: "patient" },
		}),
	).toEqual(module);
});

it("binds old retries to their candidate across discard and later checkpoints, and reauthorizes replay", async () => {
	const { appId, args } = await existing();
	const call = {
		...args,
		requestId: "rename",
		toolName: "updateApp",
		input: { name: "Private name" },
	};
	const first = await executeWorkTool(call);
	const pending = await getWork(args);
	const discarded = await discardWork({
		...args,
		requestId: "discard",
		expectedRevision: pendingRevision(pending),
	});
	await executeWorkTool({
		...args,
		requestId: "new-name",
		toolName: "updateApp",
		input: { name: "Saved name" },
	});
	const later = await getWork(args);
	expect(later.revision).not.toBe(pending.revision);
	expect(
		await discardWork({
			...args,
			requestId: "discard",
			expectedRevision: pendingRevision(pending),
		}),
	).toEqual(discarded);
	expect(await executeWorkTool(call)).toEqual(first);
	await expect(
		discardWork({
			...args,
			requestId: "old-token",
			expectedRevision: pendingRevision(pending),
		}),
	).rejects.toThrow(/changed/);
	await expect(
		executeWorkTool({ ...call, input: { name: "Different" } }),
	).rejects.toThrow(/different input/);
	await saveWork({
		...args,
		requestId: "save",
		expectedRevision: pendingRevision(later),
	});
	expect((await loadApp(appId))?.blueprint.appName).toBe("Saved name");
	await (await getAuthDb())
		.deleteFrom("auth_member")
		.where("userId", "=", actorUserId)
		.execute();
	await expect(executeWorkTool(call)).rejects.toThrow();
	await expect(getWork(args)).rejects.toThrow();
});

it("refuses stale saves without rebasing and isolates origins and owners", async () => {
	const { appId, args } = await existing();
	await executeWorkTool({
		...args,
		requestId: "rename",
		toolName: "updateApp",
		input: { name: "Private" },
	});
	const pending = await getWork(args);
	await commitGuardedBatch({
		appId,
		actorUserId,
		expectedProjectId: projectId,
		kind: "mcp",
		runId: "other-client",
		batchId: crypto.randomUUID(),
		mutations: admitMutationBatch([{ kind: "setAppName", name: "Concurrent" }]),
	});
	expect(await getWork(args)).toMatchObject({
		stale: true,
		revision: pending.revision,
	});
	expect(
		await saveWork({
			...args,
			requestId: "save",
			expectedRevision: pendingRevision(pending),
		}),
	).toMatchObject({ saved: false });
	expect((await loadApp(appId))?.blueprint.appName).toBe("Concurrent");
	expect((await getWorkSnapshot(args)).doc.appName).toBe("Private");
	await expect(
		getWork({ ...args, host: { kind: "chat", threadId: "foreign" } }),
	).rejects.toThrow();
	await h.seedProjectMember("co-owner", projectId, "owner");
	await expect(getWork({ ...args, actorUserId: "co-owner" })).rejects.toThrow();
});

it("lists accessible work when an older Project membership is revoked", async () => {
	const { args } = await existing();
	const otherProject = "remaining-project";
	await h.seedProjectMember(actorUserId, otherProject, "owner");
	const other = await beginWork({
		actorUserId,
		projectId: otherProject,
		host,
		target: { name: "Accessible" },
		requestId: "other",
	});
	await (await getAuthDb())
		.deleteFrom("auth_member")
		.where("userId", "=", actorUserId)
		.where("organizationId", "=", projectId)
		.execute();
	const listed = await listWork({ actorUserId, host });
	expect(listed.work.map((item) => item.workId)).toEqual([other.workId]);
	await expect(getWork(args)).rejects.toThrow();
});

it("retires an empty no-op candidate and creates the next edit on current saved state", async () => {
	const { appId, args } = await existing();
	const initial = await getWorkSnapshot(args);
	const formUuid = Object.keys(initial.doc.forms)[0];
	if (!formUuid) throw new Error("Expected the blank app form");
	const noop = {
		...args,
		requestId: "unchanged",
		toolName: "addFields",
		input: { formUuid, fields: [] },
	};
	const [receipt, concurrentReceipt] = await Promise.all([
		executeWorkTool(noop),
		executeWorkTool(noop),
	]);
	expect(concurrentReceipt).toEqual(receipt);
	expect(await getWork(args)).toMatchObject({
		pendingChanges: 0,
		revision: null,
	});
	await commitGuardedBatch({
		appId,
		actorUserId,
		expectedProjectId: projectId,
		kind: "mcp",
		runId: "other",
		batchId: crypto.randomUUID(),
		mutations: admitMutationBatch([{ kind: "setAppName", name: "Concurrent" }]),
	});
	await executeWorkTool({
		...args,
		requestId: "next",
		toolName: "updateApp",
		input: { name: "Next" },
	});
	const pending = await getWork(args);
	expect(pending.stale).toBe(false);
	const saved = await saveWork({
		...args,
		requestId: "save",
		expectedRevision: pendingRevision(pending),
	});
	expect(saved.saved).toBe(true);
	await expect(
		saveWork({
			...args,
			requestId: "stale-after-save",
			expectedRevision: pendingRevision(pending).replace(/:\d+$/, ":0"),
		}),
	).rejects.toThrow(/changed/);
	expect(await executeWorkTool(noop)).toEqual(receipt);
	expect((await loadApp(appId))?.blueprint.appName).toBe("Next");
});

it("isolates external identities between works and recovers a committed organization receipt before pending-work policy", async () => {
	const { appId, args } = await existing();
	const levelUuid = crypto.randomUUID();
	await executeWorkTool({
		...args,
		requestId: "levels",
		toolName: "addOrganizationLevels",
		input: {
			levels: [
				{
					uuid: levelUuid,
					code: "clinic",
					name: "Clinic",
					description: null,
					caseFlow: {
						workers: "assigned",
						ownsCases: true,
						descendantCases: { kind: "none" },
					},
					addressBook: { reach: "own-branch" },
				},
			],
		},
	});
	await saveWork({
		...args,
		requestId: "save-levels",
		expectedRevision: pendingRevision(await getWork(args)),
	});
	const second = await beginWork({
		actorUserId,
		projectId,
		host,
		target: { appId },
		requestId: "second-work",
	});
	const other = { ...args, workId: second.workId };
	const location = (name: string, expectedRevision: string) => ({
		levelUuid,
		name,
		expectedRevision,
		parentId: null,
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
	});
	const first = await executeWorkTool({
		...args,
		requestId: "create-place",
		toolName: "createLocation",
		input: location("North", "0"),
	});
	const secondResult = await executeWorkTool({
		...other,
		requestId: "create-place",
		toolName: "createLocation",
		input: location("South", "1"),
	});
	expect(first).toMatchObject({
		kind: "read",
		data: { location: { name: "North" } },
	});
	expect(secondResult).toMatchObject({
		kind: "read",
		data: { location: { name: "South" } },
	});
	const lostCall = {
		...other,
		requestId: "lost-response",
		toolName: "createLocation",
		input: location("East", "2"),
	};
	await h
		.pool()
		.query(
			`CREATE FUNCTION fail_work_response() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id = 'lost-response' AND NEW.result_json IS NOT NULL THEN RAISE EXCEPTION 'lost work response'; END IF; RETURN NEW; END $$`,
		);
	await h
		.pool()
		.query(
			`CREATE TRIGGER fail_work_response BEFORE UPDATE ON authoring_session_requests FOR EACH ROW EXECUTE FUNCTION fail_work_response()`,
		);
	try {
		await expect(executeWorkTool(lostCall)).rejects.toThrow(
			"lost work response",
		);
	} finally {
		await h
			.pool()
			.query("DROP TRIGGER fail_work_response ON authoring_session_requests");
		await h.pool().query("DROP FUNCTION fail_work_response()");
	}
	const east = await h
		.db()
		.selectFrom("app_locations")
		.select("id")
		.where("app_id", "=", appId)
		.where("name", "=", "East")
		.executeTakeFirstOrThrow();
	await executeWorkTool({
		...other,
		requestId: "pending",
		toolName: "updateApp",
		input: { name: "Pending rename" },
	});
	const pending = await getWork(other);
	expect(pending.pendingChanges).toBeGreaterThan(0);
	const recovered = await executeWorkTool(lostCall);
	expect(recovered).toMatchObject({
		kind: "read",
		data: { location: { id: east.id, name: "East" }, revision: "3" },
	});
	expect((await getWork(other)).revision).toBe(pending.revision);
	expect(
		await h
			.db()
			.selectFrom("app_locations")
			.select("id")
			.where("app_id", "=", appId)
			.execute(),
	).toHaveLength(3);
	await expect(
		executeWorkTool({
			...other,
			requestId: "new-place",
			toolName: "createLocation",
			input: location("West", "3"),
		}),
	).rejects.toThrow(/Save/);
});
