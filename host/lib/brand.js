/**
 * Product identity for Saaridge (alpha).
 * Keep installers, Docker tags, and UI strings aligned with these constants.
 */
export const APP_NAME = "Saaridge";
export const APP_ID = "com.saariv.saaridge";
export const APP_VERSION = "0.0.1";
export const RELEASE_CHANNEL = "alpha";
export const LICENSE = "Apache-2.0";

/** Docker Hub namespace / image for the mediated workspace. */
export const DOCKER_USER = "saaridge";
export const IMAGE_REPOSITORY = `${DOCKER_USER}/saaridge-workspace`;
export const IMAGE_TAG = APP_VERSION;
export const IMAGE_NAME = `${IMAGE_REPOSITORY}:${IMAGE_TAG}`;

/** Runtime container name (distinct from the published image). */
export const CONTAINER_NAME = "saaridge-box";

/** Pre-rename container names still running on developer machines. */
export const LEGACY_CONTAINER_NAMES = Object.freeze(["agent-bridge-box"]);

/** Local image tags from before the Saaridge publish name — retag instead of rebuild. */
export const LEGACY_IMAGE_NAMES = Object.freeze(["agent-bridge-box:local"]);

/** Host-side mediated project root under the user's home directory. */
export const HOST_ROOT_DIRNAME = "Saaridge";
