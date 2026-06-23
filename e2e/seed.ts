/**
 * Smoke-suite Firestore seed (emulator only).
 *
 * Run inside `firebase emulators:exec` (so `FIRESTORE_EMULATOR_HOST` is set)
 * BEFORE Playwright starts. It writes the minimum an authenticated smoke run
 * needs into the emulator, then emits a Playwright `storageState` carrying a
 * forged-but-valid session cookie:
 *
 *   1. an `auth_users` row (the signed-in Dimagi user),
 *   2. an `auth_sessions` row (a live, non-expired session token),
 *   3. two `complete` apps via the real `createApp` — NO LLM spend:
 *        • "Smoke — Open Me"   → opened in the builder by a test,
 *        • "Smoke — Delete Me" → soft-deleted through the UI by a test.
 *
 * App creation goes through `lib/db/apps.ts::createApp` (a pure Firestore
 * write), not the chat agent, so the suite never calls Anthropic. Everything is
 * written to the Firestore emulator the running app also points at, so the
 * authed UI sees this data.
 *
 * SAFETY: this refuses to run unless `FIRESTORE_EMULATOR_HOST` is set, so it can
 * never write into the real `commcare-nova-dev` / `commcare-nova` projects.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Timestamp } from "@google-cloud/firestore";
import { createApp } from "@/lib/db/apps";
import { getDb } from "@/lib/db/firestore";
import { buildSessionStorageState } from "./lib/session";

/** Stable identifiers the tests assert against (mirrored in `authed.spec.ts`). */
export const SEED = {
	userId: "smoke-user",
	userEmail: "smoke@dimagi.com",
	userName: "Smoke Test User",
	openAppName: "Smoke — Open Me",
	deleteAppName: "Smoke — Delete Me",
} as const;

const AUTH_DIR = path.join(process.cwd(), "e2e", ".auth");
const STATE_FILE = path.join(AUTH_DIR, "state.json");
const SEED_FILE = path.join(AUTH_DIR, "seed.json");

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(
			`e2e/seed.ts: ${name} is required but unset. Run this through scripts/smoke.sh, which boots the Firestore emulator and exports the smoke env.`,
		);
	}
	return value;
}

async function main(): Promise<void> {
	// Hard guard: only ever touch the emulator. Without this, a stray run with
	// real ADC would write a fake session into production Firestore.
	if (!process.env.FIRESTORE_EMULATOR_HOST) {
		throw new Error(
			"e2e/seed.ts refuses to run without FIRESTORE_EMULATOR_HOST — it must only write to the Firestore emulator, never a real project.",
		);
	}
	const secret = requireEnv("BETTER_AUTH_SECRET");
	const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";

	const db = getDb();

	// 1) The signed-in user. getSession loads this row by `userId`; the
	//    email-domain allowlist only gates user *creation* (the OAuth hook), so
	//    a directly-seeded row is accepted on read regardless.
	const now = Timestamp.now();
	await db.collection("auth_users").doc(SEED.userId).set({
		id: SEED.userId,
		email: SEED.userEmail,
		emailVerified: true,
		name: SEED.userName,
		image: null,
		role: "user",
		banned: false,
		createdAt: now.toDate(),
		updatedAt: now.toDate(),
		lastActiveAt: now.toDate(),
	});

	// 2) A live session. `token` is the secret material the cookie carries; the
	//    Firestore doc id is unrelated (getSession looks rows up by the `token`
	//    field). expiresAt must be in the future.
	const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
	const expiresAt = Timestamp.fromMillis(Date.now() + 2 * 24 * 60 * 60 * 1000);
	await db.collection("auth_sessions").add({
		token,
		userId: SEED.userId,
		expiresAt: expiresAt.toDate(),
		createdAt: now.toDate(),
		updatedAt: now.toDate(),
		ipAddress: "",
		userAgent: "smoke-test",
	});

	// 3) Two empty-but-valid apps via the real no-LLM create path.
	const openAppId = await createApp(SEED.userId, randomUUID(), {
		appName: SEED.openAppName,
		status: "complete",
	});
	const deleteAppId = await createApp(SEED.userId, randomUUID(), {
		appName: SEED.deleteAppName,
		status: "complete",
	});

	// Emit storageState (consumed by the `authed` Playwright project) + a seed
	// manifest the tests read for the concrete app ids.
	const storageState = buildSessionStorageState({ token, secret, baseUrl });
	await mkdir(AUTH_DIR, { recursive: true });
	await writeFile(STATE_FILE, JSON.stringify(storageState, null, 2));
	await writeFile(
		SEED_FILE,
		JSON.stringify({ ...SEED, openAppId, deleteAppId, baseUrl }, null, 2),
	);

	console.log(
		`[seed] user=${SEED.userId} openApp=${openAppId} deleteApp=${deleteAppId}\n[seed] wrote ${path.relative(process.cwd(), STATE_FILE)} + ${path.relative(process.cwd(), SEED_FILE)}`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
