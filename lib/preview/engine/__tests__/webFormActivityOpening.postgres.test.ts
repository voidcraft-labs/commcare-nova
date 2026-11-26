/** Exercise the authorized opening, receipt-bound submit and worker restore
 * watermark with two Project members and one newcomer. */
import { afterEach, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { submitFormAction } from "../caseDataBinding";
import { blueprintRevisionDigest } from "../caseDataBindingClient";
import { readFormOpeningAction } from "../formOpeningAction";
import { resolveAuthorizedPreviewContext } from "../previewAuthorization";
import { androidDevice, webAppsDevice } from "./fixtures/previewDevices";

const member = vi.hoisted(() => ({ id: "activity-first" }));
vi.mock("@/lib/auth-utils", async (original) => ({
	...(await original<typeof import("@/lib/auth-utils")>()),
	getSession: async () => ({
		user: {
			id: member.id,
			name: member.id,
			email: `${member.id}@example.invalid`,
		},
		session: { id: `${member.id}-session` },
	}),
}));
const h = setupAppStateTestDb("web_form_activity_", { authSchema: "migrated" });

afterEach(() => vi.unstubAllEnvs());

it("shows a submission only to a worker with an earlier restore and keeps receipt retries idempotent", async () => {
	const projectId = "activity-project";
	const first = "activity-first";
	const second = "activity-second";
	const newcomer = "activity-newcomer";
	vi.stubEnv("BETTER_AUTH_SECRET", "synthetic web activity test secret");
	for (const actor of [first, second, newcomer]) {
		await h.seedProjectMember(actor, projectId, "editor");
		await h.pool().query(
			`INSERT INTO auth_session (id, "userId", token, "createdAt", "updatedAt", "expiresAt")
			VALUES ($1, $2, $1, now(), now(), now() + interval '1 day')`,
			[`${actor}-session`, actor],
		);
	}
	const form = testUuid("activity-form");
	const module = testUuid("activity-module");
	const key = testUuid("activity-key-field");
	const title = testUuid("activity-title-field");
	const record = testUuid("activity-record-field");
	const window = testUuid("activity-window-field");
	const doc = buildDoc({
		modules: [
			{
				uuid: module,
				name: "Visits",
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "survey",
						fields: [
							{
								uuid: record,
								kind: "hidden",
								id: "record",
								calculate: "'Northern clinic'",
							},
							{
								uuid: key,
								kind: "text",
								id: "key",
								label: {
									parts: [
										{ kind: "text", text: "Visit " },
										{ kind: "field-ref", uuid: record },
									],
								},
							},
							{
								uuid: title,
								kind: "text",
								id: "title",
								label: { parts: [{ kind: "field-ref", uuid: record }] },
							},
							{ uuid: window, kind: "text", id: "window", label: "90" },
						],
					},
				],
			},
		],
	});
	doc.forms[form] = {
		...doc.forms[form],
		activityKeyText: { carrier: { field: key, role: "field-label" } },
		activityTitleText: { carrier: { field: title, role: "field-label" } },
		activityWindowText: { carrier: { field: window, role: "field-label" } },
	};
	const app = await h.seedAppWithBlueprint(doc, { owner: first, projectId });
	const web = webAppsDevice();
	member.id = first;
	const context = await resolveAuthorizedPreviewContext({
		appId: app,
		device: web,
		loadBlueprint: true,
		required: "view",
	});
	if (context.kind !== "ready" || !context.blueprint)
		throw new Error("The synthetic Project could not load its activity form");
	const blueprintDigest = await blueprintRevisionDigest(
		hydratePersistedBlueprint(context.blueprint),
	);
	const android = androidDevice();
	const open = async (actor: string, entry: string, device = web) => {
		member.id = actor;
		const opened = await readFormOpeningAction(
			{ app, module, form, blueprintDigest, run: testUuid(actor), entry },
			device,
		);
		if (opened.kind !== "opening")
			throw new Error(`The activity visit could not open: ${opened.kind}`);
		return opened;
	};
	const entry = testUuid("activity-first-open");
	const left = await open(first, entry);
	expect(left.activityNotice).toBeUndefined();
	expect(left.projection.webActivity).toMatchObject({
		title: "Northern clinic",
		windowSeconds: 90,
	});
	expect(
		(await open(second, testUuid("activity-android"), android)).activityNotice,
	).toBeUndefined();
	expect(
		(await open(second, testUuid("activity-second-open"))).activityNotice,
	).toMatchObject({
		workerName: first,
		title: "Northern clinic",
		kind: "opened",
		dataMayHaveChanged: false,
	});

	member.id = first;
	const mutation = {
		kind: "survey" as const,
		formUuid: form,
		entryKey: entry,
		attachmentRefs: [],
		operationAnswers: { root: [], repeats: [] },
		formOpening: { run: testUuid(first), module, evidence: left.evidence },
	};
	const submit = () =>
		submitFormAction(
			mutation,
			app,
			blueprintDigest,
			undefined,
			undefined,
			undefined,
			web,
		);
	member.id = second;
	expect((await submit()).kind).toBe("error");
	member.id = first;
	expect((await submit()).kind).toBe("survey");
	const event = () =>
		h
			.pool()
			.query(
				"SELECT kind, event_at FROM public.preview_form_activity WHERE app_id = $1",
				[app],
			);
	const saved = await event();
	expect(saved.rows).toEqual([
		{ kind: "submitted", event_at: expect.any(Date) },
	]);
	expect((await submit()).kind).toBe("survey");
	expect((await event()).rows).toEqual(saved.rows);

	const notice = (await open(second, testUuid("activity-second-after-submit")))
		.activityNotice;
	expect(notice).toMatchObject({
		workerName: first,
		title: "Northern clinic",
		kind: "submitted",
		dataMayHaveChanged: true,
	});
	expect(
		(await open(newcomer, testUuid("activity-new-worker"))).activityNotice,
	).toBeUndefined();
	expect((await event()).rows).toEqual(saved.rows);
});
