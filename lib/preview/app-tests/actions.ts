"use server";

import { z } from "zod";
import { getSession } from "@/lib/auth-utils";
import { resolveAppScope } from "@/lib/db/appAccess";
import { listAppTests, readAppTestSteps } from "@/lib/db/appTests";
import { type AppTestReadWindow, appTestReadWindowSchema } from "./evidence";
import { withCurrentAppTestProof } from "./lookupAccess";

async function scope(appId: string) {
	z.string().min(1).max(255).parse(appId);
	const session = await getSession();
	if (!session) throw new Error("Sign in to view this app's test journeys.");
	const access = await resolveAppScope(appId, session.user.id, "view");
	return {
		appId,
		projectId: access.projectId,
		actorUserId: session.user.id,
		workerGrant: { kind: "session" as const, sessionId: session.session.id },
	};
}

export async function listAppTestsAction(appId: string) {
	return listAppTests(await scope(appId));
}

export async function readAppTestAction(
	appId: string,
	testId: string,
	window: AppTestReadWindow = {},
) {
	z.uuid().parse(testId);
	return readAppTestSteps({
		...(await withCurrentAppTestProof(await scope(appId), { testId })),
		testId,
		...appTestReadWindowSchema.parse(window),
	});
}
