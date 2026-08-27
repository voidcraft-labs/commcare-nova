/**
 * Build-time contract for Nova's local React profiler harness.
 *
 * The browser bridge can see component props and state, so it is deliberately
 * unavailable unless a development process supplies a complete, ephemeral
 * configuration. Production always resolves to `enabled: false`, even if a
 * stray profiling flag reaches the build environment.
 */

export const REACT_PROFILER_BRIDGE_HOST = "127.0.0.1";

export type ReactProfilerConfig =
	| { enabled: false }
	| {
			enabled: true;
			bridgeHost: typeof REACT_PROFILER_BRIDGE_HOST;
			bridgePort: number;
			browserOrigin: string;
			token: string;
			webSocketSource: string;
	  };

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (!value) {
		throw new Error(
			`React profiling is enabled, but ${name} is missing. Start it through npm run profile:react.`,
		);
	}
	return value;
}

/** Read and validate the shared daemon, CSP, and browser-bridge settings. */
export function readReactProfilerConfig(
	env: NodeJS.ProcessEnv = process.env,
): ReactProfilerConfig {
	if (env.NODE_ENV !== "development" || env.NOVA_REACT_PROFILE !== "1") {
		return { enabled: false };
	}

	const rawPort = required(env, "NOVA_REACT_PROFILE_PORT");
	if (!/^\d{4,5}$/.test(rawPort)) {
		throw new Error(
			"NOVA_REACT_PROFILE_PORT must be an integer from 1024 to 65535.",
		);
	}
	const bridgePort = Number(rawPort);
	if (bridgePort < 1024 || bridgePort > 65_535) {
		throw new Error(
			"NOVA_REACT_PROFILE_PORT must be an integer from 1024 to 65535.",
		);
	}

	const token = required(env, "NOVA_REACT_PROFILE_TOKEN");
	if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
		throw new Error(
			"NOVA_REACT_PROFILE_TOKEN must be a 32 to 128 character base64url token.",
		);
	}

	const browserOrigin = required(env, "NOVA_REACT_PROFILE_ORIGIN");
	let parsedOrigin: URL;
	try {
		parsedOrigin = new URL(browserOrigin);
	} catch {
		throw new Error(
			"NOVA_REACT_PROFILE_ORIGIN must be a loopback HTTP origin.",
		);
	}
	if (
		parsedOrigin.protocol !== "http:" ||
		!(["127.0.0.1", "localhost"] as const).includes(
			parsedOrigin.hostname as "127.0.0.1" | "localhost",
		) ||
		parsedOrigin.username !== "" ||
		parsedOrigin.password !== "" ||
		parsedOrigin.pathname !== "/" ||
		parsedOrigin.search !== "" ||
		parsedOrigin.hash !== ""
	) {
		throw new Error(
			"NOVA_REACT_PROFILE_ORIGIN must be a loopback HTTP origin.",
		);
	}

	return {
		enabled: true,
		bridgeHost: REACT_PROFILER_BRIDGE_HOST,
		bridgePort,
		browserOrigin: parsedOrigin.origin,
		token,
		webSocketSource: `ws://${REACT_PROFILER_BRIDGE_HOST}:${bridgePort}`,
	};
}
