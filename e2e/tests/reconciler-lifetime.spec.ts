import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Pool } from "pg";
import { z } from "zod";
import { expect, test } from "../lib/fixtures";

// The shared fixture is an editor in the multiplayer Project. Only this file
// changes its role, and every exit restores it before the context is retired.
test.use({ storageState: "e2e/.auth/state-mp-b.json" });

test("Back navigation refreshes a member's changed role", async ({ page }) => {
	const fixture = z
		.object({
			appId: z.string(),
			moduleUuid: z.string(),
			userB: z.object({ id: z.string() }),
		})
		.parse(JSON.parse(readFileSync("e2e/.auth/multiplayer.json", "utf8")));
	const connectionString = process.env.NOVA_DB_LOCAL_URL;
	if (!connectionString)
		throw new Error("The lifetime journey requires the local smoke database");
	const pool = new Pool({ connectionString });
	const away = createServer((_request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end(
			"<!doctype html><title>Away</title><main>Away from the builder</main>",
		);
	});
	await new Promise<void>((resolve) => away.listen(0, "127.0.0.1", resolve));
	let originalRole: string | undefined;
	try {
		const membership = await pool.query<{ role: string }>(
			`SELECT m.role FROM auth_member m JOIN apps a ON a.project_id = m."organizationId" WHERE a.id = $1 AND m."userId" = $2`,
			[fixture.appId, fixture.userB.id],
		);
		expect(membership.rows).toHaveLength(1);
		originalRole = membership.rows[0].role;
		expect(originalRole).toBe("editor");
		await page.goto(`/build/${fixture.appId}/${fixture.moduleUuid}`);
		const title = page.locator('[data-testid="editable-title"]:visible');
		await expect(title).toBeEditable();
		const address = away.address();
		if (!address || typeof address === "string")
			throw new Error("No away-page port");
		await page.goto(`http://127.0.0.1:${address.port}`);
		const changed = await pool.query(
			`UPDATE auth_member SET role = 'viewer' WHERE "userId" = $1 AND "organizationId" = (SELECT project_id FROM apps WHERE id = $2)`,
			[fixture.userB.id, fixture.appId],
		);
		expect(changed.rowCount).toBe(1);
		await page.goBack({ waitUntil: "commit" });
		await expect(title).toBeVisible();
		await expect(title).toHaveAttribute("readonly", "");
	} finally {
		try {
			if (originalRole !== undefined) {
				await pool.query(
					`UPDATE auth_member SET role = $1 WHERE "userId" = $2 AND "organizationId" = (SELECT project_id FROM apps WHERE id = $3)`,
					[originalRole, fixture.userB.id, fixture.appId],
				);
			}
		} finally {
			await pool.end();
			away.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				away.close((error) => (error ? reject(error) : resolve())),
			);
		}
	}
});
