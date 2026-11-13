/**
 * The corpus's defaults: the seed of its fuzz sample and edit batches, and
 * the sample's size, which the proof lane's time budget sets. `emit.ts`
 * takes both as arguments.
 */

export const DEFAULT_CORPUS_SEED = 20260930;

export const DEFAULT_SAMPLE_SIZE = 24;

/** Separate stream: adding these draws does not move the original sample. */
export const DEFAULT_EXPRESSION_SAMPLE_SIZE = 8;

/**
 * The advanced family's draws, a third stream of their own: each a suite
 * draw whose form creates a case an after-submit link carries, which makes
 * its menu advanced unless a blocker keeps it basic.
 */
export const DEFAULT_ADVANCED_SAMPLE_SIZE = 8;
