import { globSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { relative, resolve } from "node:path";
import { build } from "esbuild";
import { z } from "zod";

/** Native component peer: actual production components and generated CSS. It
 * proves DOM behavior in Chromium, independently of app routing/persistence. */
export async function componentPeer(
	entryPoint: string,
	workers: readonly { path: string; entryPoint: string }[] = [],
	aliases: Readonly<Record<string, string>> = {},
	browserDefines: Readonly<Record<string, string>> = {},
) {
	// Match only the browser options emitted by installed Next's production
	// define-env compiler. Keep the rest of the server manifest out of the peer.
	const { config } = z
		.object({
			config: z.object({
				basePath: z.string(),
				trailingSlash: z.boolean(),
				skipTrailingSlashRedirect: z.boolean().optional(),
				i18n: z.unknown().transform((value) => Boolean(value)),
				experimental: z.object({
					manualClientBasePath: z.boolean().optional(),
					linkNoTouchStart: z.boolean().optional(),
				}),
				images: z.object({
					deviceSizes: z.array(z.number()),
					imageSizes: z.array(z.number()),
					qualities: z.array(z.number()),
					path: z.string(),
					loader: z.string(),
					dangerouslyAllowSVG: z.boolean(),
					unoptimized: z.boolean(),
				}),
			}),
		})
		.parse(
			JSON.parse(readFileSync(".next/required-server-files.json", "utf8")),
		);
	const outputDirectory = resolve(".component-peer-assets");
	const relativeAliases = new Map(
		Object.entries(aliases).map(([source, target]) => [
			resolve(source.replace(/^@\//, "")),
			target,
		]),
	);
	const bundle = await build({
		entryPoints: [entryPoint],
		alias: { ...aliases },
		plugins: [
			{
				name: "component-boundary-aliases",
				setup(build) {
					build.onResolve({ filter: /^\./ }, (args) => {
						const source = resolve(args.resolveDir, args.path).replace(
							/\.[cm]?[jt]sx?$/,
							"",
						);
						const target = relativeAliases.get(source);
						return target === undefined ? undefined : { path: target };
					});
				},
			},
		],
		bundle: true,
		platform: "browser",
		format: "esm",
		write: false,
		outdir: outputDirectory,
		define: {
			"process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY": '""',
			"process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID": '""',
			...browserDefines,
			"process.env.NODE_ENV": '"production"',
			"process.env.__NEXT_IMAGE_OPTS": JSON.stringify(config.images),
			"process.env.__NEXT_ROUTER_BASEPATH": JSON.stringify(config.basePath),
			"process.env.__NEXT_TRAILING_SLASH": JSON.stringify(config.trailingSlash),
			"process.env.__NEXT_MANUAL_TRAILING_SLASH":
				JSON.stringify(config.skipTrailingSlashRedirect) ?? "undefined",
			"process.env.__NEXT_I18N_SUPPORT": JSON.stringify(config.i18n),
			"process.env.__NEXT_MANUAL_CLIENT_BASE_PATH": JSON.stringify(
				config.experimental.manualClientBasePath ?? false,
			),
			"process.env.__NEXT_LINK_NO_TOUCH_START": JSON.stringify(
				config.experimental.linkNoTouchStart ?? false,
			),
			// Match Next's browser define; its node-only diagnostics import gzip-size.
			"process.env.NEXT_RUNTIME": '""',
			"process.env.__NEXT_CACHE_COMPONENTS": "false",
			"process.env.__NEXT_DEV_SERVER": "false",
			"process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS": "false",
			"process.env.NEXT_PUBLIC_NOVA_BUILD_ID": JSON.stringify(
				process.env.NEXT_PUBLIC_NOVA_BUILD_ID?.trim() || "local",
			),
		},
	});
	const bundledAssets = new Map(
		bundle.outputFiles.map((file) => [
			`/component/${relative(outputDirectory, file.path)}`,
			file.contents,
		]),
	);
	for (const worker of workers) {
		const compiled = await build({
			entryPoints: [worker.entryPoint],
			bundle: true,
			platform: "browser",
			format: "iife",
			write: false,
			define: { "process.env.NODE_ENV": '"production"' },
		});
		if (compiled.outputFiles.length !== 1)
			throw new Error("Expected one worker script");
		bundledAssets.set(worker.path, compiled.outputFiles[0].contents);
	}
	const bundledScripts = [...bundledAssets.keys()].filter((path) =>
		path.endsWith(".js"),
	);
	const bundledStyles = [...bundledAssets.keys()].filter((path) =>
		path.endsWith(".css"),
	);
	if (bundledScripts.length !== 1)
		throw new Error("Expected one component entry script");
	const files = globSync([
		".next/static/chunks/*.css",
		".next/static/media/*",
		"public/xpath-worker/**/*.js",
	]);
	const css = files.filter((file) => file.endsWith(".css"));
	if (!css.length)
		throw new Error(
			"Component browser checks require the production CSS build",
		);
	const assets = new Map(
		files.map((file) => [
			file.slice(
				file.startsWith("public/") ? "public".length : ".next/static".length,
			),
			readFileSync(file),
		]),
	);
	const server = createServer((request, response) => {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		const bundledAsset = bundledAssets.get(path);
		if (bundledAsset !== undefined) {
			response.setHeader(
				"content-type",
				path.endsWith(".css") ? "text/css" : "text/javascript",
			);
			response.end(bundledAsset);
			return;
		}
		const asset = assets.get(path);
		if (asset) {
			response.setHeader(
				"content-type",
				path.endsWith(".css")
					? "text/css"
					: path.endsWith(".js")
						? "text/javascript"
						: "font/woff2",
			);
			response.end(asset);
			return;
		}
		if (path === "/native-image.svg") {
			response.setHeader("content-type", "image/svg+xml");
			response.end(
				'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="purple"/></svg>',
			);
			return;
		}
		if (path === "/favicon.ico") {
			response.writeHead(204);
			response.end();
			return;
		}
		if (path !== "/") {
			response.writeHead(404);
			response.end();
			return;
		}
		response.setHeader("content-type", "text/html");
		response.end(
			`<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Production component evidence</title>${[...css.map((file) => file.slice(".next/static".length)), ...bundledStyles].map((path) => `<link rel="stylesheet" href="${path}">`).join("")}</head><body><main id="root" style="padding:16px;max-width:800px;margin:auto"></main><script type="module" src="${bundledScripts[0]}"></script></body></html>`,
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing component peer port");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}
