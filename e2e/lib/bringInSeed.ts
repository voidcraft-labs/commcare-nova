/**
 * The people, Projects and apps the bring-in journeys start from.
 *
 * An owner has three Projects: A, their personal one and the one the tab is
 * looking at, B and an empty C, and a CommCare HQ connection. One app is
 * brought in to A and one to B through the production read and birth
 * (`readHqAppForReview` and `createFromReview`), over the create tests'
 * controlled source with CommCare HQ answered from the proof lane's retained
 * answers, so each is exactly what a person bringing it in gets. Each is a
 * CommCare HQ app of its own: one HQ app is published to by one Nova app, in
 * every Project at once. A's editor is the scenario's second member, and a
 * third person views A and edits B.
 *
 * Every attempt brings its apps in to its own Projects, and each reads a
 * CommCare HQ app no other attempt reads. The journeys answer the routes
 * that read CommCare HQ from `page.route` with what these births answered.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { getAuthDb } from "@/lib/auth/db";
import type { AdoptedAppReceipt } from "@/lib/db/appGenesis";
import type { ReadingAnswer, ReadingKey } from "@/lib/deployment";
import {
	changedAnswer,
	counterOf,
	createInputFor,
	FIXTURE_DOMAIN,
	FIXTURE_PATHS,
	FIXTURE_REMOTE_APP_ID,
	FIXTURE_SERVER,
	fixtureResource,
	fixtureSource,
	reviewOf,
	seedFixtureConnection,
	serveAnswer,
	serveFixtureTables,
} from "@/lib/deployment/reading/__tests__/adoptionFixture";
import { createFromReview } from "@/lib/deployment/reading/create";
import {
	authorizeBringIn,
	readHqAppForReview,
} from "@/lib/deployment/reading/read";
import { buildSessionStorageState } from "./session";

export const BRING_IN_SEED = {
	projectB: "Smoke bring in B",
	projectC: "Smoke bring in C",
	thirdUserName: "Smoke Third Person",
} as const;

/** One app brought in, and what its read and its create answered. */
export interface BroughtInApp {
	readonly appId: string;
	/** The app's name, as the review proposed it and the create kept it. */
	readonly appName: string;
	/** The name of the app's first menu. */
	readonly menuName: string;
	/** What the read was asked for. */
	readonly key: ReadingKey;
	/** What the read answered. */
	readonly review: Extract<ReadingAnswer, { kind: "review" }>;
	/** What the create answered. */
	readonly receipt: AdoptedAppReceipt;
}

/** What `seedBringIn` writes and hands the journeys. */
export interface BringInScenario {
	readonly projects: {
		readonly a: { readonly id: string; readonly name: string };
		readonly b: { readonly id: string; readonly name: string };
		readonly c: { readonly id: string; readonly name: string };
	};
	readonly apps: { readonly a: BroughtInApp; readonly b: BroughtInApp };
	/** The owner's name, as the Publishing card says who brought an app in. */
	readonly ownerName: string;
	/** The person who views A and edits B, signed in. */
	readonly third: {
		readonly id: string;
		readonly storageState: ReturnType<typeof buildSessionStorageState>;
	};
}

/** The auth adapter's one call this seed uses. */
interface AuthAdapter {
	create<T, R = T>(args: {
		model: string;
		forceAllowId?: boolean;
		data: Record<string, unknown>;
	}): Promise<R>;
}

/** A shared Project the owner owns. */
async function ownedProject(
	adapter: AuthAdapter,
	ownerId: string,
	name: string,
): Promise<{ readonly id: string; readonly name: string }> {
	const now = new Date();
	const project = await adapter.create<never, { id: string }>({
		model: "organization",
		data: {
			name,
			slug: `bring-in-${randomUUID()}`,
			logo: null,
			metadata: JSON.stringify({ personal: false }),
			createdAt: now,
		},
	});
	await adapter.create({
		model: "member",
		data: {
			organizationId: project.id,
			userId: ownerId,
			role: "owner",
			createdAt: now,
		},
	});
	return { id: project.id, name };
}

/**
 * The fixture app brought in by `actorUserId` to `projectId` as a CommCare HQ
 * app of its own: the create tests' controlled source under a fresh HQ app
 * id, read to a review and created as the review offers it.
 *
 * The stored CommCare HQ key is decrypted at the Cloud KMS client, the one
 * boundary of the read that is no CommCare HQ request. The seed has no KMS,
 * so for the length of this call that client's `decrypt` answers the key
 * itself, as the create tests' controlled `decrypt` does, and nothing leaves
 * the process.
 */
async function bringInFixtureApp(input: {
	readonly projectId: string;
	readonly actorUserId: string;
}): Promise<BroughtInApp> {
	await seedFixtureConnection(input.actorUserId);
	const actor = await authorizeBringIn(input.actorUserId, input.projectId);
	if (actor === null)
		throw new Error(
			"The bring-in seed brings an app in as a member who may edit the Project, and this person may not.",
		);
	const remoteAppId = randomBytes(16).toString("hex");
	const key: ReadingKey = {
		projectId: input.projectId,
		server: FIXTURE_SERVER,
		domain: FIXTURE_DOMAIN,
		remoteAppId,
	};
	const at = (path: string) => path.replace(FIXTURE_REMOTE_APP_ID, remoteAppId);
	const resource = changedAnswer(fixtureResource(fixtureSource()), (body) => ({
		...body,
		id: remoteAppId,
	}));
	const kms = KeyManagementServiceClient.prototype;
	const decrypt = kms.decrypt;
	kms.decrypt = (async () => [
		{ plaintext: Buffer.from("bring-in-seed-key", "utf8") },
	]) as unknown as typeof decrypt;
	try {
		return await withHttpPeer(async (peer) => {
			/* One read for the review, and the create's own read. */
			serveAnswer(peer, at(FIXTURE_PATHS.application), resource, 2);
			serveAnswer(peer, at(FIXTURE_PATHS.source), fixtureSource(), 2);
			serveAnswer(peer, at(FIXTURE_PATHS.version), counterOf(resource), 2);
			serveFixtureTables(peer, 2);
			const review = reviewOf(
				await readHqAppForReview(actor, key, { onEvent: () => {} }),
			);
			const answer = await createFromReview(
				actor,
				createInputFor(key, review),
				{ onEvent: () => {} },
			);
			if (answer.kind !== "created")
				throw new Error(
					`The bring-in seed's create answered ${answer.kind}: ${JSON.stringify(answer)}`,
				);
			const { receipt } = answer;
			const firstMenu = receipt.blueprint.moduleOrder[0];
			const menuName =
				firstMenu === undefined
					? undefined
					: receipt.blueprint.modules[firstMenu]?.name;
			if (menuName === undefined)
				throw new Error("The bring-in seed's app came in with no menu.");
			return {
				appId: receipt.appId,
				appName: receipt.blueprint.appName,
				menuName,
				key,
				review,
				receipt,
			};
		});
	} finally {
		kms.decrypt = decrypt;
	}
}

/**
 * Writes the scenario: Projects B and C beside the owner's own A, the two
 * apps, the editor of A, and the third person with their session. A is the
 * owner's personal Project, which their session resolves to.
 */
export async function seedBringIn(input: {
	readonly adapter: AuthAdapter;
	readonly secret: string;
	readonly baseUrl: string;
	readonly owner: { readonly id: string; readonly name: string };
	/** The owner's personal Project. */
	readonly projectA: { readonly id: string; readonly name: string };
	/** The scenario's second member, a viewer of A until this makes them its editor. */
	readonly editorId: string;
}): Promise<BringInScenario> {
	const { adapter, owner, projectA } = input;
	const projectB = await ownedProject(
		adapter,
		owner.id,
		BRING_IN_SEED.projectB,
	);
	const projectC = await ownedProject(
		adapter,
		owner.id,
		BRING_IN_SEED.projectC,
	);

	await (await getAuthDb())
		.updateTable("auth_member")
		.set({ role: "editor" })
		.where("userId", "=", input.editorId)
		.where("organizationId", "=", projectA.id)
		.executeTakeFirstOrThrow();

	/* The third person's session names A as its active Project, so they hold
	 * no personal Project and edit B alone. */
	const now = new Date();
	const thirdId = `third-${randomUUID()}`;
	const token = randomBytes(32).toString("hex");
	await adapter.create({
		model: "user",
		forceAllowId: true,
		data: {
			id: thirdId,
			name: BRING_IN_SEED.thirdUserName,
			email: `${thirdId}@dimagi.com`,
			emailVerified: true,
			image: null,
			role: "user",
			banned: false,
			createdAt: now,
			updatedAt: now,
			lastActiveAt: now,
		},
	});
	for (const [organizationId, role] of [
		[projectA.id, "viewer"],
		[projectB.id, "editor"],
	] as const) {
		await adapter.create({
			model: "member",
			data: { organizationId, userId: thirdId, role, createdAt: now },
		});
	}
	await adapter.create({
		model: "session",
		data: {
			token,
			userId: thirdId,
			expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
			createdAt: now,
			updatedAt: now,
			ipAddress: "",
			userAgent: "smoke-test-third",
			activeOrganizationId: projectA.id,
		},
	});

	const appA = await bringInFixtureApp({
		projectId: projectA.id,
		actorUserId: owner.id,
	});
	const appB = await bringInFixtureApp({
		projectId: projectB.id,
		actorUserId: owner.id,
	});
	return {
		projects: { a: projectA, b: projectB, c: projectC },
		apps: { a: appA, b: appB },
		ownerName: owner.name,
		third: {
			id: thirdId,
			storageState: buildSessionStorageState({
				token,
				secret: input.secret,
				baseUrl: input.baseUrl,
			}),
		},
	};
}
