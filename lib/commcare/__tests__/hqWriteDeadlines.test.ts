/** An actual socket proves that cancellation reaches a response body after
 * headers have arrived. In-memory response fixtures cannot establish this. */
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { setImmediate } from "node:timers/promises";
import AdmZip from "adm-zip";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { importApp, uploadAppMediaBundle } from "../client";
import { patchHqLocations } from "../hq/locations";
import { uploadLookupTableWorkbook } from "../hq/lookupTables";
import { createHqMobileWorker, updateHqMobileWorker } from "../hq/workers";

const creds = { username: "account", apiKey: "key", server: "india" } as const;
const zip = new AdmZip().toBuffer();
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
	book,
	XLSX.utils.aoa_to_sheet([["code"], ["001"]]),
	"Data",
);
const workbook = XLSX.write(book, {
	type: "buffer",
	bookType: "xlsx",
}) as Buffer;
const unknownWrite = {
	success: false,
	status: 503,
	message: "",
	mayHaveLanded: true,
};
const cases = [
	{
		name: "app import",
		method: "POST",
		path: "/a/clinic/apps/api/import_app/",
		milliseconds: 60_000,
		status: 200,
		invoke: () =>
			importApp(creds, "clinic", "Visits", {
				doc_type: "Application",
				name: "Visits",
			}),
		expected: { success: false, status: 503 },
	},
	{
		name: "lookup workbook",
		method: "POST",
		path: "/a/clinic/fixtures/fixapi/",
		milliseconds: 60_000,
		status: 200,
		invoke: () =>
			uploadLookupTableWorkbook(creds, "clinic", workbook, { replace: true }),
		expected: unknownWrite,
	},
	{
		name: "location batch",
		method: "PATCH",
		path: "/a/clinic/api/location/v2/",
		milliseconds: 30_000,
		status: 202,
		invoke: () =>
			patchHqLocations(creds, "clinic", [
				{ name: "North", siteCode: "north", locationTypeCode: "region" },
			]),
		expected: unknownWrite,
	},
	{
		name: "worker create",
		method: "POST",
		path: "/a/clinic/api/user/v1/",
		milliseconds: 30_000,
		status: 201,
		invoke: () =>
			createHqMobileWorker(creds, "clinic", {
				username: "amina",
				password: "fixture-password",
			}),
		expected: unknownWrite,
	},
	{
		name: "worker update",
		method: "PUT",
		path: "/a/clinic/api/user/v1/worker-1/",
		milliseconds: 30_000,
		status: 200,
		invoke: () =>
			updateHqMobileWorker(creds, "clinic", "worker-1", { firstName: "Amina" }),
		expected: unknownWrite,
	},
	{
		name: "media upload",
		method: "POST",
		path: "/a/clinic/apps/api/working-app/multimedia/",
		milliseconds: 60_000,
		status: 200,
		invoke: () => uploadAppMediaBundle(creds, "clinic", "working-app", zip),
		expected: { success: false, status: 503 },
	},
] as const;
afterEach(() => vi.useRealTimers());

it.each(
	cases.flatMap((item) =>
		["headers", "body", "refusal body"].map((stage) => ({ ...item, stage })),
	),
)(
	"owns $name through stalled $stage and closes its socket at the deadline",
	async ({
		name,
		invoke,
		expected,
		path,
		method,
		milliseconds,
		status,
		stage,
	}) => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		const reached = Promise.withResolvers<void>(),
			closed = Promise.withResolvers<void>();
		const paths: string[] = [];
		const server = createServer((request, response) => {
			paths.push(`${request.method} ${request.url}`);
			request.resume();
			response.once("close", closed.resolve);
			if (stage !== "headers") {
				response.writeHead(stage === "refusal body" ? 500 : status, {
					"content-type": "application/json",
				});
				response.write('{"incomplete":');
			}
			reached.resolve();
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing socket peer port");
		const previous = getGlobalDispatcher();
		const dispatcher = new Agent({
			connect: (options, callback) => {
				if (options.hostname !== "india.commcarehq.org") {
					callback(new Error("Unexpected HTTP destination"), null);
					return;
				}
				const socket = createConnection({
					host: "127.0.0.1",
					port: address.port,
				});
				const failed = (error: Error) => callback(error, null);
				socket.once("error", failed);
				socket.once("connect", () => {
					socket.off("error", failed);
					callback(null, socket);
				});
			},
		});
		setGlobalDispatcher(dispatcher);
		let settled = false;
		const pending = invoke().then((value) => {
			settled = true;
			return value;
		});
		try {
			await reached.promise;
			await setImmediate();
			await vi.advanceTimersByTimeAsync(milliseconds - 1);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await setImmediate();
			expect(settled).toBe(true);
			expect(await pending).toEqual(
				stage === "refusal body" && !name.startsWith("worker")
					? {
							...expected,
							status: 500,
							...(name === "location batch" ? {} : { edgeRefusal: false }),
						}
					: expected,
			);
			await closed.promise;
			expect(paths).toEqual([`${method} ${path}`]);
		} finally {
			setGlobalDispatcher(previous);
			await dispatcher.destroy();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			await pending;
		}
	},
);
