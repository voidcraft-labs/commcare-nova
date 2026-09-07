import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";

/** Real SDK registration, request validation and JSON-RPC dispatch. The linked
 * pair comes from one package; both endpoints close even if setup or a test
 * assertion fails. Handler tests should call tools through this client rather
 * than bypassing the SDK with a captured callback. */
export async function withMcpClient<T>(
	register: (server: McpServer) => void,
	run: (client: Client) => Promise<T>,
): Promise<T> {
	const server = new McpServer({ name: "nova-test", version: "0.0.0" });
	const client = new Client({ name: "nova-test-client", version: "0.0.0" });
	let outcome: { ok: true; value: T } | { ok: false; error: unknown };
	try {
		register(server);
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		outcome = { ok: true, value: await run(client) };
	} catch (error) {
		outcome = { ok: false, error };
	}
	const closed = await Promise.allSettled([client.close(), server.close()]);
	const failures = closed
		.filter((result) => result.status === "rejected")
		.map((result) => result.reason);
	if (failures.length)
		throw new AggregateError(
			outcome.ok ? failures : [outcome.error, ...failures],
			"MCP test or endpoint cleanup failed",
		);
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}
