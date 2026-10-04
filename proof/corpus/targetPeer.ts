/**
 * A CommCare HQ project space as Nova's publish client reads it, served from
 * a loopback HTTP peer.
 *
 * Nova's client builds every URL from the closed server catalog
 * (`lib/commcare/servers.ts::COMMCARE_SERVERS`), so it cannot be pointed at
 * a local address. Instead the peer installs an undici dispatcher whose
 * connector hands every connection to the catalog host a plain socket to
 * the peer, and refuses every other destination, so the client's own
 * `fetch` calls, request construction and response decoding all run as in
 * production. The `https:` origin is spoken as plain HTTP/1.1: the peer
 * proves what Nova sends, not TLS.
 *
 * The peer answers the requests Nova's publish makes of a project space
 * whose feature flags and case search setting a configuration names, each
 * as the HQ view that serves it answers at the pinned commit:
 *
 * - `GET /api/user_domains/v1/` (`api/resources/v0_5.py::UserDomainsResource`,
 *   paginated by `pagination.py::DoesNothingPaginator`): the target domain,
 *   and with `feature_flag=<slug>` the target domain only when that flag is
 *   on for it (`get_object_list` also counts a flag on for the requesting
 *   user, which no configuration sets). The peer knows the slugs of the
 *   flags Nova's probe checks, the only flags Nova asks about, and answers
 *   any other slug with the 400 HQ gives a slug it does not register.
 * - `GET /a/<domain>/phone/search/` (`ota/views.py::search`): with
 *   `SYNC_SEARCH_CASE_CLAIM` off, the outer `required_decorator()` raises
 *   Django's 404; with it on and case search off, `app_aware_search` answers
 *   404 with `CASE_SEARCH_DISABLED_MSG`; with both on, a `text/xml` fixture.
 * - `POST /a/<domain>/fixtures/fixapi/` (`fixtures/views.py::upload_fixture_api`):
 *   recorded, and answered with HQ's success verdict (code 200).
 * - `GET /a/<domain>/apps/source/<app id>/` (`app_manager/views/apps.py::app_source`):
 *   the profile of the app the peer holds.
 * - `POST /a/<domain>/apps/api/import_app/`
 *   (`app_manager/views/app_import_api.py::_handle_import_app`): recorded,
 *   and answered as HQ answers a create (201, no `app_id` field) or an update
 *   (200) of the one app the peer holds, whose id is fixed. Every update is
 *   answered as the first update of the created app, since each one a
 *   capture makes stands for a separate next publish over that same app.
 * - `POST /a/<domain>/apps/api/<app id>/multimedia/`
 *   (`app_import_api.py::_handle_upload_multimedia`): recorded, and answered
 *   as HQ answers a ZIP it accepted for the app a create made (200, with a
 *   `processing_id`); 404 before any create, 400 without the
 *   `bulk_upload_file` field.
 * - `GET /a/<domain>/apps/api/<app id>/multimedia/status/<processing id>/`
 *   (`app_import_api.py::_handle_multimedia_status`, which serves
 *   `hqmedia/cache.py::BulkMultimediaStatusCache.get_response`), with the
 *   fields Nova's poll reads: processing complete, every file of the ZIP
 *   matched and no errors. The peer runs no HQ matching; this answer decides
 *   only which warnings Nova composes after the upload, never another
 *   request.
 *
 * Anything else is answered 404 and recorded as unexpected, so a capture
 * whose client asked for something the peer does not model fails rather
 * than decoding a refusal as an ordinary result.
 */

import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { createConnection } from "node:net";
import AdmZip from "adm-zip";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import type { HqApplicationProfile } from "@/lib/commcare";
import type { CommCareCredentials } from "@/lib/commcare/client";
import { HQ_PRIVATE_FEATURE_FLAG_SYMBOLS } from "@/lib/commcare/projectSpaceCompatibility";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import { domainFeatureFlag } from "@/lib/commcare/surface/gates";

/** `ota/views.py::CASE_SEARCH_DISABLED_MSG`. */
const CASE_SEARCH_DISABLED_MSG = "Case search is not enabled for this project";

/** The processing id the peer answers a media upload with; HQ mints one per upload. */
export const MEDIA_PROCESSING_ID = "nova-proof-media-processing";

/** One request the peer received, with its body exactly as sent. */
export interface PeerRequest {
	readonly method: string;
	/** Path and query, as the request line carried them. */
	readonly path: string;
	readonly contentType: string | undefined;
	readonly body: Buffer;
}

/** What the peer holds of the target project space. */
export interface TargetState {
	readonly credentials: CommCareCredentials;
	readonly domain: string;
	/** Feature flags on for the domain, by symbol (`corehq/toggles/__init__.py`). */
	readonly flags: ReadonlySet<string>;
	/** `CaseSearchConfig.enabled` for the domain. */
	readonly caseSearchEnabled: boolean;
	/** The id HQ answers for the app a create makes, and an update names. */
	readonly appId: string;
}

interface Answer {
	readonly status: number;
	readonly contentType: string;
	readonly body: string;
}

/** The symbol of each flag Nova's probe checks, by the slug its gate entry holds. */
const SYMBOL_BY_SLUG: ReadonlyMap<string, string> = new Map(
	Object.values(HQ_PRIVATE_FEATURE_FLAG_SYMBOLS).map(
		(symbol) => [domainFeatureFlag(symbol).slug, symbol] as const,
	),
);

function json(status: number, body: unknown): Answer {
	return {
		status,
		contentType: "application/json",
		body: JSON.stringify(body),
	};
}

export class TargetPeer {
	readonly requests: PeerRequest[] = [];
	readonly unexpected: PeerRequest[] = [];
	/** The profile HQ holds for the app, once a create has made it. */
	private profile: HqApplicationProfile | undefined;
	/** Whether a create has made the app. */
	private created = false;
	/** How many files the last media upload's ZIP held, which its status reports matched. */
	private mediaFiles: number | undefined;

	constructor(readonly state: TargetState) {}

	/**
	 * Set the profile HQ holds for the app. The capture sets it to what HQ
	 * keeps after the create (or what the caller says HQ holds by the time
	 * of an update), because the peer does not run HQ's create.
	 */
	holdProfile(profile: HqApplicationProfile): void {
		this.profile = profile;
	}

	/** The requests received since `mark`, for one step of a capture. */
	since(mark: number): readonly PeerRequest[] {
		return this.requests.slice(mark);
	}

	async answer(request: PeerRequest): Promise<Answer> {
		const url = new URL(request.path, "http://peer.invalid");
		const domainPath = `/a/${this.state.domain}`;
		const route = `${request.method} ${url.pathname}`;
		if (route === "GET /api/user_domains/v1/") {
			return this.userDomains(url.searchParams.get("feature_flag"));
		}
		if (route === `GET ${domainPath}/phone/search/`) {
			if (!this.state.flags.has("SYNC_SEARCH_CASE_CLAIM")) {
				return { status: 404, contentType: "text/html", body: "Not Found" };
			}
			if (!this.state.caseSearchEnabled) {
				return {
					status: 404,
					contentType: "text/html; charset=utf-8",
					body: CASE_SEARCH_DISABLED_MSG,
				};
			}
			return {
				status: 200,
				contentType: "text/xml; charset=utf-8",
				body: '<results id="case"/>',
			};
		}
		if (route === `POST ${domainPath}/fixtures/fixapi/`) {
			return json(200, { code: 200, message: "Lookup tables uploaded." });
		}
		if (route === `GET ${domainPath}/apps/source/${this.state.appId}/`) {
			if (this.profile === undefined) return json(404, "Application not found");
			return json(200, { profile: this.profile });
		}
		if (route === `POST ${domainPath}/apps/api/import_app/`) {
			const form = await new Response(new Uint8Array(request.body), {
				headers: { "content-type": request.contentType ?? "" },
			}).formData();
			const appId = form.get("app_id");
			if (appId === null) {
				this.created = true;
				return json(201, { success: true, app_id: this.state.appId });
			}
			if (appId !== this.state.appId || this.profile === undefined) {
				return json(404, { success: false, error: "Application not found" });
			}
			return json(200, { success: true, app_id: this.state.appId, version: 2 });
		}
		const media = `${domainPath}/apps/api/${this.state.appId}/multimedia/`;
		if (route === `POST ${media}`) {
			if (!this.created) {
				return json(404, { success: false, error: "Application not found" });
			}
			const form = await new Response(new Uint8Array(request.body), {
				headers: { "content-type": request.contentType ?? "" },
			}).formData();
			const file = form.get("bulk_upload_file");
			if (!(file instanceof Blob)) {
				return json(400, {
					success: false,
					error: "bulk_upload_file is required",
				});
			}
			this.mediaFiles = new AdmZip(Buffer.from(await file.arrayBuffer()))
				.getEntries()
				.filter((entry) => !entry.isDirectory).length;
			return json(200, { success: true, processing_id: MEDIA_PROCESSING_ID });
		}
		if (
			route === `GET ${media}status/${MEDIA_PROCESSING_ID}/` &&
			this.mediaFiles !== undefined
		) {
			return json(200, {
				success: true,
				processing_id: MEDIA_PROCESSING_ID,
				complete: true,
				matched_count: this.mediaFiles,
				unmatched_count: 0,
				unmatched_files: [],
				errors: [],
			});
		}
		this.unexpected.push(request);
		return json(404, { error: `The capture peer does not model ${route}.` });
	}

	private userDomains(featureFlag: string | null): Answer {
		const listed = {
			domain_name: this.state.domain,
			project_name: this.state.domain,
		};
		if (featureFlag === null) {
			return json(200, { objects: [listed], meta: { total_count: 1 } });
		}
		const symbol = SYMBOL_BY_SLUG.get(featureFlag);
		if (symbol === undefined) {
			return json(400, `'${featureFlag}' is not a valid feature flag`);
		}
		const on = this.state.flags.has(symbol);
		return json(200, {
			objects: on ? [listed] : [],
			meta: { total_count: on ? 1 : 0 },
		});
	}
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

/**
 * Run `capture` with Nova's client routed to a peer holding `state`, then
 * restore the previous dispatcher and close the peer and every connection,
 * whether or not the capture succeeded.
 */
export async function withTargetPeer<T>(
	state: TargetState,
	capture: (peer: TargetPeer) => Promise<T>,
): Promise<T> {
	const peer = new TargetPeer(state);
	const expectedAuthorization = `ApiKey ${state.credentials.username}:${state.credentials.apiKey}`;
	const server = createServer(
		// The peer never closes an idle connection itself: the capture closes
		// them all when it ends. Nova's export work runs on this same event
		// loop, and a stretch of it longer than a keep-alive timeout would let
		// the peer's idle timer close a connection undici's pool still offers
		// for the next request, which then fails with ECONNRESET.
		{ keepAliveTimeout: 0 },
		(request: IncomingMessage, response: ServerResponse) => {
			readBody(request)
				.then((body) => {
					const received: PeerRequest = {
						method: request.method ?? "",
						path: request.url ?? "",
						contentType: request.headers["content-type"],
						body,
					};
					peer.requests.push(received);
					return request.headers.authorization === expectedAuthorization
						? peer.answer(received)
						: json(
								401,
								"Username or API Key is incorrect, expired or deactivated",
							);
				})
				.then(
					(answer) => {
						response.writeHead(answer.status, {
							"content-type": answer.contentType,
						});
						response.end(answer.body);
					},
					(error: unknown) => {
						response.destroy(error instanceof Error ? error : undefined);
					},
				);
		},
	);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("The capture peer did not get a loopback port.");
	}
	const host = new URL(COMMCARE_SERVERS[state.credentials.server].baseUrl)
		.hostname;
	const dispatcher = new Agent({
		connect(options, callback) {
			if (options.hostname !== host) {
				callback(
					new Error(
						`The capture routes only ${host} to its peer, and Nova's client asked for ${options.hostname}.`,
					),
					null,
				);
				return;
			}
			// Without noDelay, Nagle's algorithm holds each request's last
			// segment until the peer's delayed acknowledgement, about 40 ms per
			// request; the bytes sent are the same either way.
			const socket = createConnection({
				host: "127.0.0.1",
				port: address.port,
				noDelay: true,
			});
			const failed = (error: Error) => callback(error, null);
			socket.once("error", failed);
			socket.once("connect", () => {
				socket.off("error", failed);
				callback(null, socket);
			});
		},
	});
	const previous = getGlobalDispatcher();
	setGlobalDispatcher(dispatcher);
	try {
		return await capture(peer);
	} finally {
		setGlobalDispatcher(previous);
		await dispatcher.destroy();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
}
