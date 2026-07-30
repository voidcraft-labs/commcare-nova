import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
	return readFileSync(join(process.cwd(), path), "utf8");
}

describe("steady-state app Project tenancy source guard", () => {
	it("keeps persisted app and authoritative write scopes non-nullable", () => {
		expect(source("lib/db/pg.ts")).not.toContain("project_id: string | null");
		expect(source("lib/db/types.ts")).not.toContain(
			"project_id: string | null",
		);
		expect(source("lib/db/applyBlueprintChange.ts")).not.toContain(
			"expectedProjectId: string | null",
		);
		expect(source("lib/db/lookupReferenceEdges.ts")).not.toContain(
			"projectId: string | null",
		);
		expect(source("lib/db/threads.ts")).not.toContain(
			"projectId: string | null",
		);
	});

	it("has no live null-Project authorization or lookup branch", () => {
		const apps = source("lib/db/apps.ts");
		const appAccess = source("lib/db/appAccess.ts");
		const caseAuthorization = source("lib/db/caseMutationAuthorization.ts");
		const attachments = source("lib/db/formAttachments.ts");
		const mediaScan = source("scripts/scan-multimedia-readiness.ts");
		expect(apps).not.toContain("project_id === null");
		expect(apps).not.toContain("project_id !== null");
		expect(apps).not.toContain("legacy app has no Project");
		expect(apps).not.toContain("owner-only recovery");
		expect(apps).not.toContain("LOOKUP_CONTEXT_UNAVAILABLE");
		expect(appAccess).not.toContain("!app?.project_id");
		expect(caseAuthorization).not.toContain("!app?.project_id");
		expect(attachments).not.toContain("!appRow?.project_id");
		expect(attachments).not.toContain("!app?.project_id");
		expect(mediaScan).not.toContain("app.project_id ?? undefined");
	});

	it("represents a missing app separately from its required Project", () => {
		const apps = source("lib/db/apps.ts");
		expect(apps).toContain(
			'{ readonly kind: "found"; readonly projectId: string }',
		);
		expect(apps).toContain('{ readonly kind: "not-found" }');
		expect(apps).not.toContain("Promise<string | null>");
	});
});
