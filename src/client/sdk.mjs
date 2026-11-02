/**
 * Huly SDK entry points shared by the client modules.
 *
 * Some api-client internals are loaded by file path because the package's exports map does not expose them.
 */
import '../domPolyfill.mjs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const apiClientFile = file => require.resolve('@hcengineering/api-client').replace(/lib[/\\]index\.js$/, file);

export const { getWorkspaceToken } = require(apiClientFile('lib/utils.js'));
export const { createRestTxOperations } = require(apiClientFile('lib/rest/tx.js'));
export const { connect: connectWs } = require(apiClientFile('lib/client.js'));
export const { loadServerConfig: loadConfig } = require(apiClientFile('lib/config.js'));
export const { getClient: getAccountClient } = require('@hcengineering/account-client');
export const { getClient: getCollaboratorClient } = require('@hcengineering/collaborator-client');

const coreSdk = require('@hcengineering/core');
export const { generateId } = coreSdk;
export const core = coreSdk.default;

export const tracker = require('@hcengineering/tracker').default;
export const tags = require('@hcengineering/tags').default;
export const contactPlugin = require('@hcengineering/contact').default;
export const chunter = require('@hcengineering/chunter').default;
export const task = require('@hcengineering/task').default;
