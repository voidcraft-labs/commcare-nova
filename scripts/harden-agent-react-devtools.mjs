/**
 * Apply Nova's reviewed hardening to agent-react-devtools@0.4.0.
 *
 * The upstream npm artifact is integrity-pinned, but its daemon binds every
 * interface without authentication and its Next.js connector can initialize
 * in production. npm has no native patch-file mechanism, so postinstall runs
 * this exact-input transformer. Any upstream byte change fails closed instead
 * of applying a fuzzy patch to unaudited code.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(root, "node_modules", "agent-react-devtools");
const expectedVersion = "0.4.0";
const packageJsonPath = path.join(packageRoot, "package.json");

if (!existsSync(packageJsonPath)) {
	const omittedDependencies = (process.env.npm_config_omit ?? "")
		.split(/[\s,]+/)
		.filter(Boolean);
	if (omittedDependencies.includes("dev")) process.exit(0);
	throw new Error(
		"agent-react-devtools is missing even though development dependencies were not omitted.",
	);
}

function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

function replaceOnce(content, before, after, file) {
	const first = content.indexOf(before);
	if (first === -1 || content.indexOf(before, first + before.length) !== -1) {
		throw new Error(
			`Refusing to patch ${file}: expected exactly one audited source fragment.`,
		);
	}
	return content.slice(0, first) + after + content.slice(first + before.length);
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
if (packageJson.version !== expectedVersion) {
	throw new Error(
		`Refusing to patch agent-react-devtools ${packageJson.version}; expected ${expectedVersion}.`,
	);
}

const patches = [
	{
		file: "dist/connect.js",
		beforeSha256:
			"dbd7bf23a021aaec23e7d701817430fd13ac81bdc16e47da9e6ba61cf6453d52",
		afterSha256:
			"b03cdc06761034906f3090e7e476b67aab2706f3526c84377d2036dd888ce96d",
		marker: "nova-profile-hardening-v1: browser bridge is explicit opt-in",
		transform(content, file) {
			let next = replaceOnce(
				content,
				`function getHost() {
  return getMeta("agent-react-devtools-host") || "localhost";
}`,
				`function getHost() {
  return getMeta("agent-react-devtools-host") || "localhost";
}
function getToken() {
  return getMeta("agent-react-devtools-token");
}`,
				file,
			);
			next = replaceOnce(
				next,
				`if (!isSSR && !isProd) {`,
				`// nova-profile-hardening-v1: browser bridge is explicit opt-in
var isEnabled = !isSSR && getToken() !== null;
if (!isSSR && !isProd && isEnabled) {`,
				file,
			);
			next = replaceOnce(
				next,
				`var ready = isSSR || isProd ? noop() : connect();`,
				`var ready = isSSR || isProd || !isEnabled ? noop() : connect();`,
				file,
			);
			next = replaceOnce(
				next,
				`    const port = getPort();
    const host = getHost();
    return new Promise((resolve) => {
      try {
        const ws = new WebSocket(\`ws://\${host}:\${port}\`);`,
				`    const port = getPort();
    const host = getHost();
    const token = getToken();
    if (!token) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        const ws = new WebSocket(\`ws://\${host}:\${port}/?token=\${encodeURIComponent(token)}\`);`,
				file,
			);
			return next;
		},
	},
	{
		file: "dist/daemon.js",
		beforeSha256:
			"054f0208cf24c83bf21b5fa6928705f1e4b1f369c24284292cd8901a02087d8a",
		afterSha256:
			"47915ae28b224a092377c17f3cec9c1eb0c0cc49cd7f454574179733c371180d",
		marker: "nova-profile-hardening-v1: authenticated loopback bridge",
		transform(content, file) {
			let next = replaceOnce(
				content,
				`      this.wss = new WebSocketServer({ port: this.port }, () => {
        resolve();
      });`,
				`      // nova-profile-hardening-v1: authenticated loopback bridge
      const expectedToken = process.env.NOVA_REACT_PROFILE_TOKEN;
      const expectedOrigin = process.env.NOVA_REACT_PROFILE_ORIGIN;
      if (!expectedToken || !expectedOrigin) {
        reject(new Error("Nova's React profiler daemon requires an ephemeral token and browser origin"));
        return;
      }
      this.wss = new WebSocketServer({
        port: this.port,
        host: "127.0.0.1",
        maxPayload: 16 * 1024 * 1024,
        verifyClient: ({ origin, req }) => {
          if (this.connections.size !== 0 || origin !== expectedOrigin) return false;
          try {
            const candidate = new URL(req.url || "/", "ws://127.0.0.1").searchParams.get("token");
            return candidate === expectedToken;
          } catch {
            return false;
          }
        }
      }, () => {
        resolve();
      });`,
				file,
			);
			next = replaceOnce(
				next,
				`            const msg = JSON.parse(data.toString());
            this.handleMessage(ws, msg);`,
				`            const msg = JSON.parse(data.toString());
            if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.event !== "string") return;
            if (msg.event === "operations" && (
              !Array.isArray(msg.payload) ||
              msg.payload.length > 250000 ||
              msg.payload.some((value) => typeof value !== "number" || !Number.isFinite(value))
            )) return;
            this.handleMessage(ws, msg);`,
				file,
			);
			next = replaceOnce(
				next,
				`    fs.mkdirSync(STATE_DIR, { recursive: true });`,
				`    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 448 });
    fs.chmodSync(STATE_DIR, 448);`,
				file,
			);
			next = replaceOnce(
				next,
				`    fs.writeFileSync(getDaemonInfoPath(), JSON.stringify(info, null, 2));`,
				`    fs.writeFileSync(getDaemonInfoPath(), JSON.stringify(info, null, 2), { mode: 384 });
    fs.chmodSync(getDaemonInfoPath(), 384);`,
				file,
			);
			next = replaceOnce(
				next,
				`      this.ipcServer.listen(socketPath, () => {
        resolve();
      });`,
				`      this.ipcServer.listen(socketPath, () => {
        fs.chmodSync(socketPath, 384);
        resolve();
      });`,
				file,
			);
			next = replaceOnce(
				next,
				`  for (const [key, value] of Object.entries(record)) {
    cleaned[key] = cleanDehydrated(value);
  }`,
				`  for (const [key, value] of Object.entries(record)) {
    cleaned[key] = /token|secret|password|authorization|cookie|credential|api.?key/i.test(key)
      ? "[redacted]"
      : cleanDehydrated(value);
  }`,
				file,
			);
			return next;
		},
	},
	{
		file: "dist/cli.js",
		beforeSha256:
			"39d1b8287c7850e40950a60268a089ac706b87e82a7c7c7fec9bddcc9db6bed0",
		afterSha256:
			"345a716a8e193c433d5e90f7314ba1014156c6cac13a96f842e31427a8148e1a",
		marker: "nova-profile-hardening-v1: bound inspected string output",
		transform(content, file) {
			return replaceOnce(
				content,
				`  if (typeof val === "string") return \`"\${val}"\`;`,
				`  // nova-profile-hardening-v1: bound inspected string output
  if (typeof val === "string") {
    const compact = val.length > 60 ? val.slice(0, 57) + "..." : val;
    return JSON.stringify(compact);
  }`,
				file,
			);
		},
	},
];

for (const patch of patches) {
	const filePath = path.join(packageRoot, patch.file);
	const content = readFileSync(filePath, "utf8");
	const currentHash = sha256(content);
	if (patch.afterSha256 && currentHash === patch.afterSha256) continue;
	if (!patch.afterSha256 && content.includes(patch.marker)) continue;
	if (currentHash !== patch.beforeSha256) {
		throw new Error(
			`Refusing to patch ${patch.file}: audited SHA-256 ${patch.beforeSha256}, found ${currentHash}.`,
		);
	}
	const hardened = patch.transform(content, patch.file);
	if (!hardened.includes(patch.marker)) {
		throw new Error(`Hardening marker was not written to ${patch.file}.`);
	}
	const hardenedHash = sha256(hardened);
	if (patch.afterSha256 && hardenedHash !== patch.afterSha256) {
		throw new Error(
			`Refusing to write ${patch.file}: hardened SHA-256 ${hardenedHash} does not match ${patch.afterSha256}.`,
		);
	}
	writeFileSync(filePath, hardened, "utf8");
}
