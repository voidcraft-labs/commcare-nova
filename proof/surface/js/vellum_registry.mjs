// Vellum's question types and question menus, and what Vellum's parser reads of
// its own markup, from HQ's vendored Vellum build running headless in the image's
// Chromium (proof/surface/families/vellum.py).
//
//   node vellum_registry.mjs read < request.json
//   node vellum_registry.mjs markup < request.json
//
// `markup` opens one configuration with the request's `form` as the form Vellum
// loads (`core.form`, which Vellum parses while it starts), having wrapped the
// jQuery methods Vellum reads form XML through (its own `xmlAttr` and `popAttr`,
// and `children` and `find`): every attribute name in Vellum's namespace asked of
// an element (`vellum:relevant` of a `<bind>`), and every selector naming an
// element in it (`vellum\:hashtags` among `<h:head>`'s children), with the
// element asked (its prefix and local name, and its path) and the method. A name
// `popAttr` asks is read and dropped from the element. It reads the form twice:
// with Vellum's data sources answered before the form loads, and with them not
// yet answered, the one state in which Vellum reads the form's own hashtags
// (HQ's page loads a form after a delay, whatever its data sources' progress).
//
// The page is the Vellum host the image's editor build makes
// (proof/image/editors/build.mjs, `static/vellum/host.html`): HQ's vendored
// Vellum with HQ's own jQuery, Bootstrap 3, select2 and underscore, and the
// options HQ's form designer page adds to the server's. The request names the
// editor build's static directory, the options HQ's server renders for an
// empty form, and the configurations to open: each a plugin list and a
// features object. Every configuration opens the host in a fresh browser
// context, starts Vellum as HQ's form designer page does (the server's options
// with the page's own merged over them), waits for Vellum's own `onReady`,
// and reads Vellum's registry (`data.core.mugTypes`) and its question menus
// (`getQuestionGroups()`). The page reaches nothing but the local server this
// script owns, which serves the editor build, answers Vellum's data sources
// request with none, and serves the chunks and assets Vellum's own webpack
// runtime asks for beside its script (`/static/vellum/<file>`, from HQ's
// vendored Vellum directory, as HQ serves them beside `main.js`); any other
// request, and any page error, fails the read.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve, sep } from "node:path";

const tools = process.env.PROOF_TOOLS ?? "/opt/proof-tools";
const require = createRequire(join(tools, "package.json"));
const { chromium } = require("playwright-core");

const LOAD_DEADLINE_MS = 60_000;
const HOST_PAGE = "/static/vellum/host.html";
const DATA_SOURCES = "/surface/data-sources";
const CONTENT_TYPES = {
	".js": "application/javascript; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".gif": "image/gif",
	".png": "image/png",
	".svg": "image/svg+xml",
};

function readUnder(root, relative) {
	const file = resolve(root, relative);
	if (!file.startsWith(root + sep)) return null;
	try {
		return { file, body: readFileSync(file) };
	} catch {
		return null;
	}
}

function serve(staticDir, vellumDir, unexpected, state = { hold: false }) {
	const root = resolve(staticDir);
	const vellum = resolve(vellumDir);
	const server = createServer((incoming, response) => {
		const path = decodeURIComponent(
			new URL(incoming.url, "http://localhost").pathname,
		);
		if (path === DATA_SOURCES) {
			if (state.hold) {
				// Held unanswered: the form loads before its data sources, as HQ's page loads one whose
				// data sources take longer than the form.
				state.held.push(response);
				return;
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end("[]");
			return;
		}
		let found = path.startsWith("/static/")
			? readUnder(root, path.slice("/static/".length))
			: null;
		if (!found && path.startsWith("/static/vellum/"))
			found = readUnder(vellum, path.slice("/static/vellum/".length));
		if (!found) {
			unexpected.push(`${incoming.method} ${path}`);
			response.writeHead(404);
			response.end();
			return;
		}
		response.writeHead(200, {
			"Content-Type":
				CONTENT_TYPES[extname(found.file)] ?? "application/octet-stream",
		});
		response.end(found.body);
	});
	return new Promise((done) => {
		server.listen(0, "127.0.0.1", () => done(server));
	});
}

async function readConfiguration(browser, origin, request, configuration) {
	const context = await browser.newContext();
	try {
		const tab = await context.newPage();
		const errors = [];
		tab.on("pageerror", (error) => errors.push(String(error)));
		await context.route("**/*", (route) =>
			route.request().url().startsWith(origin)
				? route.continue()
				: route.abort(),
		);
		await tab.goto(`${origin}${HOST_PAGE}`, { waitUntil: "load" });
		await tab.waitForFunction(() => Boolean(window.proofVellumHost), null, {
			timeout: LOAD_DEADLINE_MS,
		});
		const read = await tab.evaluate(
			async ({ serverOptions, deadline }) => {
				const host = window.proofVellumHost;
				const $ = host.jQuery;
				const _ = host.underscore;
				// As HQ's form designer page starts Vellum (form_designer.js).
				const options = _.extend({}, serverOptions, host.pageOptions());
				const ready = new Promise((done, fail) => {
					options.core = _.extend(options.core, { onReady: done });
					setTimeout(
						() => fail(new Error("Vellum did not call onReady")),
						deadline,
					);
				});
				$("#formdesigner").vellum(options);
				await ready;
				const vellum = $("#formdesigner").vellum("get");
				const types = vellum.data.core.mugTypes;
				return {
					normal: Object.keys(types.normalTypes).sort(),
					auxiliary: Object.keys(types.auxiliaryTypes).sort(),
					all: Object.keys(types.allTypes).sort(),
					menus: vellum.getQuestionGroups().map((group) => ({
						group: group.group[0],
						questions: [...group.questions],
					})),
				};
			},
			{
				serverOptions: {
					...request.options,
					plugins: configuration.plugins,
					features: configuration.features,
					core: {
						...request.options.core,
						dataSourcesEndpoint: `${origin}${DATA_SOURCES}`,
					},
				},
				deadline: LOAD_DEADLINE_MS,
			},
		);
		if (errors.length > 0)
			throw new Error(
				`Vellum raised an error with the configuration ${configuration.name}: ${errors.join("; ")}`,
			);
		return read;
	} finally {
		await context.close();
	}
}

async function readMarkup(browser, origin, request) {
	const context = await browser.newContext();
	try {
		const tab = await context.newPage();
		const errors = [];
		tab.on("pageerror", (error) => errors.push(String(error)));
		await context.route("**/*", (route) =>
			route.request().url().startsWith(origin)
				? route.continue()
				: route.abort(),
		);
		await tab.goto(`${origin}${HOST_PAGE}`, { waitUntil: "load" });
		await tab.waitForFunction(() => Boolean(window.proofVellumHost), null, {
			timeout: LOAD_DEADLINE_MS,
		});
		const read = await tab.evaluate(
			async ({ serverOptions, deadline, prefix }) => {
				const host = window.proofVellumHost;
				const $ = host.jQuery;
				const _ = host.underscore;
				const reads = [];
				const nameOf = (node) =>
					node.prefix ? `${node.prefix}:${node.localName}` : node.localName;
				const pathOf = (node) => {
					const steps = [];
					for (let at = node; at && at.nodeType === 1; at = at.parentNode)
						steps.unshift(at.nodeName);
					return steps.join("/");
				};
				let popping = 0;
				const attributes = (method) => {
					const original = $.fn[method];
					$.fn[method] = function (name, ...rest) {
						const asks =
							typeof name === "string" &&
							name.startsWith(prefix) &&
							rest.length === 0 &&
							!(method === "xmlAttr" && popping > 0);
						if (asks) {
							for (const node of this.toArray())
								if (node && node.nodeType === 1)
									reads.push({
										element: nameOf(node),
										path: pathOf(node),
										attribute: name,
										via: method,
									});
						}
						if (method !== "popAttr") return original.call(this, name, ...rest);
						popping += 1;
						try {
							return original.call(this, name, ...rest);
						} finally {
							popping -= 1;
						}
					};
				};
				const selectors = (method) => {
					const original = $.fn[method];
					$.fn[method] = function (selector, ...rest) {
						if (
							typeof selector === "string" &&
							selector.includes(`${prefix.slice(0, -1)}\\:`)
						) {
							for (const node of this.toArray())
								if (node && node.nodeType === 1)
									reads.push({
										element: nameOf(node),
										path: pathOf(node),
										selector,
										via: method,
									});
						}
						return original.call(this, selector, ...rest);
					};
				};
				attributes("xmlAttr");
				attributes("popAttr");
				selectors("children");
				selectors("find");
				// As HQ's form designer page starts Vellum (form_designer.js), on the given form.
				const options = _.extend({}, serverOptions, host.pageOptions());
				const ready = new Promise((done, fail) => {
					options.core = _.extend(options.core, { onReady: done });
					setTimeout(
						() => fail(new Error("Vellum did not call onReady")),
						deadline,
					);
				});
				$("#formdesigner").vellum(options);
				await ready;
				const vellum = $("#formdesigner").vellum("get");
				return {
					reads,
					parseErrors: [...(vellum.data.core.form.parseErrors ?? [])],
				};
			},
			{
				serverOptions: {
					...request.options,
					plugins: request.configuration.plugins,
					features: request.configuration.features,
					core: {
						...request.options.core,
						form: request.form,
						dataSourcesEndpoint: `${origin}${DATA_SOURCES}`,
					},
				},
				deadline: LOAD_DEADLINE_MS,
				prefix: "vellum:",
			},
		);
		if (errors.length > 0)
			throw new Error(
				`Vellum raised an error loading the markup probe: ${errors.join("; ")}`,
			);
		return read;
	} finally {
		await context.close();
	}
}

async function main(mode) {
	const request = JSON.parse(readFileSync(0, "utf8"));
	const unexpected = [];
	const state = { hold: false, held: [] };
	const server = await serve(
		request.staticDir,
		request.vellumDir,
		unexpected,
		state,
	);
	const origin = `http://127.0.0.1:${server.address().port}`;
	const browser = await chromium.launch();
	try {
		if (mode === "markup") {
			// Once with the data sources answered before the form loads, once with them not yet answered
			// (Vellum reads the form's own hashtags only then: parser.js::parseXForm).
			const out = {};
			for (const hold of [false, true]) {
				state.hold = hold;
				out[hold ? "dataSourcesPending" : "dataSourcesLoaded"] =
					await readMarkup(browser, origin, request);
				for (const response of state.held.splice(0)) response.destroy();
			}
			if (unexpected.length > 0)
				throw new Error(
					`Loading the markup probe, the Vellum host requested what the editor build does not hold: ${unexpected.join(", ")}`,
				);
			process.stdout.write(`${JSON.stringify(out)}\n`);
			return;
		}
		const out = {};
		for (const configuration of request.configurations) {
			out[configuration.name] = await readConfiguration(
				browser,
				origin,
				request,
				configuration,
			);
			if (unexpected.length > 0)
				throw new Error(
					`With the configuration ${configuration.name}, the Vellum host requested what the editor build does not hold: ${unexpected.join(", ")}`,
				);
		}
		process.stdout.write(`${JSON.stringify(out)}\n`);
	} finally {
		await browser.close();
		await new Promise((done) => server.close(done));
	}
}

if (process.argv[2] !== "read" && process.argv[2] !== "markup") {
	throw new Error("usage: node vellum_registry.mjs read|markup < request.json");
}
await main(process.argv[2]);
