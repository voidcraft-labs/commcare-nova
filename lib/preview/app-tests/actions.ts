"use server";

import { z } from "zod";
import { getSession } from "@/lib/auth-utils";
import { resolveAppScope } from "@/lib/db/appAccess";
import { listAppTests, readAppTestSteps } from "@/lib/db/appTests";

async function scope(appId: string) {
	z.string().min(1).max(255).parse(appId);
	const session = await getSession();
	if (!session) throw new Error("Sign in to view this app's test journeys.");
	const access = await resolveAppScope(appId, session.user.id, "view");
	return { appId, projectId: access.projectId, actorUserId: session.user.id };
}

export async function listAppTestsAction(appId: string) {
	return listAppTests(await scope(appId));
}

export async function readAppTestAction(appId: string, testId: string) {
	z.uuid().parse(testId);
	return readAppTestSteps({ ...(await scope(appId)), testId });
}
