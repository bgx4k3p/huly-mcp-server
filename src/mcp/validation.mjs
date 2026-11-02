/**
 * Runtime validation of tool arguments against each tool's advertised JSON Schema, so a wrong type, a null or
 * a missing required argument is rejected with a clear message instead of failing deep in the client code.
 */
import Ajv from 'ajv';

// Union types are part of the tool contract (e.g. a label color is a name or a number).
const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
// Tool schemas are fixed for the life of the process; compile each one once.
const validators = new WeakMap();

/**
 * Check tool arguments against the tool's input schema.
 * @param {Object} tool - Tool definition with `name` and `inputSchema`
 * @param {Object} args - Arguments supplied by the client
 * @returns {{valid: true} | {valid: false, message: string}} Result; the message names each failing argument
 */
export function validateToolArguments(tool, args) {
  let validate = validators.get(tool.inputSchema);
  if (!validate) {
    validate = ajv.compile(tool.inputSchema);
    validators.set(tool.inputSchema, validate);
  }
  if (validate(args)) return { valid: true };
  const problems = validate.errors.map(error => {
    const path = error.instancePath.replace(/^\//, '');
    return path ? `${path} ${error.message}` : error.message;
  });
  return { valid: false, message: `Invalid arguments for ${tool.name}: ${problems.join('; ')}` };
}
