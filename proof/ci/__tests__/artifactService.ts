// A controlled stand-in for GitHub's artifact service on a loopback port, for
// the tests of proof/ci's scripts: the Twirp endpoints @actions/artifact calls
// (github.actions.results.api.v1.ArtifactService: CreateArtifact,
// FinalizeArtifact, ListArtifacts, GetSignedArtifactURL) and the block-blob
// upload and plain download its signed URLs lead to. The scripts run the real
// vendored client against it, so what is controlled is only the service's
// answers: whether a name is exclusive, when each call is answered (a test
// holds calls to build an interleaving), which calls fail, and from which
// listing an artifact becomes visible.

import { createHash } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

const SERVICE = "/twirp/github.actions.results.api.v1.ArtifactService/";
const RUN = "run-backend-1";

export type Method =
	| "CreateArtifact"
	| "FinalizeArtifact"
	| "ListArtifacts"
	| "GetSignedArtifactURL";

export interface Call {
	method: Method;
	job: string;
	/** The artifact name a create, finalize or signed-URL call names. */
	name?: string;
	/** The order the service received the call in, from 1. */
	sequence: number;
}

interface Artifact {
	id: number;
	name: string;
	job: string;
	finalized: boolean;
	/** The listing (by count of listings answered) from which this artifact is listed. */
	visibleFrom: number;
	blocks: Map<string, Buffer>;
	bytes?: Buffer;
	contentType?: string;
	digest?: string;
	size: number;
	createdAt: string;
}

export interface ServiceOptions {
	/** Whether a name the run holds refuses another creation (GitHub's documented behavior); default true. */
	exclusive?: boolean;
}

/** Holds each call `match` accepts until the test releases it. */
export interface Hold {
	/** Resolves once `count` matching calls are being held. */
	arrived(count: number): Promise<void>;
	release(): void;
}

function jwt(job: string): string {
	const encode = (value: object) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode({ scp: `Actions.Results:${RUN}:${job}` })}.unsigned`;
}

function jobOf(request: IncomingMessage): string | undefined {
	const header = request.headers.authorization ?? "";
	const token = header.replace(/^Bearer /, "");
	try {
		const payload = JSON.parse(
			Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
		);
		const [scope, run, job] = String(payload.scp ?? "").split(":");
		return scope === "Actions.Results" && run === RUN ? job : undefined;
	} catch {
		return undefined;
	}
}

async function body(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

function send(
	response: ServerResponse,
	status: number,
	value: unknown,
	headers: Record<string, string> = {},
) {
	const text = JSON.stringify(value);
	response.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(text),
		...headers,
	});
	response.end(text);
}

export class ArtifactService {
	readonly calls: Call[] = [];
	private readonly server: Server;
	private readonly store: Artifact[] = [];
	private readonly holds: {
		match: (call: Call) => boolean;
		held: (() => void)[];
		released: boolean;
		waiters: { count: number; resolve: () => void }[];
	}[] = [];
	private readonly failures = new Map<
		Method,
		{ status: number; code: string; msg: string }
	>();
	private listings = 0;
	private revealFrom = 0;
	private origin = "";

	constructor(private readonly options: ServiceOptions = {}) {
		this.server = createServer((request, response) => {
			this.handle(request, response).catch((error) => {
				send(response, 500, { code: "internal", msg: String(error) });
			});
		});
	}

	async start(): Promise<void> {
		await new Promise<void>((resolve) =>
			this.server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = this.server.address() as AddressInfo;
		this.origin = `http://127.0.0.1:${port}`;
	}

	async stop(): Promise<void> {
		for (const hold of this.holds) {
			hold.released = true;
			for (const go of hold.held.splice(0)) go();
		}
		this.server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			this.server.close((error) => (error ? reject(error) : resolve())),
		);
	}

	/** The environment a job of this run gives the scripts: its runtime token and the service's address. */
	env(job: string): Record<string, string> {
		return {
			ACTIONS_RUNTIME_TOKEN: jwt(job),
			ACTIONS_RESULTS_URL: `${this.origin}/`,
		};
	}

	/** A finalized artifact another job uploaded: one file of `bytes`, listed with `digest` (its sha256 unless given). */
	put(name: string, bytes: Buffer, digest?: string): void {
		this.store.push({
			id: this.store.length + 1,
			name,
			job: "another-job",
			finalized: true,
			visibleFrom: this.revealFrom,
			blocks: new Map(),
			bytes,
			contentType: "application/octet-stream",
			digest:
				digest ?? `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
			size: bytes.length,
			createdAt: new Date(0).toISOString(),
		});
	}

	/** Artifacts finalized (or put) from now on are listed only after `count` more listings. */
	revealAfter(count: number): void {
		this.revealFrom = this.listings + count;
	}

	/** Every artifact of `name`, finalized or not, in creation order. */
	named(name: string): { id: number; finalized: boolean; bytes?: Buffer }[] {
		return this.store
			.filter((artifact) => artifact.name === name)
			.map(({ id, finalized, bytes }) => ({ id, finalized, bytes }));
	}

	/** Answers every later `method` call with `status` (a Twirp error). */
	fail(method: Method, status: number, code: string, msg: string): void {
		this.failures.set(method, { status, code, msg });
	}

	/** Holds the calls `match` accepts, from now until released. */
	hold(match: (call: Call) => boolean): Hold {
		const hold = {
			match,
			held: [] as (() => void)[],
			released: false,
			waiters: [] as { count: number; resolve: () => void }[],
		};
		this.holds.push(hold);
		return {
			arrived: (count) =>
				new Promise<void>((resolve) => {
					if (hold.held.length >= count) resolve();
					else hold.waiters.push({ count, resolve });
				}),
			release: () => {
				hold.released = true;
				for (const go of hold.held.splice(0)) go();
			},
		};
	}

	/** How long the service takes to answer each call, in milliseconds (none by default). */
	latency: ((call: Call) => number) | undefined;

	private async gate(call: Call): Promise<void> {
		const latency = this.latency?.(call) ?? 0;
		if (latency > 0) {
			await new Promise((resolve) => setTimeout(resolve, latency));
		}
		for (const hold of this.holds) {
			if (hold.released || !hold.match(call)) continue;
			await new Promise<void>((resolve) => {
				hold.held.push(resolve);
				for (const waiter of [...hold.waiters]) {
					if (hold.held.length >= waiter.count) {
						hold.waiters.splice(hold.waiters.indexOf(waiter), 1);
						waiter.resolve();
					}
				}
			});
		}
	}

	private async handle(request: IncomingMessage, response: ServerResponse) {
		const url = new URL(request.url ?? "/", this.origin);
		if (url.pathname.startsWith(SERVICE) && request.method === "POST") {
			const method = url.pathname.slice(SERVICE.length) as Method;
			const job = jobOf(request);
			const input = JSON.parse((await body(request)).toString("utf8") || "{}");
			if (!job || input.workflow_run_backend_id !== RUN) {
				send(response, 401, {
					code: "unauthenticated",
					msg: "the token names no job of this run",
				});
				return;
			}
			const call: Call = {
				method,
				job,
				name: input.name,
				sequence: this.calls.length + 1,
			};
			this.calls.push(call);
			await this.gate(call);
			const failure = this.failures.get(method);
			if (failure) {
				send(response, failure.status, {
					code: failure.code,
					msg: failure.msg,
				});
				return;
			}
			this.twirp(method, job, input, response);
			return;
		}
		const blob = /^\/(upload|download)\/(\d+)$/.exec(url.pathname);
		const artifact =
			blob && this.store.find((item) => item.id === Number(blob[2]));
		if (!artifact || url.searchParams.get("sig") !== "signed") {
			send(response, 404, { msg: "no such blob" });
			return;
		}
		if (blob[1] === "download" && request.method === "GET") {
			const bytes = artifact.bytes ?? Buffer.alloc(0);
			response.writeHead(200, {
				"content-type": artifact.contentType ?? "application/octet-stream",
				"content-length": bytes.length,
				"content-disposition": `attachment; filename="${artifact.name}"`,
			});
			response.end(bytes);
			return;
		}
		if (blob[1] === "upload" && request.method === "PUT") {
			const bytes = await body(request);
			const comp = url.searchParams.get("comp");
			if (comp === "block") {
				artifact.blocks.set(url.searchParams.get("blockid") ?? "", bytes);
			} else if (comp === "blocklist") {
				const ids = [
					...bytes
						.toString("utf8")
						.matchAll(/<(?:Latest|Uncommitted|Committed)>([^<]*)</g),
				].map((match) => match[1]);
				artifact.bytes = Buffer.concat(
					ids.map((id) => artifact.blocks.get(id) ?? Buffer.alloc(0)),
				);
				artifact.contentType = String(
					request.headers["x-ms-blob-content-type"] ??
						"application/octet-stream",
				);
			} else {
				artifact.bytes = bytes;
			}
			response.writeHead(201, {
				etag: `"${artifact.id}-${artifact.blocks.size}"`,
				"last-modified": new Date(0).toUTCString(),
				"x-ms-request-id": String(this.calls.length),
				"x-ms-version": "2025-01-05",
				"x-ms-request-server-encrypted": "true",
				"content-length": "0",
			});
			response.end();
			return;
		}
		send(response, 405, { msg: "not a blob operation" });
	}

	private twirp(
		method: Method,
		job: string,
		input: Record<string, unknown>,
		response: ServerResponse,
	) {
		const name = String(input.name ?? "");
		if (method === "CreateArtifact") {
			const exclusive = this.options.exclusive ?? true;
			if (exclusive && this.store.some((artifact) => artifact.name === name)) {
				send(response, 409, {
					code: "already_exists",
					msg: "an artifact with this name already exists on the workflow run",
				});
				return;
			}
			const artifact: Artifact = {
				id: this.store.length + 1,
				name,
				job,
				finalized: false,
				visibleFrom: 0,
				blocks: new Map(),
				size: 0,
				// The service stamps an artifact when it is created, as GitHub's lists it (created_at).
				createdAt: new Date().toISOString(),
			};
			this.store.push(artifact);
			send(response, 200, {
				ok: true,
				signed_upload_url: `${this.origin}/upload/${artifact.id}?sig=signed`,
			});
			return;
		}
		if (method === "FinalizeArtifact") {
			const artifact = this.store.find(
				(item) => item.name === name && item.job === job && !item.finalized,
			);
			if (!artifact) {
				send(response, 404, {
					code: "not_found",
					msg: "no artifact of this name is being created by this job",
				});
				return;
			}
			artifact.finalized = true;
			artifact.visibleFrom = this.revealFrom;
			artifact.size = Number(input.size ?? 0);
			artifact.digest = typeof input.hash === "string" ? input.hash : undefined;
			send(response, 200, { ok: true, artifact_id: String(artifact.id) });
			return;
		}
		if (method === "ListArtifacts") {
			this.listings += 1;
			const nameFilter = input.name_filter;
			const idFilter = input.id_filter;
			const listed = this.store.filter(
				(artifact) =>
					artifact.finalized &&
					this.listings > artifact.visibleFrom &&
					(nameFilter === undefined || artifact.name === nameFilter) &&
					(idFilter === undefined || String(artifact.id) === String(idFilter)),
			);
			send(response, 200, {
				artifacts: listed.map((artifact) => ({
					workflow_run_backend_id: RUN,
					workflow_job_run_backend_id: artifact.job,
					database_id: String(artifact.id),
					name: artifact.name,
					size: String(artifact.size),
					created_at: artifact.createdAt,
					...(artifact.digest ? { digest: artifact.digest } : {}),
				})),
			});
			return;
		}
		const artifact = this.store
			.filter((item) => item.name === name && item.finalized)
			.at(-1);
		if (!artifact) {
			send(response, 404, { code: "not_found", msg: "no such artifact" });
			return;
		}
		send(response, 200, {
			signed_url: `${this.origin}/download/${artifact.id}?sig=signed`,
		});
	}
}
