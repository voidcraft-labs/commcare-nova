/**
 * Smoke retry budget — single-sourced so every journey that irreversibly
 * mutates its seed gets one fresh universe per possible attempt. Deriving the
 * fixture counts here (rather than hand-syncing magic numbers between the seed,
 * config, and specs) means bumping retries cannot silently under-seed.
 */
export const SMOKE_RETRIES = process.env.CI ? 2 : 0;

/** One throwaway delete-app per possible attempt (initial try + retries). */
export const DELETE_APP_COUNT = SMOKE_RETRIES + 1;

/** Same rule for the cross-Project move journey: a moved app is gone from the
 *  source Project, so a retry needs its own. */
export const MOVE_APP_COUNT = SMOKE_RETRIES + 1;

/** The case-changes journey mutates both its blueprint and saved case rows, so
 *  every attempt needs its own app + case-data fixture. */
export const CASE_CHANGES_FIXTURE_COUNT = SMOKE_RETRIES + 1;

/** The organization journey authors levels and persisted places, so a retry
 *  starts from a fresh app instead of inheriting a half-completed hierarchy. */
export const ORGANIZATION_FIXTURE_COUNT = SMOKE_RETRIES + 1;

/** The after-submit journey authors a link and submits twice into its one
 *  case row, so a retry needs its own app and row. */
export const FORM_LINKS_FIXTURE_COUNT = SMOKE_RETRIES + 1;

/** The search-first journey registers a case from an empty search, so a
 *  retry needs an app whose search still finds nothing for that name. */
export const SEARCH_FIRST_FIXTURE_COUNT = SMOKE_RETRIES + 1;

/** Entry-point authoring mutates the doc, so retries own separate apps. */
export const DEEP_LINKS_FIXTURE_COUNT = SMOKE_RETRIES + 1;
