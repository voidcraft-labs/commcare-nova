/**
 * The plan of what a change made in CommCare HQ does to an app Nova holds:
 * the checks it holds itself to, beside acceptance's own. A failure of one
 * is named by a content-free signature that begins with the check
 * (`lib/deployment/reading/signature.ts::differenceSignature`).
 *
 * Pure.
 */

/** This plan's own checks. */
export const HQ_CHANGE_PLAN_CHECKS = ["apply", "commutes", "replay"] as const;
export type HqChangePlanCheck = (typeof HQ_CHANGE_PLAN_CHECKS)[number];
