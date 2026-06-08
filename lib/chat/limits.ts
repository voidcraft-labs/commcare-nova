// lib/chat/limits.ts
//
// Chat composer limits shared by the client (live counter + send gate) and the
// server (defense-in-depth rejection), so the two can never disagree on what
// "too long" means. Pure constants — safe to import from either side.

/**
 * Max characters in a single chat message's typed text. Enough for a normal
 * request (a couple of paragraphs) but bounded so a paste of, say, a whole
 * document can't ride inline into the SA's context (real documents go through
 * the file manager + extraction instead). The composer shows a counter as the
 * user approaches this and blocks SENDING past it (without truncating what they
 * typed); the chat route rejects anything over it as a backstop.
 *
 * Attachments are NOT counted here — they travel as asset-id refs, not inline
 * text — so this bounds only what the user actually types/pastes.
 */
export const MAX_CHAT_MESSAGE_CHARS = 2_000;

/** Fraction of the limit at which the composer's character counter fades in.
 *  Below this the counter is hidden so normal short messages carry no chrome. */
export const CHAR_COUNTER_VISIBLE_AT = 0.7;

/** Fraction at which the counter reaches full opacity (the "danger" band). It
 *  fades in over `[VISIBLE_AT, DANGER_AT)` in nova-amber, sits full-opacity
 *  amber through the danger band, then flips to nova-rose at/over the limit. */
export const CHAR_COUNTER_DANGER_AT = 0.85;

/**
 * Max messages the chat route accepts in one request. A long edit session is one
 * user + one assistant message per turn, so this bounds the history the server
 * walks and ships to the model at ~200 turns. Defense-in-depth: the client never
 * sends near this; a crafted request that does is rejected before any I/O.
 */
export const MAX_CHAT_MESSAGES = 400;

/**
 * Max attachment refs across the WHOLE request — the meaningful DoS bound.
 * `resolveAttachments` walks every message and batch-loads each unique asset, so
 * the request total (not any single message) is what hits Firestore + GCS. A
 * request over this is rejected before resolution runs.
 */
export const MAX_CHAT_ATTACHMENTS = 100;

/** Max attachment refs on a single message — secondary to the request-total cap;
 *  bounds one turn's chip row. Enforced by `messageMetadataSchema`. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;
