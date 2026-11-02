/**
 * Keep stdout free for JSON-RPC in stdio mode.
 *
 * The MCP stdio transport writes protocol messages to stdout, and the Huly SDK logs diagnostics through
 * console.log ("Connected to server", "findfull model ..."), which would corrupt the stream. This module
 * routes console.log and console.info to stderr. The stdio entry point imports it first, so the redirect is in
 * place before any other module, including the SDK, is evaluated. The transport writes through process.stdout
 * directly and is unaffected.
 */
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);
