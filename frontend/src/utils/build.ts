/**
 * Where the product's public links point.
 *
 * The public repository exists, so every link below is live in every build:
 * nothing is read from the build environment and there is no private
 * presentation to fall back to. The build variable that used to gate them
 * (it defaulted to private while the repository did not resolve) is retired;
 * the build identity (version, commit, build time) is carried by the release
 * manifest and the API, not by these links (docs/build-identity.md).
 */

/** Canonical public source location, per spec §6. */
export const SOURCE_URL = 'https://github.com/relayhall/relayhall';

/** MIT licence text, in the repository. */
export const LICENSE_URL = `${SOURCE_URL}/blob/main/LICENSE`;

/** Repository documentation, the Blueprint authoring and use guide, and issue intake. */
export const DOCS_URL = `${SOURCE_URL}/tree/main/docs`;
export const BLUEPRINT_GUIDE_URL = `${SOURCE_URL}/blob/main/docs/blueprints/README.md`;
export const PROBLEM_URL = `${SOURCE_URL}/issues/new/choose`;

/** What the source link is called wherever it appears. */
export const SOURCE_LABEL = 'Source';

/** The official product page, public since 2026-09-02 (owner ruling, website track). */
export const PRODUCT_URL = 'https://relayhall.com';
