/**
 * CommCare HQ settings CRUD — GET / PUT / DELETE.
 *
 * Manages the user's CommCare HQ credentials (API key + username).
 * GET returns a safe public view (never the raw key). PUT validates
 * credentials by streaming progress as NDJSON, testing one domain at
 * a time and bailing on first match (CommCare API keys are scoped to
 * a single domain). DELETE removes all stored credentials.
 */

import { type NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import {
	type CommCareDomain,
	listDomains,
	testDomainAccess,
} from "@/lib/commcare/client";
import {
	deleteCommCareSettings,
	getCommCareSettings,
	saveCommCareSettings,
} from "@/lib/db/settings";
import { log } from "@/lib/log";

// ── Stream event types ──────────────────────────────────────────────

/**
 * NDJSON events emitted during credential verification.
 *
 * The client reads these line-by-line to drive the progress UI.
 * Auth and body validation happen before streaming starts, so those
 * errors use regular HTTP status codes (not stream events).
 */
export type SettingsStreamEvent =
	| { type: "testing"; tested: number; total: number }
	| { type: "complete"; domain: CommCareDomain }
	| { type: "no_access" }
	| { type: "error"; message: string };

// ── GET ─────────────────────────────────────────────────────────────

/**
 * GET /api/settings/commcare
 *
 * Returns the user's CommCare HQ configuration status, username,
 * and authorized domain. Never returns the raw API key.
 */
export async function GET(req: NextRequest) {
	try {
		const session = await requireSession(req);
		const settings = await getCommCareSettings(session.user.id);
		return NextResponse.json(settings);
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new Error("Failed to fetch settings"),
		);
	}
}

// ── PUT ─────────────────────────────────────────────────────────────

/**
 * PUT /api/settings/commcare
 *
 * Validate CommCare HQ credentials and save on success. Streams NDJSON
 * progress events so the client can show "Checking domain X / Y".
 *
 * CommCare API keys are scoped to a single domain, so we test domains
 * one at a time and bail on the first match — no need to enumerate all
 * authorized domains like the old batch approach.
 */
export async function PUT(req: NextRequest) {
	try {
		const session = await requireSession(req);

		let body: { username?: string; apiKey?: string };
		try {
			body = await req.json();
		} catch {
			throw new ApiError("Invalid request body", 400);
		}

		if (!body.username?.trim()) {
			throw new ApiError("Username is required", 400);
		}
		if (!body.apiKey?.trim()) {
			throw new ApiError("API key is required", 400);
		}

		const creds = {
			username: body.username.trim(),
			apiKey: body.apiKey.trim(),
		};
		const userId = session.user.id;
		const encoder = new TextEncoder();

		const stream = new ReadableStream({
			async start(controller) {
				/** Emit an NDJSON event, silently swallowing if the client disconnected. */
				const emit = (event: SettingsStreamEvent) => {
					try {
						controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
					} catch {
						/* Client disconnected — nothing to do. */
					}
				};

				try {
					/* Step 1: Fetch the user's domain list to validate the key. */
					const allDomains = await listDomains(creds);
					if (!Array.isArray(allDomains)) {
						emit({
							type: "error",
							message: settingsErrorMessage(allDomains.status),
						});
						controller.close();
						return;
					}

					if (allDomains.length === 0) {
						emit({
							type: "error",
							message: "No project spaces found for this account.",
						});
						controller.close();
						return;
					}

					/*
					 * Step 2: Test domains one at a time, bail on first match.
					 *
					 * CommCare API keys are scoped to a single domain, so at most one
					 * domain will pass the access check. Testing sequentially gives
					 * the client real-time progress ("Checking 2 / 5") and stops as
					 * soon as the authorized domain is found.
					 */
					emit({ type: "testing", tested: 0, total: allDomains.length });

					let foundDomain: CommCareDomain | null = null;
					for (let i = 0; i < allDomains.length; i++) {
						const domain = allDomains[i];
						const result = await testDomainAccess(creds, domain.name);

						/* Non-boolean = a server error (5xx) — abort. */
						if (typeof result === "object") {
							emit({
								type: "error",
								message: settingsErrorMessage(result.status),
							});
							controller.close();
							return;
						}

						emit({
							type: "testing",
							tested: i + 1,
							total: allDomains.length,
						});

						if (result) {
							foundDomain = domain;
							break;
						}
					}

					if (!foundDomain) {
						emit({ type: "no_access" });
						controller.close();
						return;
					}

					/* Step 3: Save encrypted credentials + authorized domain. */
					await saveCommCareSettings(userId, {
						username: creds.username,
						apiKey: creds.apiKey,
						approvedDomains: [foundDomain],
					});

					emit({ type: "complete", domain: foundDomain });
				} catch (err) {
					log.error("[settings/commcare] stream error", err);
					emit({
						type: "error",
						message: "An unexpected error occurred. Please try again.",
					});
				}

				controller.close();
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "application/x-ndjson",
				"Cache-Control": "no-cache",
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (err) {
		/* Auth or body validation failure — regular JSON error. */
		return handleApiError(
			err instanceof Error ? err : new Error("Failed to save settings"),
		);
	}
}

// ── DELETE ───────────────────────────────────────────────────────────

/**
 * DELETE /api/settings/commcare
 *
 * Remove all stored CommCare HQ credentials.
 */
export async function DELETE(req: NextRequest) {
	try {
		const session = await requireSession(req);
		await deleteCommCareSettings(session.user.id);
		return NextResponse.json({ success: true });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new Error("Failed to delete settings"),
		);
	}
}

// ── Error messages (settings context) ─────────────────────────────

/** Map CommCare HQ status codes to messages appropriate for the settings page. */
function settingsErrorMessage(status: number): string {
	if (status === 401)
		return "Invalid API key. Check that you copied it correctly.";
	if (status === 429)
		return "Rate limited by CommCare HQ. Wait a moment and try again.";
	if (status >= 500) return "CommCare HQ is unavailable. Try again later.";
	return `CommCare HQ returned an error (HTTP ${status}).`;
}
