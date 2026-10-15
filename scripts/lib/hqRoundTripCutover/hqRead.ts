/**
 * The cutover's reads of CommCare HQ: which member's stored key each read
 * sends, what one answer means, how often a read is sent again, and how the
 * reads of one project space are paced (part 10 of step 2's plan, "Reading
 * HQ").
 *
 * Two reads per deployment. The source read (`readHqAppSource`, edit-apps)
 * gives the app's menus, forms, names, `xmlns` and XForms, and mints a fresh
 * form id on every read; the form id read (`ApplicationResource`'s detail,
 * HQ's API) gives each form's stored id. Each read falls back through the
 * deployment's credential order on its own: a 401 or 403 moves that read to
 * the next member and leaves the other read where it is.
 *
 * HQ limits every Tastypie read per project space, the form id read among
 * them, and limits no source read. So per server and project space one
 * request is in flight at a time, a limited read starts no sooner than seven
 * seconds after the previous limited read there started, and across the
 * project spaces of one server at most four requests are in flight. A 429
 * carries no `Retry-After`, so it waits one whole minute window and is sent
 * again, three attempts in all; every other transient outcome is sent again
 * after 2 s and then 8 s, or after the wait a 5xx's or an edge refusal's
 * `Retry-After` asks where that is longer. A `Retry-After` over 60 s ends the
 * attempts there, transient, so no request goes sooner than HQ asked. No
 * database lock spans a request.
 *
 * A key is decrypted at the moment of each use and kept in memory only:
 * never in the plan, a log line, the report or an error.
 */

import { type Kysely, sql } from "kysely";
import {
	type HqAppSource,
	type HqAppSourceRead,
	readHqAppSource,
} from "@/lib/commcare/hq/appSource";
import {
	baseUrl,
	type CommCareApiError,
	type CommCareCredentials,
	isValidDomainSlug,
} from "@/lib/commcare/hq/http";
import { readHqJson } from "@/lib/commcare/hq/readJson";
import { isCommCareServer } from "@/lib/commcare/servers";
import type { AppDatabase } from "@/lib/db/pg";
import {
	type DecryptClock,
	type KmsDecryptTransport,
	kmsDecrypt,
	realClock,
} from "./kmsDecrypt";
import {
	alignStoredFormIds,
	deploymentIdentities,
	type HqFormIdModule,
	hqSideOf,
	type IdentityRow,
	type MatchResult,
	matchByEvidence,
	matchByPublishedDocument,
	type UnpairedEntity,
} from "./matching";
import type { DeploymentPairing } from "./plan";
import type { PublishedDocumentGap } from "./publishedDocument";
import type { QuestionPathMenu } from "./questionPaths";
import type { DeploymentOutcome } from "./transform";

// ── One answer ──────────────────────────────────────────────────────

/** What one read of HQ came to, after its attempts. */
export type HqReadOutcome<T> =
	| { readonly kind: "ok"; readonly value: T }
	/** The key was refused: the read moves to the next credential. */
	| { readonly kind: "refused"; readonly status: 401 | 403 }
	/** The app is deleted, in either of HQ's two forms. */
	| { readonly kind: "gone" }
	/** An app Nova did not make, such as a linked app. */
	| { readonly kind: "unsupported"; readonly docType: string }
	| {
			readonly kind: "transient";
			readonly cause: "no-answer" | "timeout" | "5xx" | "429" | "edge";
			/** The wait a 5xx's or an edge refusal's `Retry-After` asked for. */
			readonly retryAfterMs?: number;
	  }
	| {
			readonly kind: "unreadable";
			readonly cause: "redirect" | "400" | "malformed" | "other-status";
	  };

type HqReadFailure = Exclude<
	HqReadOutcome<never>,
	{ kind: "ok" } | { kind: "unsupported" }
>;

/** A transient 5xx or edge refusal, carrying the wait its `Retry-After` asked for. */
function transient(
	cause: "5xx" | "edge",
	error: CommCareApiError,
): HqReadFailure {
	return error.retryAfterMs === undefined
		? { kind: "transient", cause }
		: { kind: "transient", cause, retryAfterMs: error.retryAfterMs };
}

/**
 * One refused or failed request, classed. An edge refusal is a proxy's
 * status and says nothing about the key or the app; a status a read
 * synthesized says why by its cause; HQ's own empty-bodied 401, 404 and 429
 * are never edge refusals (`isEdgeRefusal` requires a title naming a status).
 */
export function classifyHqFailure(error: CommCareApiError): HqReadFailure {
	if (error.edgeRefusal === true) return transient("edge", error);
	if (error.cause === "network") {
		return { kind: "transient", cause: "no-answer" };
	}
	if (error.cause === "timeout") return { kind: "transient", cause: "timeout" };
	if (error.cause === "malformed") {
		return { kind: "unreadable", cause: "malformed" };
	}
	const { status } = error;
	if (status === 401 || status === 403) return { kind: "refused", status };
	if (status === 404) return { kind: "gone" };
	if (status === 429) return { kind: "transient", cause: "429" };
	if (status >= 500) return transient("5xx", error);
	if (status >= 300 && status < 400) {
		return { kind: "unreadable", cause: "redirect" };
	}
	if (status === 400) return { kind: "unreadable", cause: "400" };
	return { kind: "unreadable", cause: "other-status" };
}

/** The source read's answer, classed. */
export function classifySourceRead(
	read: HqAppSourceRead,
): HqReadOutcome<HqAppSource> {
	if ("success" in read) return classifyHqFailure(read);
	if (read.kind === "source") return { kind: "ok", value: read.source };
	return read;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `ApplicationResource`'s modules, each `{ unique_id, forms }` or, for a
 * module one of whose forms does not parse, `{ error }` alone
 * (`corehq/apps/api/resources/v0_4.py::ApplicationResource.dehydrate_module`).
 * Null for any other shape.
 */
export function parseFormIdModules(body: unknown): HqFormIdModule[] | null {
	if (!isRecord(body) || !Array.isArray(body.modules)) return null;
	const modules: HqFormIdModule[] = [];
	for (const module of body.modules) {
		if (!isRecord(module)) return null;
		if (module.unique_id === undefined && module.error !== undefined) {
			modules.push({ kind: "error" });
			continue;
		}
		if (typeof module.unique_id !== "string" || !Array.isArray(module.forms)) {
			return null;
		}
		const forms: { uniqueId: string; xmlns: string }[] = [];
		for (const form of module.forms) {
			if (
				!isRecord(form) ||
				typeof form.unique_id !== "string" ||
				typeof form.xmlns !== "string"
			) {
				return null;
			}
			forms.push({ uniqueId: form.unique_id, xmlns: form.xmlns });
		}
		modules.push({ kind: "module", uniqueId: module.unique_id, forms });
	}
	return modules;
}

/**
 * The form id read: the detail of `ApplicationResource` at
 * `/a/<domain>/api/v0.4/application/<app id>/`, which shows each form's
 * stored `unique_id` and `xmlns` in order. It needs the project space's API
 * access, the member's `access_api` permission and room in HQ's API rate
 * limit for that space.
 */
export async function readHqApplicationFormIds(
	creds: CommCareCredentials,
	domain: string,
	appId: string,
): Promise<HqReadOutcome<HqFormIdModule[]>> {
	if (!isValidDomainSlug(domain) || !/^[\w-]+$/.test(appId)) {
		return { kind: "unreadable", cause: "other-status" };
	}
	const result = await readHqJson(
		creds,
		`${baseUrl(creds)}/a/${domain}/api/v0.4/application/${encodeURIComponent(appId)}/`,
		"application form ids",
	);
	if ("success" in result) return classifyHqFailure(result);
	const modules = parseFormIdModules(result.data);
	return modules === null
		? { kind: "unreadable", cause: "malformed" }
		: { kind: "ok", value: modules };
}

// ── Pacing ──────────────────────────────────────────────────────────

/** The least time between the starts of two limited reads to one space. */
export const LIMITED_READ_SPACING_MS = 7_000;
/** Requests in flight at once across the project spaces of one server. */
export const SPACES_ABREAST = 4;
/** A 429 waits one whole minute window before it is sent again. */
export const RATE_LIMITED_WAIT_MS = 65_000;
/** The waits before the second and the third attempt of any other transient read. */
export const TRANSIENT_WAITS_MS = [2_000, 8_000] as const;
/** The longest `Retry-After` a transient read waits out; a longer one ends its attempts. */
export const MAX_HONORED_RETRY_AFTER_MS = 60_000;
export const READ_ATTEMPTS = 3;

class Slots {
	private free: number;
	private readonly waiting: (() => void)[] = [];

	constructor(size: number) {
		this.free = size;
	}

	async take(): Promise<() => void> {
		if (this.free > 0) {
			this.free -= 1;
		} else {
			await new Promise<void>((resolve) => this.waiting.push(resolve));
		}
		return () => {
			const next = this.waiting.shift();
			if (next !== undefined) next();
			else this.free += 1;
		};
	}
}

interface SpaceState {
	tail: Promise<void>;
	lastLimitedStart: number | null;
	limitedReads: number;
}

/** The pace of one run's requests, per server and project space. */
export class HqReadPacer {
	private readonly spaces = new Map<string, SpaceState>();
	private readonly servers = new Map<string, Slots>();

	constructor(private readonly clock: DecryptClock = realClock) {}

	private space(server: string, domain: string): SpaceState {
		const key = JSON.stringify([server, domain]);
		let state = this.spaces.get(key);
		if (state === undefined) {
			state = {
				tail: Promise.resolve(),
				lastLimitedStart: null,
				limitedReads: 0,
			};
			this.spaces.set(key, state);
		}
		return state;
	}

	/**
	 * Send one request to a project space, after every earlier request to it
	 * has finished, a limited one no sooner than the spacing after the last
	 * limited one there started.
	 */
	async send<T>(
		server: string,
		domain: string,
		limited: boolean,
		request: () => Promise<T>,
	): Promise<T> {
		const space = this.space(server, domain);
		const previous = space.tail;
		let finished = () => {};
		space.tail = new Promise<void>((resolve) => {
			finished = resolve;
		});
		await previous;
		try {
			if (limited && space.lastLimitedStart !== null) {
				const wait =
					space.lastLimitedStart + LIMITED_READ_SPACING_MS - this.clock.now();
				if (wait > 0) await this.clock.sleep(wait);
			}
			let slots = this.servers.get(server);
			if (slots === undefined) {
				slots = new Slots(SPACES_ABREAST);
				this.servers.set(server, slots);
			}
			const release = await slots.take();
			try {
				if (limited) {
					space.lastLimitedStart = this.clock.now();
					space.limitedReads += 1;
				}
				return await request();
			} finally {
				release();
			}
		} finally {
			finished();
		}
	}

	/** Each project space's count of limited reads and when the last one started. */
	spaceReads(): {
		server: string;
		domain: string;
		limitedReads: number;
		lastLimitedReadAt: string | null;
	}[] {
		return [...this.spaces].map(([key, state]) => {
			const [server, domain] = JSON.parse(key) as [string, string];
			return {
				server,
				domain,
				limitedReads: state.limitedReads,
				lastLimitedReadAt:
					state.lastLimitedStart === null
						? null
						: new Date(state.lastLimitedStart).toISOString(),
			};
		});
	}
}

// ── Credentials and key uses ────────────────────────────────────────

/** One member's stored key, decrypted for one request. */
export type CredentialSource = (userId: string) => Promise<CommCareCredentials>;

/** The span of one member's key uses in this run. */
export interface KeyUse {
	readonly userId: string;
	readonly firstUsedAt: string;
	readonly lastUsedAt: string;
}

/** Records each send of a member's key, answered or refused. */
export class KeyUseRecorder {
	private readonly uses = new Map<string, { first: number; last: number }>();

	record(userId: string, at: number): void {
		const use = this.uses.get(userId);
		if (use === undefined) this.uses.set(userId, { first: at, last: at });
		else {
			use.first = Math.min(use.first, at);
			use.last = Math.max(use.last, at);
		}
	}

	all(): KeyUse[] {
		return [...this.uses]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([userId, use]) => ({
				userId,
				firstUsedAt: new Date(use.first).toISOString(),
				lastUsedAt: new Date(use.last).toISOString(),
			}));
	}
}

/** One member's stored key as the database holds it: the key still encrypted. */
export interface StoredCredential {
	readonly username: string;
	readonly ciphertext: string;
	readonly server: CommCareCredentials["server"];
}

/**
 * Every stored CommCare HQ key, still encrypted, read once before the plan's
 * transaction opens: the migration role holds one connection, so nothing is
 * read beside that transaction while HQ is read.
 */
export async function readStoredCredentials(
	db: Kysely<AppDatabase>,
): Promise<ReadonlyMap<string, StoredCredential>> {
	const rows = await sql<{
		user_id: string;
		commcare_username: string | null;
		commcare_api_key: string | null;
		commcare_server: string | null;
	}>`
		SELECT user_id, commcare_username, commcare_api_key, commcare_server
		FROM user_settings
		WHERE commcare_username IS NOT NULL AND commcare_username <> ''
			AND commcare_api_key IS NOT NULL AND commcare_api_key <> ''
	`.execute(db);
	const stored = new Map<string, StoredCredential>();
	for (const row of rows.rows) {
		if (
			row.commcare_username === null ||
			row.commcare_api_key === null ||
			row.commcare_server === null ||
			!isCommCareServer(row.commcare_server)
		) {
			continue;
		}
		stored.set(row.user_id, {
			username: row.commcare_username,
			ciphertext: row.commcare_api_key,
			server: row.commcare_server,
		});
	}
	return stored;
}

/**
 * The members' stored keys, each decrypted through KMS at the moment it is
 * used, so no plaintext outlives its request.
 */
export function storedCredentialSource(
	stored: ReadonlyMap<string, StoredCredential>,
	transport: () => KmsDecryptTransport,
): CredentialSource {
	return async (userId) => {
		const credential = stored.get(userId);
		if (credential === undefined) {
			throw new Error(
				`Member ${userId}'s stored CommCare HQ key was not there when the run read the keys, so the cutover stopped. Run it again.`,
			);
		}
		return {
			username: credential.username,
			apiKey: await kmsDecrypt(credential.ciphertext, transport()),
			server: credential.server,
		};
	};
}

// ── One read, through its attempts and its credentials ──────────────

export interface ReadContext {
	readonly server: string;
	readonly domain: string;
	readonly pacer: HqReadPacer;
	readonly clock: DecryptClock;
	readonly credentials: readonly string[];
	readonly credentialSource: CredentialSource;
	readonly keyUses: KeyUseRecorder;
}

/** One read with one key, sent again while it is transient. */
async function attempts<T>(
	context: ReadContext,
	userId: string,
	limited: boolean,
	request: (creds: CommCareCredentials) => Promise<HqReadOutcome<T>>,
): Promise<HqReadOutcome<T>> {
	let outcome: HqReadOutcome<T> = { kind: "transient", cause: "no-answer" };
	for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
		outcome = await context.pacer.send(
			context.server,
			context.domain,
			limited,
			async () => {
				const creds = await context.credentialSource(userId);
				context.keyUses.record(userId, context.clock.now());
				return request(creds);
			},
		);
		if (outcome.kind !== "transient" || attempt === READ_ATTEMPTS) break;
		if (outcome.cause === "429") {
			await context.clock.sleep(RATE_LIMITED_WAIT_MS);
			continue;
		}
		const asked = outcome.retryAfterMs ?? 0;
		/* HQ asked for longer than the run waits: sending sooner would go
		 * against what it asked, so the read ends here, transient. */
		if (asked > MAX_HONORED_RETRY_AFTER_MS) break;
		await context.clock.sleep(
			Math.max(TRANSIENT_WAITS_MS[attempt - 1] ?? 0, asked),
		);
	}
	return outcome;
}

/**
 * One read through the deployment's credential order: a refused key moves
 * the read to the next member, any other outcome ends it. Null where no
 * member qualifies, so no request is sent.
 */
export async function readThroughCredentials<T>(
	context: ReadContext,
	limited: boolean,
	request: (creds: CommCareCredentials) => Promise<HqReadOutcome<T>>,
): Promise<HqReadOutcome<T> | null> {
	let last: HqReadOutcome<T> | null = null;
	for (const userId of context.credentials) {
		last = await attempts(context, userId, limited, request);
		if (last.kind !== "refused") return last;
	}
	return last;
}

// ── One deployment ──────────────────────────────────────────────────

/** What HQ answered the two reads of one deployment. */
export interface DeploymentReads {
	/** Null where no member's key qualifies, so nothing was sent. */
	readonly source: HqReadOutcome<HqAppSource> | null;
	/** Null where the source read gave no app to read form ids of. */
	readonly formIds: HqReadOutcome<HqFormIdModule[]> | null;
	readonly keyUses: readonly KeyUse[];
}

/**
 * Read one deployment: the source read, then, where it gave an app, the form
 * id read, each through the credential order on its own.
 */
export async function readDeployment(
	target: {
		readonly server: string;
		readonly domain: string;
		readonly remoteAppId: string;
	},
	options: {
		readonly credentials: readonly string[];
		readonly credentialSource: CredentialSource;
		readonly pacer: HqReadPacer;
		readonly clock?: DecryptClock;
	},
): Promise<DeploymentReads> {
	const keyUses = new KeyUseRecorder();
	const context: ReadContext = {
		server: target.server,
		domain: target.domain,
		pacer: options.pacer,
		clock: options.clock ?? realClock,
		credentials: options.credentials,
		credentialSource: options.credentialSource,
		keyUses,
	};
	const source = await readThroughCredentials(context, false, async (creds) =>
		classifySourceRead(
			await readHqAppSource(creds, target.domain, target.remoteAppId),
		),
	);
	const formIds =
		source?.kind === "ok"
			? await readThroughCredentials(context, true, (creds) =>
					readHqApplicationFormIds(creds, target.domain, target.remoteAppId),
				)
			: null;
	return { source, formIds, keyUses: keyUses.all() };
}

// ── One deployment's class ─────────────────────────────────────────

/** The document a deployment was last published from, as the matcher reads it. */
export type PublishedMenus =
	| {
			readonly kind: "document";
			readonly source: "stored" | "folded";
			readonly menus: readonly QuestionPathMenu[];
	  }
	| { readonly kind: "none"; readonly reason: PublishedDocumentGap };

/** What the cutover records for one deployment from its reads. */
export interface DeploymentClass {
	readonly outcome: DeploymentOutcome;
	/** HQ's `build_spec.version`; null where no source was read. */
	readonly buildSpecVersion: string | null;
	readonly pairing: DeploymentPairing;
	readonly identities: readonly IdentityRow[];
	/** Entities of today's document whose ids change once: `menu-id-changes-once`. */
	readonly unpaired: readonly UnpairedEntity[];
	/** Paired forms whose stored form id no read gave: `form-ids-change-once`. */
	readonly formIdsUnknown: readonly string[];
	/** The pairs and the counts the report prints; null where no source was read. */
	readonly match: MatchResult | null;
	/** The source read's `profile.properties`; null where no source was read. */
	readonly profileProperties: Readonly<Record<string, unknown>> | null;
	readonly keyUses: readonly KeyUse[];
}

function noSource(
	outcome: DeploymentOutcome,
	keyUses: readonly KeyUse[],
): DeploymentClass {
	return {
		outcome,
		buildSpecVersion: null,
		pairing: null,
		identities: [],
		unpaired: [],
		formIdsUnknown: [],
		match: null,
		profileProperties: null,
		keyUses,
	};
}

/** A deployment classed with no HQ read: `unreadable`, with nothing recorded. */
export function unreadDeploymentClass(): DeploymentClass {
	return noSource("unreadable", []);
}

/**
 * One deployment's class from its two reads (part 10, "Classification of one
 * deployment"), and, where the source read gave an app, its pairs and its
 * identity rows. A read still transient after its attempts makes the
 * deployment `transient`, which stops the run; under
 * `--transient-as-unreadable` a transient source read is `unreadable` and a
 * transient form id read alone is `no-form-ids`.
 */
export function classifyDeployment(input: {
	readonly reads: DeploymentReads;
	readonly today: readonly QuestionPathMenu[];
	readonly published: PublishedMenus;
	readonly transientAsUnreadable: boolean;
}): DeploymentClass {
	const { reads, transientAsUnreadable } = input;
	const source = reads.source;
	if (source === null) return noSource("unreadable", reads.keyUses);
	switch (source.kind) {
		case "gone":
			return noSource("deleted", reads.keyUses);
		case "unsupported":
			return noSource("unsupported", reads.keyUses);
		case "refused":
		case "unreadable":
			return noSource("unreadable", reads.keyUses);
		case "transient":
			return noSource(
				transientAsUnreadable ? "unreadable" : "transient",
				reads.keyUses,
			);
		case "ok":
			break;
	}
	if (reads.formIds?.kind === "transient" && !transientAsUnreadable) {
		return noSource("transient", reads.keyUses);
	}
	const formIds = reads.formIds?.kind === "ok" ? reads.formIds.value : null;
	const hq = hqSideOf(source.value);
	let match: MatchResult;
	let pairing: DeploymentPairing;
	if (input.published.kind === "document") {
		const byDocument = matchByPublishedDocument(
			hq,
			input.published.menus,
			input.today,
		);
		if (byDocument.agrees) {
			match = byDocument.result;
			pairing = { path: "published-document", source: input.published.source };
		} else {
			match = {
				...matchByEvidence(hq, input.today),
				differences: byDocument.differences,
			};
			pairing = { path: "evidence", reason: "hq-differs" };
		}
	} else {
		match = matchByEvidence(hq, input.today);
		pairing = { path: "evidence", reason: input.published.reason };
	}
	const aligned = alignStoredFormIds(hq, formIds);
	const identities = deploymentIdentities(
		hq,
		match.pairs,
		aligned,
		input.today,
	);
	const allAligned =
		formIds !== null && [...aligned.values()].every((id) => id !== null);
	const profile = source.value.raw.profile;
	const properties =
		isRecord(profile) && isRecord(profile.properties) ? profile.properties : {};
	return {
		outcome: allAligned ? "read-in-full" : "no-form-ids",
		buildSpecVersion: source.value.buildSpecVersion,
		pairing,
		identities: identities.rows,
		unpaired: [
			...(match.path === "evidence" ? match.unpaired : []),
			...identities.collisions,
		],
		formIdsUnknown: identities.formIdsUnknown,
		match,
		profileProperties: properties,
		keyUses: reads.keyUses,
	};
}
