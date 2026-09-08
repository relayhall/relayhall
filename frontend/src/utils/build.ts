/**
 * Build-time facts about this build, and what they make safe to link.
 *
 * RelayHall develops privately and publishes once, at an owner gate (owner
 * implementation order `b547f64e`; gate task `c2885bbd`). Until that gate,
 * `github.com/relayhall/relayhall` does not resolve, so a product that links it
 * is shipping a broken promise. Every public link therefore rides this flag and
 * DEFAULTS TO PRIVATE: an unset variable produces the private presentation, so a
 * forgotten build argument can never publish a link by accident.
 *
 * Setting the flag changes presentation only. It publishes nothing, and it is
 * not the publication gate — see RH-PUB.B1.
 */
export const IS_PUBLIC_BUILD = import.meta.env.VITE_PUBLIC_BUILD === 'true';

/** Canonical public source location, per spec §6. Linked only in public builds. */
export const SOURCE_URL = 'https://github.com/relayhall/relayhall';

/** MIT licence text, in the repository. Linked only in public builds. */
export const LICENSE_URL = `${SOURCE_URL}/blob/main/LICENSE`;

/** Repository documentation and issue intake; never linked before publication. */
export const DOCS_URL = `${SOURCE_URL}/tree/main/docs`;
export const PROBLEM_URL = `${SOURCE_URL}/issues/new/choose`;

/**
 * What to call the source in this build. The private label is deliberately
 * plain text at the call site, not a link to nowhere.
 */
export const SOURCE_LABEL = IS_PUBLIC_BUILD ? 'Source' : 'Private working repo';

/**
 * The official product page. Public since 2026-09-02 (owner ruling, website
 * track), so unlike the source links above it is linkable in EVERY build.
 */
export const PRODUCT_URL = 'https://relayhall.com';
