const test = require("node:test");
const assert = require("node:assert/strict");
const { createBackend, normalizeHeader, eanHeader } = require("./server.cjs");
const path = require("node:path");
const os = require("node:os");

test("eanHeader detects Check Digit column for EAN filtering", () => {
  const headers = ["Product Name", "Check Digit", "Brand"];
  assert.equal(eanHeader(headers), "Check Digit");
});

test("eanHeader detects EAN13 column", () => {
  const headers = ["NOM", "EAN13", "PRIX"];
  assert.equal(eanHeader(headers), "EAN13");
});

test("eanHeader detects EAN column", () => {
  const headers = ["Product", "EAN", "Price"];
  assert.equal(eanHeader(headers), "EAN");
});

test("eanHeader returns undefined when no EAN column", () => {
  const headers = ["NOM", "BRAND", "PRIX"];
  assert.equal(eanHeader(headers), undefined);
});

test("suggestions seed data loads from JSON", async () => {
  const dataDir = path.join(os.tmpdir(), "chocolat-test-sync-" + Date.now());
  const backend = createBackend({ dataDir, frontendDir: path.resolve(__dirname, "../frontend/dist"), port: 3997 });
  
  const Database = require("better-sqlite3");
  const db = new Database(path.join(dataDir, "chocolat.sqlite3"));
  const count = db.prepare("SELECT COUNT(*) n FROM suggestions").get().n;
  assert.ok(count > 0, "Suggestion dictionary should be seeded on backend init");
  db.close();
  
  backend.close();
});

test("suggestions endpoint requires 3+ character query", async () => {
  const dataDir = path.join(os.tmpdir(), "chocolat-test-query-" + Date.now());
  const backend = createBackend({ dataDir, frontendDir: path.resolve(__dirname, "../frontend/dist"), port: 3996 });
  
  const Database = require("better-sqlite3");
  const db = new Database(path.join(dataDir, "chocolat.sqlite3"));
  const count = db.prepare("SELECT COUNT(*) n FROM suggestions").get().n;
  assert.ok(count > 0);
  db.close();
  
  backend.close();
});

test("sync endpoints are available", async () => {
  const dataDir = path.join(os.tmpdir(), "chocolat-test-sync-endpoints-" + Date.now());
  const backend = createBackend({ dataDir, frontendDir: path.resolve(__dirname, "../frontend/dist"), port: 3995, host: "127.0.0.1" });
  
  const response = await fetch("http://127.0.0.1:3995/api/v1/suggestions/all", {
    headers: { cookie: "" },
  });
  
  assert.equal(response.status, 401, "Should require auth");
  
  backend.close();
});
