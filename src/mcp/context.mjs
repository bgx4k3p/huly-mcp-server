/**
 * Sanitized runtime context reported by the get_huly_context tool. Never includes secrets.
 */
import { HULY_EMAIL, HULY_PASSWORD, HULY_PROJECT, HULY_TOKEN, HULY_URL, resolveDefaultWorkspace } from '../config.mjs';
import { PKG_NAME, PKG_VERSION } from '../packageInfo.mjs';
import { SUPPORTED_RESPONSE_MODES } from '../responseMode.mjs';

/**
 * Host part of HULY_URL, or the raw value when it is not a valid URL.
 * @returns {string|null}
 */
function hulyUrlHost() {
  try {
    return new URL(HULY_URL).host;
  } catch {
    return HULY_URL || null;
  }
}

/**
 * Which credentials are configured: token, email_password, incomplete_email_password or none.
 * @returns {string}
 */
function authMode() {
  if (HULY_TOKEN) return 'token';
  if (HULY_EMAIL && HULY_PASSWORD) return 'email_password';
  if (HULY_EMAIL || HULY_PASSWORD) return 'incomplete_email_password';
  return 'none';
}

/**
 * Runtime context: default workspace and project, Huly host, auth mode, package and response/tool modes.
 * @returns {Object}
 */
export function getHulyContext() {
  return {
    defaultWorkspace: resolveDefaultWorkspace(),
    defaultProject: HULY_PROJECT || null,
    hulyUrlHost: hulyUrlHost(),
    authMode: authMode(),
    packageName: PKG_NAME,
    packageVersion: PKG_VERSION,
    responseModes: SUPPORTED_RESPONSE_MODES,
    toolProfile: process.env.HULY_TOOL_PROFILE || 'full'
  };
}
