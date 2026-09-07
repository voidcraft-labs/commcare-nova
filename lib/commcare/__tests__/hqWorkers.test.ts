/** Native request/response tests against the HQ worker resource wire contract. */
import { afterEach, expect, it, vi } from "vitest";
import {
	readHttpRequestBody,
	withHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import { log } from "@/lib/logger";
import {
	createHqMobileWorker,
	findHqMobileWorkers,
	updateHqMobileWorker,
} from "../hq/workers";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HOST = "https://india.commcarehq.org",
	PATH = "/a/clinic/api/user/v1/",
	SEARCH = "/a/clinic/api/bulk-user/v1/";
const username = "amina@clinic.commcarehq.org";
const worker = {
	username: "amina",
	password: "Generated-fixture-credential",
	firstName: "Amina",
	lastName: "Osei",
	email: "amina@example.org",
	userData: { cadre: "community" },
};
const create = () => createHqMobileWorker(CREDS, "clinic", worker);
const update = () =>
	updateHqMobileWorker(CREDS, "clinic", "worker-1", {
		userData: { cadre: "community" },
	});
const unknownWrite = {
	success: false,
	status: 502,
	message: "",
	mayHaveLanded: true,
};
afterEach(() => vi.useRealTimers());

it("searches several exact usernames through the native ES query and excludes near misses", async () => {
	await withHttpPeer(async (peer) => {
		const names = [username, "joseph@clinic.commcarehq.org"];
		peer
			.get(HOST)
			.intercept({ path: (path) => path.startsWith(SEARCH), method: "GET" })
			.reply(200, {
				objects: [
					{ id: "worker-1", username },
					{ id: "worker-2", username: "amina.b@clinic.commcarehq.org" },
				],
			});
		expect(await findHqMobileWorkers(CREDS, "clinic", names)).toEqual([
			{ userId: "worker-1", username },
		]);
		const calls = peer.getCallHistory()?.calls();
		expect(calls).toHaveLength(1);
		const url = new URL(calls?.[0]?.fullUrl ?? "");
		expect(url.origin + url.pathname).toBe(HOST + SEARCH);
		expect([...url.searchParams]).toEqual([
			[
				"q",
				'username:"amina@clinic.commcarehq.org" OR username:"joseph@clinic.commcarehq.org"',
			],
			["fields", "id"],
			["fields", "username"],
			["limit", "8"],
		]);
	});
});

it("refuses malformed and ambiguous search evidence instead of treating it as an available name", async () => {
	await withHttpPeer(async (peer) => {
		const found = { id: "worker-1", username };
		for (const data of [
			null,
			{},
			{ objects: null },
			{ objects: [null] },
			{ objects: [{ username }] },
			{ objects: [{ id: "../other", username }] },
			{ objects: [found, found] },
			{ objects: [found, { id: "worker-2", username }] },
		]) {
			peer
				.get(HOST)
				.intercept({ path: (path) => path.startsWith(SEARCH), method: "GET" })
				.reply(200, JSON.stringify(data));
			expect(
				await findHqMobileWorkers(CREDS, "clinic", [username]),
				JSON.stringify(data),
			).toEqual({ success: false, status: 502 });
		}
		peer
			.get(HOST)
			.intercept({ path: (path) => path.startsWith(SEARCH), method: "GET" })
			.reply(200, { objects: [] });
		expect(await findHqMobileWorkers(CREDS, "clinic", [username])).toEqual([]);
		expect(await findHqMobileWorkers(CREDS, "clinic", [])).toEqual([]);
		expect(
			await findHqMobileWorkers(CREDS, "clinic", Array(101).fill(username)),
		).toEqual({ success: false, status: 400 });
		expect(peer.getCallHistory()?.calls()).toHaveLength(9);
	});
});

it("serializes create-only credentials and paired location assignment, then reads the acknowledged identity", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({
				path: PATH,
				method: "POST",
				headers: {
					authorization: "ApiKey account:key",
					"content-type": "application/json",
				},
			})
			.reply(async (request) => {
				expect(
					JSON.parse((await readHttpRequestBody(request)).toString()),
				).toEqual({
					username: "amina",
					password: worker.password,
					first_name: "Amina",
					last_name: "Osei",
					email: "amina@example.org",
					user_data: { cadre: "community" },
					primary_location: "place-1",
					locations: ["place-1", "place-2"],
				});
				return { statusCode: 201, data: JSON.stringify({ id: "worker-1" }) };
			});
		expect(
			await createHqMobileWorker(CREDS, "clinic", {
				...worker,
				locations: {
					primaryLocationId: "place-1",
					locationIds: ["place-1", "place-2"],
				},
			}),
		).toEqual({ userId: "worker-1" });
	});
});

it("updates by identity, omits credentials even if present in the input object, and distinguishes clearing from leaving assignments alone", async () => {
	await withHttpPeer(async (peer) => {
		for (const [locations, expected] of [
			[undefined, {}],
			[null, { locations: [] }],
			[
				{ primaryLocationId: "place-1", locationIds: ["place-1", "place-2"] },
				{ primary_location: "place-1", locations: ["place-1", "place-2"] },
			],
		] as const) {
			peer
				.get(HOST)
				.intercept({ path: `${PATH}worker-1/`, method: "PUT" })
				.reply(async (request) => {
					expect(
						JSON.parse((await readHttpRequestBody(request)).toString()),
					).toEqual({
						first_name: "Amina",
						last_name: "Osei",
						email: "amina@example.org",
						user_data: { cadre: "community" },
						...expected,
					});
					return { statusCode: 200, data: JSON.stringify({ id: "worker-1" }) };
				});
			expect(
				await updateHqMobileWorker(CREDS, "clinic", "worker-1", {
					...worker,
					locations,
				}),
			).toEqual({ userId: "worker-1" });
		}
	});
});

it.each([
	{ method: "POST", path: PATH, write: create, good: 201 },
	{ method: "PUT", path: `${PATH}worker-1/`, write: update, good: 200 },
])(
	"requires $method's exact acknowledgement status and worker identity",
	async ({ method, path, write, good }) => {
		await withHttpPeer(async (peer) => {
			for (const data of [
				null,
				{},
				{ id: "" },
				{ id: ".." },
				{ id: 2 },
				...(method === "PUT" ? [{ id: "another-worker" }] : []),
			]) {
				peer
					.get(HOST)
					.intercept({ path, method })
					.reply(good, JSON.stringify(data));
				expect(await write(), JSON.stringify(data)).toEqual(unknownWrite);
			}
			for (const status of [202, good === 200 ? 201 : 200]) {
				peer
					.get(HOST)
					.intercept({ path, method })
					.reply(status, { id: "worker-1" });
				expect(await write()).toEqual(unknownWrite);
			}
		});
	},
);

it("carries known refusal complaints and distinguishes refusal from lost acknowledgements without logging credentials", async () => {
	await withHttpPeer(async (peer) => {
		for (const status of [
			400, 401, 403, 405, 413, 429, 501, 404, 406, 500, 502, 504,
		]) {
			const error = `Peer complaint containing ${worker.password}`;
			peer
				.get(HOST)
				.intercept({ path: PATH, method: "POST" })
				.reply(status, { error });
			expect(await create()).toEqual({
				success: false,
				status,
				message: error,
				edgeRefusal: false,
				mayHaveLanded: [404, 406, 500, 502, 504].includes(status),
			});
		}
		for (const status of [403, 404, 504]) {
			peer
				.get(HOST)
				.intercept({ path: PATH, method: "POST" })
				.reply(
					status,
					`<html><head><title>${status} Gateway</title></head><body><center>nginx</center></body></html>`,
				);
			expect(await create()).toEqual({
				success: false,
				status,
				message: "",
				edgeRefusal: true,
				mayHaveLanded: status >= 500,
			});
		}
		expect(
			JSON.stringify([
				vi.mocked(log.error).mock.calls,
				vi.mocked(log.warn).mock.calls,
			]),
		).not.toContain(worker.password);
	});
});

it.each([
	{ method: "POST", path: PATH, write: create },
	{ method: "PUT", path: `${PATH}worker-1/`, write: update },
])(
	"does not lose $method uncertainty on disconnected or unreadable replies",
	async ({ method, path, write }) => {
		await withHttpPeer(async (peer) => {
			peer
				.get(HOST)
				.intercept({ path, method })
				.replyWithError(new Error("Peer disconnected"));
			expect(await write()).toEqual({ ...unknownWrite, status: 503 });
			peer
				.get(HOST)
				.intercept({ path, method })
				.reply(method === "POST" ? 201 : 200, "<html>Bad gateway</html>");
			expect(await write()).toEqual(unknownWrite);
		});
	},
);

it.each([
	{ method: "POST", path: PATH, run: create },
	{ method: "PUT", path: `${PATH}worker-1/`, run: update },
	{
		method: "GET",
		path: SEARCH,
		run: () => findHqMobileWorkers(CREDS, "clinic", [username]),
	},
])(
	"keeps $method on the selected endpoint and owns its 30-second deadline",
	async ({ method, path, run }) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await withHttpPeer(async (peer) => {
			const match =
				method === "GET" ? (value: string) => value.startsWith(path) : path;
			peer
				.get(HOST)
				.intercept({ path: match, method })
				.reply(307, "Moved", {
					headers: { location: path.replace("clinic", "other") },
				});
			expect(await run()).toEqual({
				success: false,
				status: 307,
				edgeRefusal: false,
				...(method === "GET" ? {} : { message: "", mayHaveLanded: true }),
			});
			expect(vi.getTimerCount()).toBe(0);
			const reached = Promise.withResolvers<void>(),
				release = Promise.withResolvers<void>();
			peer
				.get(HOST)
				.intercept({ path: match, method })
				.reply(async () => {
					reached.resolve();
					await release.promise;
					return { statusCode: 200, data: "{}" };
				});
			const pending = run();
			try {
				await reached.promise;
				await vi.advanceTimersByTimeAsync(30_000);
				expect(await pending).toEqual({
					success: false,
					status: 503,
					...(method === "GET" ? {} : { message: "", mayHaveLanded: true }),
				});
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				release.resolve();
				await pending;
			}
			expect(peer.getCallHistory()?.calls()).toHaveLength(2);
		});
	},
);

it("rejects invalid domains and path-shaped worker IDs before any remote write", async () => {
	await withHttpPeer(async (peer) => {
		for (const id of ["..", ".", "", "../other", "worker?x=y", "worker#hash"])
			expect(await updateHqMobileWorker(CREDS, "clinic", id, {})).toEqual({
				success: false,
				status: 400,
				message: "",
				mayHaveLanded: false,
			});
		expect(await createHqMobileWorker(CREDS, "..", worker)).toEqual({
			success: false,
			status: 400,
			message: "",
			mayHaveLanded: false,
		});
		expect(await findHqMobileWorkers(CREDS, "..", [username])).toEqual({
			success: false,
			status: 400,
		});
		expect(peer.getCallHistory()?.calls()).toHaveLength(0);
	});
});
