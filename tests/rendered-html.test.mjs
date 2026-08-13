import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the habit journal shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Habit\.log/);
  assert.match(html, /Memorable moment/);
  assert.doesNotMatch(html, /Local only/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/);
});

test("ships local-first assets", async () => {
  const [manifest, serviceWorker, page] = await Promise.all([
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(manifest, /"display": "standalone"/);
  assert.match(serviceWorker, /habit-log-shell-v2/);
  assert.match(serviceWorker, /CACHE_SHELL/);
  assert.match(page, /HabitJournal/);
});
