/**
 * Name and version of this package, read from package.json.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export const { name: PKG_NAME, version: PKG_VERSION } = require('../package.json');
