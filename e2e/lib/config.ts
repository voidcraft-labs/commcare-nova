/**
 * Smoke retry budget — single-sourced so the delete test stays idempotent under
 * retries. The seed mints `DELETE_APP_COUNT` throwaway "delete me" apps and the
 * delete test consumes one per Playwright attempt; deriving the count from the
 * retry budget here (rather than hand-syncing a magic number in two files) means
 * bumping retries can't silently under-seed.
 */
export const SMOKE_RETRIES = process.env.CI ? 2 : 0;

/** One throwaway delete-app per possible attempt (initial try + retries). */
export const DELETE_APP_COUNT = SMOKE_RETRIES + 1;
