/**
 * Two-user shared-Project fixture for the multiplayer E2E (`multiplayer.spec.ts`).
 *
 * Seeds the minimum a real-time co-editing test needs, all into the local
 * Postgres only (the caller — `e2e/seed.ts` — enforces the `NOVA_DB_LOCAL_URL`
 * guard before calling in):
 *
 *   1. Two `auth_user` rows (Ada, Grace) + one live `auth_session` each,
 *      through Better Auth's own adapter.
 *   2. One SHARED Project (`auth_organization`) with BOTH users as members —
 *      Ada `owner`, Grace `editor` — so each holds the `edit` app capability on
 *      it (`lib/auth/projectRoles.ts`). Written through the same adapter, so a
 *      later Better Auth schema change surfaces here, not as a Playwright
 *      timeout.
 *   3. One `complete` app whose `project_id` IS that shared Project, carrying a
 *      populated blueprint (one survey module → one survey form → one text
 *      field) with a FIXED module uuid. Because the build page authorizes
 *      purely on the app's own `project_id` + `auth_member` (no "active
 *      Project" gate — `resolveAppAccess`), both members open + co-edit it.
 *      `status: "complete"` is required or `/build/{id}` redirects to `/`.
 *
 * Emits two Playwright `storageState` files (one signed session cookie per
 * user) and a manifest the spec reads for the concrete ids it navigates to and
 * asserts against.
 *
 * The app is created empty (`createApp`) then given its populated fixed-uuid
 * blueprint via `appendSyntheticBatch` — a plain at-rest `complete` app with no
 * run-liveness markers, exactly what two collaborators open.
 */

import { randomBytes } from "node:crypto";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { appendSyntheticBatch, createApp } from "@/lib/db/apps";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import { buildSessionStorageState } from "./session";

/**
 * The Better Auth adapter context (`await auth.$context`). Typed minimally to
 * just the `adapter.create` this helper uses, so it doesn't depend on Better
 * Auth's fully-parameterized `Auth<Options>` generic (which the seed's concrete
 * instance widens differently). `create` returns the created row; the two calls
 * that read the id (`organization`) narrow the generic here.
 */
interface AuthContext {
	adapter: {
		create<T, R = T>(args: {
			model: string;
			forceAllowId?: boolean;
			data: Record<string, unknown>;
		}): Promise<R>;
	};
}

/**
 * Stable identifiers the spec asserts against (mirrors the SEED pattern). Every
 * uuid is FIXED so every user deep-links to the same entity and the spec targets
 * it without a doc round-trip. The app is deliberately RICH enough to exercise
 * the whole multiplayer matrix from ONE fixture:
 *   - module 1 "Intake" (survey) with THREE fields (two text + one single_select
 *     with options) → disjoint-edit merge (A edits field 1, B edits field 2),
 *     field reorder, option edits, and live-highlight (select a field);
 *   - module 2 "Follow-up" (survey, one field) → follow / cross-screen presence.
 *
 * FOUR members share the Project (Ada owner; Grace, Katherine, Alan editors)
 * — the four-user storm scenarios need four concurrent writers, and the
 * quadrant watch/manual modes tile one window per member. The user ids are
 * chosen so all four hash to DISTINCT palette hues (periwinkle / lavender /
 * iris / violet), and two carry profile photos while two don't, so a session
 * always shows both presence-avatar paths.
 */
export const MP_SEED = {
	userA: {
		id: "mp-user-ada", // palette: periwinkle
		email: "ada@dimagi.com",
		name: "Ada Lovelace",
		image:
			"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='%234c1d95'/><circle cx='32' cy='25' r='11' fill='%23ddd6fe'/><path d='M10 64a22 15 0 0 1 44 0z' fill='%23ddd6fe'/></svg>",
	},
	userB: {
		id: "mp-user-grace", // palette: lavender
		email: "grace@dimagi.com",
		name: "Grace Hopper",
		image: null,
	},
	userC: {
		id: "mp-user-katherine-g", // palette: iris
		email: "katherine@dimagi.com",
		name: "Katherine Johnson",
		image:
			"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='%23713f12'/><circle cx='32' cy='25' r='11' fill='%23fef3c7'/><path d='M10 64a22 15 0 0 1 44 0z' fill='%23fef3c7'/></svg>",
	},
	userD: {
		id: "mp-user-alan", // palette: violet
		email: "alan@dimagi.com",
		name: "Alan Turing",
		image: null,
	},
	/** The shared Project all four users co-own/edit. */
	projectName: "Multiplayer Test Project",
	appName: "Multiplayer — Co-Edit Me",

	/* Entity uuids are FIXED (deep-linkable, greppable in traces) but REAL
	 * v4 literals, exactly the shape production mints — a watch/manual
	 * session's URLs look like any real app's, with no fixture-flavored
	 * `mp-` vocabulary leaking into a demo. The named constants + labels
	 * carry the readability instead. */

	/** Module 1 — the survey both users co-edit (rename + field edits + reorder). */
	moduleUuid: "7f9d3b2a-4c61-4e8f-9a05-1b2c3d4e5f60",
	moduleName: "Intake",
	formUuid: "2a8e5c17-93d4-42b6-8f1e-6a7b8c9d0e1f",
	formName: "Registration",
	/** Field 1 (text) — A renames its label; B observes it live. */
	fieldOneUuid: "c4b1d9e6-7a25-4f38-b06c-2d3e4f5a6b7c",
	fieldOneLabel: "Full name",
	/** Field 2 (text) — B renames its label DISJOINTLY while A edits field 1. */
	fieldTwoUuid: "9e6f2d8b-5c41-47a9-83d7-4e5f6a7b8c9d",
	fieldTwoLabel: "Village",
	/** Field 3 (single_select) — carries options for the option-edit scenario. */
	fieldThreeUuid: "5d7a4e91-2b68-4c5f-a2e8-6f7a8b9c0d1e",
	fieldThreeLabel: "Status",

	/** Module 2 — a distinct screen for follow / cross-screen presence. */
	moduleTwoUuid: "e1c8f6a3-9d47-4b2e-95f0-8a9b0c1d2e3f",
	moduleTwoName: "Follow-up",
	formTwoUuid: "6b3e9d25-1f84-4a7c-bd39-0c1d2e3f4a5b",
	formTwoName: "Visit",
	fieldFourUuid: "48a2c7e0-6d93-4f16-8b5a-2e3f4a5b6c7d",
	fieldFourLabel: "Notes",
} as const;

/** The concrete ids + names the spec reads (written to `multiplayer.json`). */
export interface MultiplayerManifest {
	appId: string;
	moduleUuid: string;
	moduleName: string;
	formUuid: string;
	formName: string;
	fieldOneUuid: string;
	fieldOneLabel: string;
	fieldTwoUuid: string;
	fieldTwoLabel: string;
	fieldThreeUuid: string;
	fieldThreeLabel: string;
	moduleTwoUuid: string;
	moduleTwoName: string;
	fieldFourUuid: string;
	userA: { id: string; email: string; name: string };
	userB: { id: string; email: string; name: string };
	userC: { id: string; email: string; name: string };
	userD: { id: string; email: string; name: string };
	stateFileA: string;
	stateFileB: string;
	stateFileC: string;
	stateFileD: string;
	baseUrl: string;
}

/** Build the seeded blueprint: two survey modules (no case types → plain module
 *  screens with editable titles, no Postgres case-schema sync). Module 1 carries
 *  three fields so the spec can drive disjoint edits, reorders, and option edits;
 *  module 2 is a distinct screen for follow / cross-screen presence. Every uuid
 *  is fixed for direct deep-linking. */
function buildSeedBlueprint(): BlueprintDoc {
	return buildDoc({
		appName: MP_SEED.appName,
		modules: [
			{
				uuid: MP_SEED.moduleUuid,
				name: MP_SEED.moduleName,
				forms: [
					{
						uuid: MP_SEED.formUuid,
						name: MP_SEED.formName,
						type: "survey",
						fields: [
							f({
								uuid: MP_SEED.fieldOneUuid,
								kind: "text",
								id: "full_name",
								label: MP_SEED.fieldOneLabel,
							}),
							f({
								uuid: MP_SEED.fieldTwoUuid,
								kind: "text",
								id: "village",
								label: MP_SEED.fieldTwoLabel,
							}),
							f({
								uuid: MP_SEED.fieldThreeUuid,
								kind: "single_select",
								id: "status",
								label: MP_SEED.fieldThreeLabel,
								options: [
									{ value: "new", label: "New" },
									{ value: "active", label: "Active" },
								],
							}),
						],
					},
				],
			},
			{
				uuid: MP_SEED.moduleTwoUuid,
				name: MP_SEED.moduleTwoName,
				forms: [
					{
						uuid: MP_SEED.formTwoUuid,
						name: MP_SEED.formTwoName,
						type: "survey",
						fields: [
							f({
								uuid: MP_SEED.fieldFourUuid,
								kind: "text",
								id: "notes",
								label: MP_SEED.fieldFourLabel,
							}),
						],
					},
				],
			},
		],
	});
}

/**
 * Seed the two-user shared-Project fixture. `ctx` is the Better Auth adapter
 * context (`await auth.$context`) the seed already resolved — reusing it keeps
 * the same adapter/schema config as production; `secret` signs the cookies;
 * `baseUrl` picks the cookie name + domain. Returns the manifest the caller
 * serializes to `multiplayer.json`.
 */
export async function seedMultiplayerFixture(args: {
	ctx: AuthContext;
	secret: string;
	baseUrl: string;
	authDir: string;
	writeFile: (path: string, data: string) => Promise<void>;
	pathJoin: (...parts: string[]) => string;
}): Promise<MultiplayerManifest> {
	const { ctx, secret, baseUrl, authDir, writeFile, pathJoin } = args;
	const now = new Date();

	// ── Users + sessions (Postgres, via the adapter) ──────────────────────
	const tokens: Record<"userA" | "userB" | "userC" | "userD", string> = {
		userA: randomBytes(32).toString("hex"),
		userB: randomBytes(32).toString("hex"),
		userC: randomBytes(32).toString("hex"),
		userD: randomBytes(32).toString("hex"),
	};
	const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
	for (const key of ["userA", "userB", "userC", "userD"] as const) {
		const u = MP_SEED[key];
		await ctx.adapter.create({
			model: "user",
			forceAllowId: true,
			data: {
				id: u.id,
				name: u.name,
				email: u.email,
				emailVerified: true,
				image: u.image,
				role: "user",
				banned: false,
				createdAt: now,
				updatedAt: now,
				lastActiveAt: now,
			},
		});
		await ctx.adapter.create({
			model: "session",
			data: {
				token: tokens[key],
				userId: u.id,
				expiresAt,
				createdAt: now,
				updatedAt: now,
				ipAddress: "",
				userAgent: "smoke-test",
			},
		});
	}

	// ── Shared Project + all four memberships (Postgres, via the adapter) ──
	// A direct adapter create bypasses the invitation domain-gate hook (that
	// hook fires only on the invitation API path), so the members are written
	// straight in. Ada `owner`; Grace, Katherine, and Alan `editor` — each
	// holds `edit` on the app, so all four are concurrent writers.
	const org = await ctx.adapter.create<never, { id: string }>({
		model: "organization",
		data: {
			name: MP_SEED.projectName,
			slug: `mp-shared-${MP_SEED.userA.id}`,
			logo: null,
			metadata: JSON.stringify({ personal: false }),
			createdAt: now,
		},
	});
	const projectId = org.id;
	await ctx.adapter.create({
		model: "member",
		data: {
			organizationId: projectId,
			userId: MP_SEED.userA.id,
			role: "owner",
			createdAt: now,
		},
	});
	for (const editor of [MP_SEED.userB, MP_SEED.userC, MP_SEED.userD]) {
		await ctx.adapter.create({
			model: "member",
			data: {
				organizationId: projectId,
				userId: editor.id,
				role: "editor",
				createdAt: now,
			},
		});
	}

	// ── The shared app (Postgres) ─────────────────────────────────────────
	// Mint a `complete` app owned by Ada in the shared Project, then install
	// the populated fixed-uuid blueprint. `createApp` only writes an empty
	// doc, so `appendSyntheticBatch` replaces the blueprint wholesale + updates
	// the denormalized counts + advances the stream — the at-rest `complete`
	// shape (no run markers) two collaborators open. It does NOT re-run the
	// validator, which is what lets the fixture pin its fixed uuids.
	const doc = buildSeedBlueprint();
	const persistable = toPersistableDoc(doc);
	const appId = await createApp(MP_SEED.userA.id, projectId, "mp-seed", {
		appName: MP_SEED.appName,
		status: "complete",
	});
	await appendSyntheticBatch(appId, persistable);

	// ── Emit four storageStates + the manifest ────────────────────────────
	const stateFiles = {
		userA: pathJoin(authDir, "state-mp-a.json"),
		userB: pathJoin(authDir, "state-mp-b.json"),
		userC: pathJoin(authDir, "state-mp-c.json"),
		userD: pathJoin(authDir, "state-mp-d.json"),
	} as const;
	for (const key of ["userA", "userB", "userC", "userD"] as const) {
		await writeFile(
			stateFiles[key],
			JSON.stringify(
				buildSessionStorageState({ token: tokens[key], secret, baseUrl }),
				null,
				2,
			),
		);
	}

	return {
		appId,
		moduleUuid: asUuid(MP_SEED.moduleUuid),
		moduleName: MP_SEED.moduleName,
		formUuid: asUuid(MP_SEED.formUuid),
		formName: MP_SEED.formName,
		fieldOneUuid: asUuid(MP_SEED.fieldOneUuid),
		fieldOneLabel: MP_SEED.fieldOneLabel,
		fieldTwoUuid: asUuid(MP_SEED.fieldTwoUuid),
		fieldTwoLabel: MP_SEED.fieldTwoLabel,
		fieldThreeUuid: asUuid(MP_SEED.fieldThreeUuid),
		fieldThreeLabel: MP_SEED.fieldThreeLabel,
		moduleTwoUuid: asUuid(MP_SEED.moduleTwoUuid),
		moduleTwoName: MP_SEED.moduleTwoName,
		fieldFourUuid: asUuid(MP_SEED.fieldFourUuid),
		userA: MP_SEED.userA,
		userB: MP_SEED.userB,
		userC: MP_SEED.userC,
		userD: MP_SEED.userD,
		stateFileA: stateFiles.userA,
		stateFileB: stateFiles.userB,
		stateFileC: stateFiles.userC,
		stateFileD: stateFiles.userD,
		baseUrl,
	};
}
