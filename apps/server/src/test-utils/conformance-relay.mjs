// Run by the MCP conformance framework as the "client" command. It hands the scenario to the
// test process (mcp.conformance.test.ts), where the real McpHub runs it, and exits with the result.
const url = process.argv.at(-1);
const control = process.env.ADVENCE_CONFORMANCE_CONTROL;
const body = JSON.stringify({ url, scenario: process.env.MCP_CONFORMANCE_SCENARIO ?? '', context: process.env.MCP_CONFORMANCE_CONTEXT ?? null, version: process.env.MCP_CONFORMANCE_PROTOCOL_VERSION ?? null });
const res = await fetch(control, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
const out = await res.json();
if (out.log) process.stderr.write(`${out.log}\n`);
process.exit(out.ok ? 0 : 1);
