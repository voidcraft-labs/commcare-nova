import { createHook } from "node:async_hooks";
import { createRequire } from "node:module";

const packageUrl = new URL("../../../../package.json", import.meta.url);
const repositoryUrl = new URL(".", packageUrl);
const require = createRequire(packageUrl);
const { Agent, setGlobalDispatcher } = require("undici");
Error.stackTraceLimit = 40;
const records = new Map();
const hook = createHook({
	init(id, type, trigger) {
		if (type === "BLOBREADER" || type === "PROMISE")
			records.set(id, {
				type,
				trigger,
				stack: new Error().stack?.replaceAll(repositoryUrl.href, "<repo>/"),
				destroyed: false,
				resolved: false,
			});
	},
	promiseResolve(id) {
		if (records.has(id)) records.get(id).resolved = true;
	},
	destroy(id) {
		if (records.has(id)) records.get(id).destroyed = true;
	},
});
hook.enable();
const { createServer } = await import("node:http");
const server = createServer(async (req, res) => {
	try {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const multipart = await new Response(Buffer.concat(chunks), {
			headers: req.headers,
		}).formData();
		await multipart.get("app_file").text();
		res.writeHead(200, { "content-type": "application/json" }).end("{}");
	} catch (error) {
		console.error(error);
		res.writeHead(500).end("{}");
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const peer = new Agent();
setGlobalDispatcher(peer);
const form = new FormData();
form.append(
	"app_file",
	new Blob(["some app bytes"], { type: "application/json" }),
	"app.json",
);
const response = await fetch(
	`http://127.0.0.1:${server.address().port}/upload`,
	{ method: "POST", body: form },
);
await response.json();
await peer.close();
await new Promise((resolve, reject) =>
	server.close((error) => (error ? reject(error) : resolve())),
);
process.once("beforeExit", () => {
	hook.disable();
	console.log(
		JSON.stringify(
			{
				node: process.version,
				bundledUndici: process.versions.undici,
				dispatcherUndici: require("undici/package.json").version,
				phase: "beforeExit after body consumption and transport close",
				resources: [...records].filter(([, r]) => !r.destroyed && !r.resolved),
			},
			null,
			2,
		),
	);
});
