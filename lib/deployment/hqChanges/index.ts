// lib/deployment/hqChanges/index.ts
//
// The server surface of the changes made in CommCare HQ: the review, the
// bring-in and the check the builder makes when it opens an app. The routes
// under `/api/commcare/changes` and the MCP tools import these and nothing
// else of this folder. Client code reads the vocabulary from `types.ts` and
// the batch id from `batchId.ts`, never from here.

import "server-only";

export {
	bringInHqChanges,
	type HqChangesBringInInput,
	HqChangesDiscardMismatchError,
} from "./bringIn";
export { checkHqChangesForApp } from "./check";
export { type HqChangesProgress, reviewHqChanges } from "./review";
export type {
	HqChangesKey,
	HqChangesOutcome,
	HqChangesReview,
} from "./types";
