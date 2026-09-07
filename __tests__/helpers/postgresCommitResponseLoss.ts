import { createConnection, createServer, type Socket } from "node:net";

/** Forward a real PostgreSQL connection, then disconnect after the server has
 * committed the first INSERT transaction but before its COMMIT response reaches
 * the client. The database really commits; the driver really loses its socket.
 * Use a dedicated pool for the operation under test so fixture writes do not arm
 * the fault. All later connections pass through normally for reconciliation. */
export async function withPostgresCommitResponseLoss<T>(
	uri: string,
	run: (peer: { uri: string; droppedResponses(): number }) => Promise<T>,
	afterCommit?: () => Promise<unknown>,
): Promise<T> {
	const target = new URL(uri);
	if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
		throw new Error(
			"The PostgreSQL fault peer requires an isolated local database",
		);
	}
	const sockets = new Set<Socket>();
	const closed: Promise<void>[] = [];
	function own(socket: Socket) {
		sockets.add(socket);
		closed.push(
			new Promise((resolve) =>
				socket.once("close", () => {
					sockets.delete(socket);
					resolve();
				}),
			),
		);
		return socket;
	}
	let dropped = 0;
	let faultCompletion: Promise<void> | undefined;
	let faultFailure: unknown;
	const server = createServer((frontend) => {
		own(frontend);
		const upstream = own(
			createConnection({
				host: target.hostname,
				port: Number(target.port || 5432),
			}),
		);
		frontend.on("error", () => upstream.destroy());
		upstream.on("error", () => frontend.destroy());
		frontend.on("close", () => upstream.destroy());
		upstream.on("close", () => frontend.destroy());
		frontend.pipe(upstream);
		let pending = Buffer.alloc(0);
		let inserted = false;
		upstream.on("data", (chunk) => {
			pending = Buffer.concat([pending, chunk]);
			// PostgreSQL backend frames are a one-byte type, then a four-byte
			// length (including that length, excluding the type), then payload.
			while (pending.length >= 5) {
				const length = pending.readUInt32BE(1) + 1;
				if (pending.length < length) break;
				const frame = pending.subarray(0, length);
				pending = pending.subarray(length);
				if (frame[0] === 0x43) {
					// CommandComplete
					const command = frame.toString("utf8", 5, length - 1);
					if (command.startsWith("INSERT ")) inserted = true;
					if (command === "COMMIT" && inserted && dropped === 0) {
						dropped++;
						upstream.pause();
						faultCompletion = (async () => {
							try {
								await afterCommit?.();
							} catch (error) {
								faultFailure = error;
							} finally {
								frontend.destroy();
								upstream.destroy();
							}
						})();
						return;
					}
					if (command === "COMMIT" || command === "ROLLBACK") inserted = false;
				}
				if (!frontend.write(frame)) {
					upstream.pause();
					frontend.once("drain", () => upstream.resume());
				}
			}
		});
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address();
		if (address === null || typeof address === "string")
			throw new Error("Missing PostgreSQL fault peer address");
		const proxied = new URL(uri);
		proxied.hostname = "127.0.0.1";
		proxied.port = String(address.port);
		proxied.searchParams.set("sslmode", "disable");
		const result = await run({
			uri: proxied.toString(),
			droppedResponses: () => dropped,
		});
		await faultCompletion;
		if (faultFailure !== undefined) throw faultFailure;
		return result;
	} finally {
		await faultCompletion;
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve, reject) => {
			if (!server.listening) {
				resolve();
				return;
			}
			server.close((error) => (error ? reject(error) : resolve()));
		});
		await Promise.all(closed);
	}
}
