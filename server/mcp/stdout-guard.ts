// MCP over stdio uses stdout for protocol messages only: send every log line to stderr.
// Imported first by main.ts so it runs before any other module.
console.log = console.error;
console.info = console.error;
console.debug = console.error;
