/**
 * The marks the CommCare HQ app picker shows on an app that a Nova app
 * already publishes to.
 *
 * Client-safe. An app in a Project the viewer is part of shows the label and
 * the action that opens it. An app elsewhere shows the other label, and the
 * line under it is `hqFindingCopy.ts::alreadyInNovaNext`, so the picker and a
 * read that stops on the same claim say one thing.
 */

/** The row label of an app already in Nova, in a Project the viewer is part of. */
export const HQ_APP_CLAIM_OPEN_LABEL = "Already in Nova";

/** The action beside it, a link to that Nova app. */
export const HQ_APP_CLAIM_OPEN_ACTION = "Open";

/** The row label of an app already in Nova, in a Project the viewer isn't part of. */
export const HQ_APP_CLAIM_ELSEWHERE_LABEL =
	"Already in Nova, in a Project you're not part of";
