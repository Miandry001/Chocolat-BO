import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { sheetsPlugin } from "./sheetsPlugin.js";

test("an authenticated agent cannot replace the active Google Sheets workbook", async (context) => {
  let middleware;
  const plugin = sheetsPlugin({
    keyFile: "unused.json",
    sheetId: "configured-source",
    range: "'référent'!A:ZZ",
    appOrigin: "http://app.test",
  });
  const serverConfig = {
    custom: {
      authService: {
        async authenticate(sessionId) {
          return sessionId === "agent-session"
            ? { id: "agent-1", role: "AGENT" }
            : null;
        },
      },
    },
    logger: { error() {} },
  };
  plugin.configureServer({
    middlewares: { use(handler) { middleware = handler; } },
    config: serverConfig,
  });

  const httpServer = createServer((req, res) => middleware(req, res, () => {
    res.statusCode = 404;
    res.end();
  }));
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve, reject) => {
    httpServer.close((error) => error ? reject(error) : resolve());
  }));

  const address = httpServer.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/sheets/connect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: "chocolat_session=agent-session; chocolat_csrf=test-csrf",
      Origin: "http://app.test",
      "X-CSRF-Token": "test-csrf",
    },
    body: JSON.stringify({ url: "https://docs.google.com/spreadsheets/d/attacker-sheet/edit" }),
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Une erreur est survenue!" });
});
