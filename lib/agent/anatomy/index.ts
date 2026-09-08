/**
 * Agent anatomy: how Nova's model roles are composed, rendered from the
 * production code paths so the surface is accurate by construction.
 *
 * This entry is `server-only`. The pages under `app/(dev-only)/agents` take
 * their values from it and their types from the sibling modules directly
 * (a type import carries no runtime); the client-safe `bands.ts` is the one
 * value module a client component reaches. The inspector script under
 * `scripts/` reads `modelMessageSummary.ts` directly for the same reason.
 */

import "server-only";

import { buildExecutorComposition } from "./compositions/buildExecutor";
import { designAuthorComposition } from "./compositions/designAuthor";
import { mcpBootComposition } from "./compositions/mcpBoot";
import {
	designReviewerComposition,
	documentExtractorComposition,
	executorHelperComposition,
	translatorComposition,
} from "./compositions/oneShots";
import { solutionsArchitectComposition } from "./compositions/solutionsArchitect";
import type { AnatomyRoleId, RoleComposition } from "./types";

export const COMPOSITIONS: Readonly<Record<AnatomyRoleId, RoleComposition>> = {
	"solutions-architect": solutionsArchitectComposition,
	"design-author": designAuthorComposition,
	"design-reviewer": designReviewerComposition,
	"build-executor": buildExecutorComposition,
	"executor-helper": executorHelperComposition,
	"document-extractor": documentExtractorComposition,
	translator: translatorComposition,
	"mcp-boot": mcpBootComposition,
};

export function isAnatomyRoleId(value: string): value is AnatomyRoleId {
	return Object.hasOwn(COMPOSITIONS, value);
}

export { bandOf } from "./bands";
export type { Lifecycle, LifecycleStep, RoleFact, RoleFacts } from "./catalog";
export {
	LIFECYCLES,
	lifecyclesFor,
	modelLabel,
	OPENAI_COMPACTION_NOTE,
	providerOptionsFor,
	ROLE_FACTS,
} from "./catalog";
export {
	RECORDED_KIND_LABELS,
	recordedItemsOf,
	recordedLabel,
} from "./compositions/recordedItems";
export type { DiffEntry, DiffStatus, MomentDiff } from "./diff";
export { diffMoments, itemContentDigest } from "./diff";
export type { OutlineSection } from "./outline";
export { outlineText } from "./outline";
export type { DesignSessionSummary, LocalAppSummary } from "./recorded";
export {
	AppInspectionRefusal,
	listDesignSessions,
	listLocalApps,
	readAppInput,
	readDesignSession,
} from "./recorded";
export { estimateTokens, weigh } from "./tokens";
export * from "./types";
