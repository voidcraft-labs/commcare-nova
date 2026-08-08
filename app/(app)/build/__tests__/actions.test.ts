import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseAppMaterializationReceipt } from "@/components/chat/ChatContainer";
import { CommitReauthError } from "@/lib/db/commitGuard";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { canonicalAppGenesis } from "@/lib/doc/scaffolds";
import type { BlueprintDoc } from "@/lib/doc/types";

const mocks = vi.hoisted(() => {
	class MockAppAccessError extends Error {}
	return {
		AppAccessError: MockAppAccessError,
		createExplicitBlankApp: vi.fn(),
		getSession: vi.fn(),
		resolveProjectAccess: vi.fn(),
		revalidatePath: vi.fn(),
	};
});

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth-utils", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/db/appAccess", () => ({
	AppAccessError: mocks.AppAccessError,
	resolveProjectAccess: mocks.resolveProjectAccess,
}));
vi.mock("@/lib/db/appGenesis", () => ({
	createExplicitBlankApp: mocks.createExplicitBlankApp,
	genesisBatchId: (appId: string) => `genesis:${appId}`,
}));

import { createStarterApp } from "../actions";

/** What `createExplicitBlankApp` really hands back: the canonical starter, admitted through
 *  the same gate the database write runs behind. */
function canonicalReceipt(appId: string) {
	const empty: BlueprintDoc = {
		appId,
		appName: "",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
	const genesis = canonicalAppGenesis(empty);
	const verdict = mutationCommitVerdict(
		empty,
		genesis.mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok) throw new Error("canonical genesis must commit");
	return {
		appId,
		baseSeq: 1 as const,
		snapshotDigest: "ab".repeat(32),
		blueprint: toPersistableDoc(verdict.nextDoc),
		starter: {
			moduleUuid: genesis.moduleUuid,
			formUuid: genesis.formUuid,
			fieldUuid: genesis.fieldUuid,
		},
	};
}

describe("createStarterApp Project binding", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
		mocks.resolveProjectAccess.mockResolvedValue({
			projectId: "project-seeded-by-build-new",
			role: "editor",
			actorUserId: "user-1",
		});
		mocks.createExplicitBlankApp.mockResolvedValue(canonicalReceipt("app-1"));
	});

	it("creates in the server-rendered Project even after another tab changes the active Project", async () => {
		const result = await createStarterApp("project-seeded-by-build-new");
		expect(result.success).toBe(true);

		expect(mocks.resolveProjectAccess).toHaveBeenCalledWith(
			"user-1",
			"project-seeded-by-build-new",
			"edit",
		);
		expect(mocks.createExplicitBlankApp).toHaveBeenCalledWith(
			"user-1",
			"project-seeded-by-build-new",
			expect.any(String),
			{ status: "complete" },
		);
	});

	/* The blank-app path and the design build's `data-app-materialized` frame
	 * install the new app through the same client-side boundary, so this
	 * action's return value has to satisfy that boundary exactly. If they
	 * drift, the blank-app path stops being able to open its own app. */
	it("returns a receipt the client's creation boundary accepts", async () => {
		const result = await createStarterApp("project-seeded-by-build-new");
		if (!result.success) throw new Error(result.error);

		const activation = parseAppMaterializationReceipt(
			result.receipt as unknown as Record<string, unknown>,
		);
		expect(activation).not.toBeNull();
		expect(activation?.appId).toBe("app-1");
		/* The capability the server gate resolved, never one the caller sent. */
		expect(activation?.projectId).toBe("project-seeded-by-build-new");
		expect(activation?.role).toBe("editor");
		expect(activation?.canEdit).toBe(true);
	});

	it("fails closed when the actor cannot edit the captured Project", async () => {
		mocks.resolveProjectAccess.mockRejectedValue(
			new mocks.AppAccessError("not a member"),
		);

		await expect(
			createStarterApp("project-seeded-by-build-new"),
		).resolves.toEqual({
			success: false,
			error: "You don't have permission to create apps in this Project.",
		});
		expect(mocks.createExplicitBlankApp).not.toHaveBeenCalled();
	});

	it("maps a transaction-time access change without claiming creation succeeded", async () => {
		mocks.createExplicitBlankApp.mockRejectedValue(
			new CommitReauthError("Project access changed"),
		);

		await expect(
			createStarterApp("project-seeded-by-build-new"),
		).resolves.toEqual({
			success: false,
			error: "You don't have permission to create apps in this Project.",
		});
	});
});
