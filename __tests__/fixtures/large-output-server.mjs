import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// A real MCP server whose "firehose" tool returns a payload far larger than any
// sane model context budget. Used to prove the output guard keeps it out of the
// model's context while leaving it fully recoverable on disk.

const server = new Server(
  { name: "large-output-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// Kept in sync with firehosePayload() in mcp-output-token-budget-e2e.test.ts.
function firehosePayload(lines) {
  const rows = ["FIREHOSE-START"];
  for (let i = 0; i < lines; i++) {
    rows.push(`row ${i}: ${"payload-".repeat(8)}${i}`);
  }
  rows.push("FIREHOSE-END");
  return rows.join("\n");
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "firehose",
      description: "Return a very large text payload",
      inputSchema: { type: "object", properties: { lines: { type: "number" } } },
    },
    {
      name: "trickle",
      description: "Return a small text payload",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "trickle") {
    return { content: [{ type: "text", text: "small and tidy" }] };
  }
  const lines = Number(request.params.arguments?.lines ?? 5000);
  return { content: [{ type: "text", text: firehosePayload(lines) }] };
});

await server.connect(new StdioServerTransport());
