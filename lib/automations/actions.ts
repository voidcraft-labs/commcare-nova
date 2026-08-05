"use server";

import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { getSession } from "@/lib/auth-utils";
import { buildCaseTypeMap, withProjectContext } from "@/lib/case-store";
import { AppAccessError, resolveAppScope } from "@/lib/db/appAccess";
import { automationSchema, ownRecordValue, uuidSchema } from "@/lib/domain";
import { log } from "@/lib/logger";
import { OrganizationError } from "@/lib/organization/errors";
import { readOrganizationAuthoringSnapshot } from "@/lib/organization/service";
import type { OrganizationScope } from "@/lib/organization/types";
import { automationMatchProjection } from "./matching";
import {
	type AutomationSetupGuide,
	buildAutomationSetupGuide,
} from "./setupGuidance";

export type AutomationPreviewResult =
	| {
			readonly success: true;
			readonly data: {
				readonly automationUuid: string;
				readonly blueprintSeq: number;
				readonly organizationRevision: string;
				readonly matching:
					| {
							readonly status: "counted";
							readonly currentMatchCount: number;
					  }
					| {
							readonly status: "unavailable";
							readonly message: string;
					  };
				readonly omittedCriteria: readonly string[];
				readonly setupGuide: AutomationSetupGuide;
				readonly executesLocally: false;
			};
	  }
	| {
			readonly success: false;
			readonly code:
				| "unauthenticated"
				| "not_found"
				| "conflict"
				| "invalid_input"
				| "unavailable";
			readonly message: string;
	  };

const inputSchema = z
	.object({
		appId: z.string().trim().min(1).max(255),
		automationUuid: uuidSchema,
		expectedAutomation: automationSchema,
	})
	.strict();

/**
 * Authoritative Preview projection for one saved automation.
 *
 * It counts only criteria Nova can evaluate against its own case rows and
 * returns every omitted HQ-only condition by name. It never runs an update,
 * sends content, advances a schedule, or mutates a case.
 */
export async function previewAutomationAction(
	input: unknown,
): Promise<AutomationPreviewResult> {
	const parsed = inputSchema.safeParse(input);
	if (!parsed.success) {
		return {
			success: false,
			code: "invalid_input",
			message:
				parsed.error.issues[0]?.message ??
				"That automation request wasn't in a shape Nova understands.",
		};
	}
	const session = await getSession();
	if (session === null) {
		return {
			success: false,
			code: "unauthenticated",
			message: "Sign in to preview this automation.",
		};
	}
	try {
		const access = await resolveAppScope(
			parsed.data.appId,
			session.user.id,
			"view",
		);
		const scope: OrganizationScope = {
			appId: parsed.data.appId,
			projectId: access.projectId,
			role: access.role,
			actorUserId: session.user.id,
		};
		const snapshot = await readOrganizationAuthoringSnapshot(scope);
		const automation = ownRecordValue(
			snapshot.blueprint.automations,
			parsed.data.automationUuid,
		);
		if (automation === undefined) {
			return {
				success: false,
				code: "not_found",
				message: "That automation no longer exists.",
			};
		}
		if (!isDeepStrictEqual(automation, parsed.data.expectedAutomation)) {
			return {
				success: false,
				code: "conflict",
				message:
					"This automation changed while you were viewing it. Reload the latest version before refreshing the count or setup steps.",
			};
		}
		const projection = automationMatchProjection(
			snapshot.blueprint,
			automation,
			snapshot.organization.locations,
		);
		const setupGuide = buildAutomationSetupGuide(
			snapshot.blueprint,
			automation,
			snapshot.organization.locations,
		);
		let matching: Extract<
			AutomationPreviewResult,
			{ readonly success: true }
		>["data"]["matching"];
		try {
			const store = await withProjectContext(
				access.projectId,
				session.user.id,
				session.user.id,
			);
			const currentMatchCount = await store.count({
				appId: parsed.data.appId,
				caseType: automation.caseType,
				caseTypeSchemas: buildCaseTypeMap(snapshot.blueprint),
				...projection.countArgs,
			});
			matching = { status: "counted", currentMatchCount };
		} catch (error) {
			log.error("[automations] preview count failed", error, {
				appId: parsed.data.appId,
				automationUuid: parsed.data.automationUuid,
				userId: session.user.id,
			});
			matching = {
				status: "unavailable",
				message:
					"Nova couldn't refresh the current match count just now. The setup guide below is still current; try the count again in a moment.",
			};
		}
		return {
			success: true,
			data: {
				automationUuid: automation.uuid,
				blueprintSeq: snapshot.blueprintSeq,
				organizationRevision: snapshot.organization.revision,
				matching,
				omittedCriteria: projection.omittedCriteria,
				setupGuide,
				executesLocally: false,
			},
		};
	} catch (error) {
		if (
			error instanceof AppAccessError ||
			(error instanceof OrganizationError && error.code === "not_found")
		) {
			return {
				success: false,
				code: "not_found",
				message: "That app isn't available, or you no longer have access.",
			};
		}
		log.error("[automations] preview projection failed", error, {
			appId: parsed.data.appId,
			automationUuid: parsed.data.automationUuid,
			userId: session.user.id,
		});
		return {
			success: false,
			code: "unavailable",
			message:
				"Nova couldn't refresh this automation just now. Try again in a moment.",
		};
	}
}
