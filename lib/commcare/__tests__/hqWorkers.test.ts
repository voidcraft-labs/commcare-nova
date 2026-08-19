/**
 * Fetch-level tests for the CommCare HQ mobile-worker driver
 * (`lib/commcare/hq/workers.ts`).
 *
 * Every wire fact asserted here was read in CommCare HQ's own source or
 * pinned by its own tests, never inferred from Nova's side:
 *
 *   - the write path is `/a/{domain}/api/user/v1/`
 *     (`api/urls.py`: `v0_5.CommCareUserResource.get_urlpattern('v1')`);
 *   - a create answers **201** with `{"id": "<user_id>"}` and nothing else,
 *     because `::serialize` collapses a POST's bundle to exactly that
 *     (`api/tests/test_user_resources.py::TestCommCareUserResource.test_create`
 *     asserts the 201);
 *   - an update is a PUT on the `user_id`, and every field's complaint is
 *     gathered into ONE 400 `{"error": "The request resulted in the
 *     following errors: ..."}` (`::obj_update`, pinned verbatim by
 *     `::test_update_fails`);
 *   - the username is create-only — `::test_update_fails` proves sending
 *     it on a PUT is `"Attempted to update unknown or non-editable field
 *     'username'"`;
 *   - `primary_location` and `locations` travel together
 *     (`api/user_updates.py::CommcareUserUpdates._validate_locations`), and
 *     an empty `locations` alone reaches `::_remove_all_locations`;
 *   - and the only username filter anywhere is the Elasticsearch-backed
 *     `bulk-user` resource, because `v0_1.py::CommCareUserResource.obj_get_list`
 *     supports `group` and `archived` and nothing else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createHqMobileWorker,
	findHqMobileWorkers,
	updateHqMobileWorker,
} from "../hq/workers";

const CREDS = {
	username: "user@example.org",
	apiKey: "abc123",
	server: "production",
} as const;
const DOMAIN = "myproject";
const BASE = "https://www.commcarehq.org";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

let fetchMock: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	fetchMock = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
	fetchMock.mockRestore();
});

function lastCall(): [string, RequestInit] {
	return fetchMock.mock.calls.at(-1) as [string, RequestInit];
}

function lastBody(): Record<string, unknown> {
	return JSON.parse(String(lastCall()[1].body));
}

describe("findHqMobileWorkers", () => {
	it("asks the Elasticsearch resource and keeps only exact matches", async () => {
		// `q` goes straight into an ES `query_string`
		// (`v0_5.py::user_es_call`), so a near miss is a real possibility
		// and trusting the answer would report somebody else's account as
		// this persona's.
		fetchMock.mockResolvedValue(
			jsonResponse({
				objects: [
					{ id: "u1", username: `amina@${DOMAIN}.commcarehq.org` },
					{ id: "u2", username: `amina.b@${DOMAIN}.commcarehq.org` },
				],
			}),
		);

		const result = await findHqMobileWorkers(CREDS, DOMAIN, [
			`amina@${DOMAIN}.commcarehq.org`,
		]);
		expect(result).toEqual([
			{ userId: "u1", username: `amina@${DOMAIN}.commcarehq.org` },
		]);

		const url = new URL(String(lastCall()[0]));
		expect(url.pathname).toBe(`/a/${DOMAIN}/api/bulk-user/v1/`);
		expect(url.searchParams.getAll("fields")).toEqual(["id", "username"]);
		expect(url.searchParams.get("q")).toContain(
			`username:"amina@${DOMAIN}.commcarehq.org"`,
		);
		expect(
			(lastCall()[1].headers as Record<string, string>).Authorization,
		).toBe(`ApiKey ${CREDS.username}:${CREDS.apiKey}`);
	});

	it("asks one question for several usernames", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ objects: [] }));
		await findHqMobileWorkers(CREDS, DOMAIN, [
			`amina@${DOMAIN}.commcarehq.org`,
			`joseph@${DOMAIN}.commcarehq.org`,
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(new URL(String(lastCall()[0])).searchParams.get("q")).toBe(
			`username:"amina@${DOMAIN}.commcarehq.org" OR username:"joseph@${DOMAIN}.commcarehq.org"`,
		);
	});

	it("asks nothing when there is nothing to ask about", async () => {
		expect(await findHqMobileWorkers(CREDS, DOMAIN, [])).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses rather than reporting every username as free", async () => {
		// `BulkUserResource` needs `edit_commcare_users`
		// (`RequirePermissionAuthentication`). Reading that refusal as "no
		// accounts exist" would send a create for every name and write over
		// whoever holds them.
		fetchMock.mockResolvedValue(new Response("", { status: 403 }));
		const result = await findHqMobileWorkers(CREDS, DOMAIN, [
			`amina@${DOMAIN}.commcarehq.org`,
		]);
		expect(result).toEqual({
			success: false,
			status: 403,
			edgeRefusal: false,
		});
	});
});

describe("createHqMobileWorker", () => {
	it("posts the bare username with a password and reads the id back", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ id: "u9" }, 201));

		const result = await createHqMobileWorker(CREDS, DOMAIN, {
			username: "amina",
			password: "Sup3r-secret!x",
			userData: { cadre: "community" },
		});
		expect(result).toEqual({ userId: "u9" });

		expect(String(lastCall()[0])).toBe(`${BASE}/a/${DOMAIN}/api/user/v1/`);
		expect(lastCall()[1].method).toBe("POST");
		expect(lastBody()).toEqual({
			// Bare: `users/util.py::generate_mobile_username` appends the
			// project space's own suffix, and sending a complete one would
			// have to match `cc_user_domain` exactly to be accepted.
			username: "amina",
			password: "Sup3r-secret!x",
			user_data: { cadre: "community" },
		});
	});

	it("sends a place assignment only as a pair", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ id: "u9" }, 201));
		await createHqMobileWorker(CREDS, DOMAIN, {
			username: "amina",
			password: "Sup3r-secret!x",
			locations: { primaryLocationId: "l1", locationIds: ["l1", "l2"] },
		});
		expect(lastBody()).toMatchObject({
			primary_location: "l1",
			locations: ["l1", "l2"],
		});
	});

	it("passes CommCare HQ's own refusal through, verbatim", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(
				{
					error:
						"Username 'amina@myproject.commcarehq.org' is already taken or reserved.",
				},
				400,
			),
		);
		const result = await createHqMobileWorker(CREDS, DOMAIN, {
			username: "amina",
			password: "Sup3r-secret!x",
		});
		expect(result).toEqual({
			success: false,
			status: 400,
			message:
				"Username 'amina@myproject.commcarehq.org' is already taken or reserved.",
			edgeRefusal: false,
			/* A 400 is the one status that settles it: every `BadRequest` in
			 * `v0_5.py::CommCareUserResource.obj_create` is raised BEFORE
			 * `CommCareUser.create`, so nothing was made. */
			mayHaveLanded: false,
		});
	});

	it("refuses an answer that carries no id", async () => {
		// Without an id there is nothing to record, and recording nothing
		// would make the next call create a second account for the same
		// persona.
		fetchMock.mockResolvedValue(jsonResponse({}, 201));
		const result = await createHqMobileWorker(CREDS, DOMAIN, {
			username: "amina",
			password: "Sup3r-secret!x",
		});
		/* Not `mayHaveLanded: false` — CommCare HQ answered 201, so the
		 * account is there. Only which account is unknown. */
		expect(result).toEqual({
			success: false,
			status: 502,
			message: "",
			mayHaveLanded: true,
		});
	});
});

/**
 * Whether a refusal rules out a write.
 *
 * This is the whole reason `mayHaveLanded` exists.
 * `v0_5.py::CommCareUserResource.obj_create` wraps its creation in
 * `except Exception:` and retires whatever it made before re-raising, but
 * the account is committed before tastypie serializes the answer, so a
 * failure past that point is a live worker AND a 5xx. A real project
 * space handed Nova exactly that, and the caller holds the only copy of
 * that account's password.
 */
describe("what a refusal rules out", () => {
	it("cannot rule out a create that answered 5xx", async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, 500));
		const result = await createHqMobileWorker(CREDS, DOMAIN, {
			username: "amina",
			password: "Sup3r-secret!x",
		});
		expect(result).toMatchObject({ status: 500, mayHaveLanded: true });
	});

	it("rules out a permission refusal, which never reaches the view", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ error: "no" }, 403));
		const result = await createHqMobileWorker(CREDS, DOMAIN, {
			username: "amina",
			password: "Sup3r-secret!x",
		});
		expect(result).toMatchObject({ status: 403, mayHaveLanded: false });
	});

	it("cannot rule out a gateway that gave up waiting", async () => {
		/* An edge answer is NOT evidence nothing happened. A proxy refusing
		 * is a 4xx; a proxy answering 502 or 504 means it forwarded the
		 * request and then stopped waiting, so CommCare HQ most likely ran
		 * it. Reading nginx's own page as "never arrived" would discard the
		 * password for a live account, which is the one outcome this whole
		 * path exists to prevent. */
		fetchMock.mockResolvedValue(
			new Response(
				"<html><head><title>504 Gateway Time-out</title></head><body><center>nginx</center></body></html>",
				{ status: 504, headers: { "Content-Type": "text/html" } },
			),
		);
		const result = await createHqMobileWorker(CREDS, DOMAIN, {
			username: "amina",
			password: "Sup3r-secret!x",
		});
		expect(result).toMatchObject({
			status: 504,
			/* Still reported, because the status says nothing about the key
			 * or the account's permissions. It just does not settle this. */
			edgeRefusal: true,
			mayHaveLanded: true,
		});
	});

	it("rules out the statuses raised before the view runs", async () => {
		/* `resources.py::dispatch` runs `method_check`, `is_authenticated`
		 * and `throttle_check` before it calls the method, so each of these
		 * provably never reached `obj_create`. Reporting a password for an
		 * account CommCare HQ certainly did not make would send somebody
		 * hunting through their project space for nothing, and teach them
		 * to skip the warning next time. */
		for (const status of [405, 413, 429, 501]) {
			fetchMock.mockResolvedValue(jsonResponse({}, status));
			expect(
				await createHqMobileWorker(CREDS, DOMAIN, {
					username: "amina",
					password: "Sup3r-secret!x",
				}),
			).toMatchObject({ status, mayHaveLanded: false });
		}
	});

	it("rules out an edge that refused, and only when it refused", async () => {
		/* The two halves of an edge answer point opposite ways. A 4xx from
		 * the proxy is a refusal, so CommCare HQ never saw the request. */
		const page = (title: string) =>
			`<html><head><title>${title}</title></head><body><center>nginx</center></body></html>`;
		fetchMock.mockResolvedValue(
			new Response(page("403 Forbidden"), {
				status: 403,
				headers: { "Content-Type": "text/html" },
			}),
		);
		expect(
			await createHqMobileWorker(CREDS, DOMAIN, {
				username: "amina",
				password: "Sup3r-secret!x",
			}),
		).toMatchObject({ edgeRefusal: true, mayHaveLanded: false });

		/* A 404 from the proxy did not route it either — which the status
		 * alone cannot say, because tastypie raises 404 over a live
		 * account. Only `edgeRefusal` separates the two. */
		fetchMock.mockResolvedValue(
			new Response(page("404 Not Found"), {
				status: 404,
				headers: { "Content-Type": "text/html" },
			}),
		);
		expect(
			await createHqMobileWorker(CREDS, DOMAIN, {
				username: "amina",
				password: "Sup3r-secret!x",
			}),
		).toMatchObject({ edgeRefusal: true, mayHaveLanded: false });
	});

	it("cannot rule out a 404, which tastypie raises over a live account", async () => {
		/* `Meta.always_return_data` is true, so `resources.py::post_list`
		 * runs `full_dehydrate` AFTER `obj_create` committed, and
		 * `::get_response_class_for_exception` turns an `ObjectDoesNotExist`
		 * raised there into a 404 over a worker that already exists. */
		fetchMock.mockResolvedValue(jsonResponse({}, 404));
		const result = await createHqMobileWorker(CREDS, DOMAIN, {
			username: "amina",
			password: "Sup3r-secret!x",
		});
		expect(result).toMatchObject({ status: 404, mayHaveLanded: true });
	});

	it("cannot rule out a request that never got an answer", async () => {
		fetchMock.mockRejectedValue(new Error("socket hang up"));
		const result = await createHqMobileWorker(CREDS, DOMAIN, {
			username: "amina",
			password: "Sup3r-secret!x",
		});
		expect(result).toMatchObject({ status: 503, mayHaveLanded: true });
	});

	it("cannot rule out an update that answered 5xx", async () => {
		// The account is not in doubt here; how much of the change took is.
		fetchMock.mockResolvedValue(jsonResponse({}, 502));
		const result = await updateHqMobileWorker(CREDS, DOMAIN, "u9", {
			userData: { cadre: "chw" },
		});
		expect(result).toMatchObject({ status: 502, mayHaveLanded: true });
	});
});

describe("updateHqMobileWorker", () => {
	it("puts on the user id and never carries a password", async () => {
		// A password on a PUT resets the account of somebody who is using
		// it, and an update is exactly what an adopted account gets. The
		// type has no field for one; this proves the wire agrees.
		fetchMock.mockResolvedValue(jsonResponse({}, 200));

		const result = await updateHqMobileWorker(CREDS, DOMAIN, "u9", {
			userData: { cadre: "community" },
		});
		expect(result).toEqual({ userId: "u9" });

		expect(String(lastCall()[0])).toBe(`${BASE}/a/${DOMAIN}/api/user/v1/u9/`);
		expect(lastCall()[1].method).toBe("PUT");
		expect(lastBody()).toEqual({ user_data: { cadre: "community" } });
		expect("password" in lastBody()).toBe(false);
		expect("username" in lastBody()).toBe(false);
	});

	it("clears every place with an empty list and no primary", async () => {
		// `::_update_location` reaches `_remove_all_locations` only when
		// both are falsy; supplying one alone raises "Both primary_location
		// and locations must be provided together."
		fetchMock.mockResolvedValue(jsonResponse({}, 200));
		await updateHqMobileWorker(CREDS, DOMAIN, "u9", { locations: null });
		expect(lastBody()).toEqual({ locations: [] });
	});

	it("leaves places alone when it has nothing to say about them", async () => {
		// Both keys absent makes `::_update_location` return before doing
		// anything, which is what an app with no organization means.
		fetchMock.mockResolvedValue(jsonResponse({}, 200));
		await updateHqMobileWorker(CREDS, DOMAIN, "u9", { userData: {} });
		const body = lastBody();
		expect("locations" in body).toBe(false);
		expect("primary_location" in body).toBe(false);
	});

	it("passes the one gathered sentence through", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(
				{
					error:
						"The request resulted in the following errors: Could not find location ids: l7.",
				},
				400,
			),
		);
		const result = await updateHqMobileWorker(CREDS, DOMAIN, "u9", {
			locations: { primaryLocationId: "l7", locationIds: ["l7"] },
		});
		expect(result).toEqual({
			success: false,
			status: 400,
			message:
				"The request resulted in the following errors: Could not find location ids: l7.",
			edgeRefusal: false,
			/* `obj_update` raises its gathered errors before
			 * `bundle.obj.save()`, and the two fields Nova sends are both
			 * in memory until that call, so the worker is as it was. */
			mayHaveLanded: false,
		});
	});

	it("refuses an id it cannot put in a path", async () => {
		const result = await updateHqMobileWorker(CREDS, DOMAIN, "../admin", {});
		expect(result).toEqual({
			success: false,
			status: 400,
			message: "",
			mayHaveLanded: false,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
