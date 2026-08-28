// services/metrics-watcher/src/cliCall.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  const [, , toolName, argsJson] = process.argv;
  if (!toolName) {
    console.error("usage: cliCall.js <toolName> [argsJson]");
    process.exit(1);
  }
  const args = argsJson ? JSON.parse(argsJson) : {};

  const client = new Client({ name: "verify-m5-cli", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost:3300/mcp"));
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: toolName, arguments: args });
    console.log(JSON.stringify(result));
    if (result.isError) {
      process.exitCode = 1;
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
