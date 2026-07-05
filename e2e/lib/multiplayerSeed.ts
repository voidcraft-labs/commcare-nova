/**
 * Two-user shared-Project fixture for the multiplayer E2E (`multiplayer.spec.ts`).
 *
 * Seeds the minimum a real-time co-editing test needs, all into local services
 * only (the caller — `e2e/seed.ts` — enforces the `FIRESTORE_EMULATOR_HOST` +
 * `NOVA_DB_LOCAL_URL` guards before calling in):
 *
 *   1. Two `auth_user` rows (Ada, Grace) + one live `auth_session` each, in
 *      Postgres, through Better Auth's own adapter.
 *   2. One SHARED Project (`auth_organization`) with BOTH users as members —
 *      Ada `owner`, Grace `editor` — so each holds the `edit` app capability on
 *      it (`lib/auth/projectRoles.ts`). Written through the same adapter, so a
 *      later Better Auth schema change surfaces here, not as a Playwright
 *      timeout.
 *   3. One `complete` app whose `project_id` IS that shared Project, carrying a
 *      populated blueprint (one survey module → one survey form → one text
 *      field) with a FIXED module uuid, in Firestore (emulator). Because the
 *      build page authorizes purely on the app's own `project_id` +
 *      `auth_member` (no "active Project" gate — `resolveAppAccess`), both
 *      members open + co-edit it. `status: "complete"` is required or
 *      `/build/{id}` redirects to `/`.
 *
 * Emits two Playwright `storageState` files (one signed session cookie per
 * user) and a manifest the spec reads for the concrete ids it navigates to and
 * asserts against.
 *
 * The app is minted directly (not via `createApp`, which only writes an empty
 * doc): the same field set `createApp` writes, but with the populated blueprint
 * and its denormalized counts. Every optional run-liveness field
 * (`reservation`, `run_lock`, `awaiting_input`) is absent — a plain at-rest
 * `complete` app, which is exactly what two collaborators open.
 */

import { randomBytes } from "node:crypto";
import { FieldValue } from "@google-cloud/firestore";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { collections } from "@/lib/db/firestore";
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
 * uuid is FIXED so both users deep-link to the same entity and the spec targets
 * it without a doc round-trip. The app is deliberately RICH enough to exercise
 * the whole multiplayer matrix from ONE fixture:
 *   - module 1 "Intake" (survey) with THREE fields (two text + one single_select
 *     with options) → disjoint-edit merge (A edits field 1, B edits field 2),
 *     field reorder, option edits, and live-highlight (select a field);
 *   - module 2 "Follow-up" (survey, one field) → follow / cross-screen presence.
 */
export const MP_SEED = {
	userA: {
		id: "mp-user-ada",
		email: "ada@dimagi.com",
		name: "Ada Lovelace",
		/* Ada carries a profile PHOTO (a self-contained data-URL portrait) and
		 * Grace none, so a two-user session exercises BOTH presence-avatar
		 * paths at once: her peers see the photo ringed in her palette hue,
		 * Grace's see initials on hers. */
		image:
			"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='%234c1d95'/><circle cx='32' cy='25' r='11' fill='%23ddd6fe'/><path d='M10 64a22 15 0 0 1 44 0z' fill='%23ddd6fe'/></svg>",
	},
	userB: {
		id: "mp-user-grace",
		email: "grace@dimagi.com",
		name: "Grace Hopper",
		image: null,
	},
	/** The shared Project both users co-own/edit. */
	projectName: "Multiplayer Test Project",
	appName: "Multiplayer — Co-Edit Me",

	/** Module 1 — the survey both users co-edit (rename + field edits + reorder). */
	moduleUuid: "mp-module-intake",
	moduleName: "Intake",
	formUuid: "mp-form-registration",
	formName: "Registration",
	/** Field 1 (text) — A renames its label; B observes it live. */
	fieldOneUuid: "mp-field-fullname",
	fieldOneLabel: "Full name",
	/** Field 2 (text) — B renames its label DISJOINTLY while A edits field 1. */
	fieldTwoUuid: "mp-field-village",
	fieldTwoLabel: "Village",
	/** Field 3 (single_select) — carries options for the option-edit scenario. */
	fieldThreeUuid: "mp-field-status",
	fieldThreeLabel: "Status",

	/** Module 2 — a distinct screen for follow / cross-screen presence. */
	moduleTwoUuid: "mp-module-followup",
	moduleTwoName: "Follow-up",
	formTwoUuid: "mp-form-visit",
	formTwoName: "Visit",
	fieldFourUuid: "mp-field-notes",
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
	stateFileA: string;
	stateFileB: string;
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
	const tokens: Record<"userA" | "userB", string> = {
		userA: randomBytes(32).toString("hex"),
		userB: randomBytes(32).toString("hex"),
	};
	const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
	for (const key of ["userA", "userB"] as const) {
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

	// ── Shared Project + both memberships (Postgres, via the adapter) ──────
	// A direct adapter create bypasses the invitation domain-gate hook (that
	// hook fires only on the invitation API path), so both members are written
	// straight in. Ada `owner`, Grace `editor` — each holds `edit` on the app.
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
	await ctx.adapter.create({
		model: "member",
		data: {
			organizationId: projectId,
			userId: MP_SEED.userB.id,
			role: "editor",
			createdAt: now,
		},
	});

	// ── The shared app (Firestore emulator) ───────────────────────────────
	// Minted directly with the populated blueprint + its denormalized counts —
	// the fields `createApp` writes, in the at-rest `complete` shape (no run
	// markers). `owner` is Ada; the tenant is the shared Project.
	const doc = buildSeedBlueprint();
	const ref = collections.apps().doc();
	const appId = ref.id;
	const persistable = toPersistableDoc({ ...doc, appId });
	const moduleCount = persistable.moduleOrder.length;
	const formCount = persistable.moduleOrder.reduce(
		(sum, m) => sum + (persistable.formOrder[m]?.length ?? 0),
		0,
	);
	// `app_name_lower` is a `listApps` sort key not declared on `appDocSchema`
	// (it rides through `createApp`'s spread, which excess-property checks skip);
	// this app is opened by direct URL, never listed, so it's omitted.
	await ref.set({
		owner: MP_SEED.userA.id,
		project_id: projectId,
		app_name: MP_SEED.appName,
		connect_type: null,
		module_count: moduleCount,
		form_count: formCount,
		blueprint: persistable,
		mutation_seq: 0,
		status: "complete",
		error_type: null,
		deleted_at: null,
		recoverable_until: null,
		run_id: "mp-seed",
		created_at: FieldValue.serverTimestamp(),
		updated_at: FieldValue.serverTimestamp(),
	});

	// ── Emit two storageStates + the manifest ─────────────────────────────
	const stateFileA = pathJoin(authDir, "state-mp-a.json");
	const stateFileB = pathJoin(authDir, "state-mp-b.json");
	await writeFile(
		stateFileA,
		JSON.stringify(
			buildSessionStorageState({ token: tokens.userA, secret, baseUrl }),
			null,
			2,
		),
	);
	await writeFile(
		stateFileB,
		JSON.stringify(
			buildSessionStorageState({ token: tokens.userB, secret, baseUrl }),
			null,
			2,
		),
	);

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
		stateFileA,
		stateFileB,
		baseUrl,
	};
}
