// services/mcp-server/src/cliCall.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  const [, , toolName, argsJson] = process.argv;
  if (!toolName) {
    console.error("usage: cli-call.js <toolName> [argsJson]");
    process.exit(1);
  }
  const args = argsJson ? JSON.parse(argsJson) : {};

  const client = new Client({ name: "verify-m2-cli", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost:3100/mcp"));
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    console.log(JSON.stringify(result));
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
