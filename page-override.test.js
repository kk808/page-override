const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "page-override.js"), "utf8");

function loadHelpers(extra = {}) {
  const context = vm.createContext({ URL, URLSearchParams, console, ...extra });
  vm.runInContext(source, context);
  return context;
}

function assertDoubleClickHandler(html, expectedUrl) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, "snapshot contains a complete handler script");
  let handler;
  let capture;
  const bodyTarget = {};
  const body = { contains: (target) => target === bodyTarget || target === body };
  const navigations = [];
  vm.runInNewContext(match[1], {
    window: { addEventListener(type, listener, options) {
      assert.equal(type, "dblclick");
      handler = listener;
      capture = options;
    } },
    document: { body },
    location: { assign: (url) => navigations.push(url) },
  });
  assert.equal(capture, true);
  handler({ target: {} });
  assert.deepEqual(navigations, []);
  handler({ target: bodyTarget });
  handler({ target: body });
  assert.deepEqual(navigations, [expectedUrl, expectedUrl]);
}

test("saved HTML includes a body double-click handler with the exact captured URL", async () => {
  const url = "https://example.test/search?q=%22&value=</script><script>bad()</script>#results";
  const files = new Map();
  const destination = {
    async getFileHandle(name, options) {
      if (!options?.create) throw new Error("File not found");
      return { async createWritable() {
        return {
          async write(content) { files.set(name, content); },
          async close() {},
          async abort() {},
        };
      } };
    },
  };
  const context = loadHelpers({
    chrome: { runtime: { getURL: (name) => name } },
    fetch: async () => ({ text: async () => "<html>index</html>" }),
  });
  context.destination = destination;
  context.page = { html: '<!doctype html><html><head><meta charset="utf-8"><title>Old</title></head><body>Saved</body></html>', url };
  const name = await vm.runInContext("savePageHtml(destination, page)", context);
  const saved = files.get(name);
  assert.match(saved, /^<!doctype html>/);
  assert.match(saved, /<title>(?!Old)/);
  assert.ok(saved.indexOf('<meta charset="utf-8">') < saved.indexOf("<script>"));
  assert.ok(!saved.includes("</script><script>bad()"));
  assertDoubleClickHandler(saved, url);
  assert.ok(files.has("index.json"));
  assert.ok(files.has("index.html"));
});

test("saved index entries use Other for missing trip types and retain known trip types", async () => {
  const files = new Map();
  const destination = {
    async getFileHandle(name, options) {
      if (!options?.create) {
        if (!files.has(name)) throw new Error("File not found");
        return { async getFile() { return { text: async () => files.get(name) }; } };
      }
      return { async createWritable() {
        return {
          async write(content) { files.set(name, content); },
          async close() {},
        };
      } };
    },
  };
  const context = loadHelpers({
    chrome: { runtime: { getURL: (name) => name } },
    fetch: async () => ({ text: async () => "<html>index</html>" }),
  });
  context.destination = destination;

  await vm.runInContext(
    'updateIndex(destination, { name: "SearchFight-20261106185414.html", url: "https://example.test/search" })',
    context,
  );
  await vm.runInContext(
    'updateIndex(destination, { name: "SearchFight-Return-20261106185415.html", url: "https://example.test/search?TripType=Return" })',
    context,
  );

  assert.deepEqual(JSON.parse(files.get("index.json")), [
    { name: "SearchFight-Return-20261106185415.html", tripType: "Return" },
    { name: "SearchFight-20261106185414.html", tripType: "Other" },
  ]);
});

test("documents without a head still receive the handler", () => {
  const context = loadHelpers();
  context.html = "<!doctype html><body>Saved</body>";
  context.url = "https://example.test/#section";
  const result = vm.runInContext("withOriginalUrlDoubleClick(html, url)", context);
  assertDoubleClickHandler(result, context.url);
});

test("original response capture retains the URL fragment without changing the resource URL", async () => {
  const calls = [];
  const context = loadHelpers({
    chrome: { debugger: {
      async attach() {},
      async sendCommand(target, command, params) {
        calls.push({ command, params });
        if (command === "Page.getFrameTree") {
          return { frameTree: { frame: { id: "frame", url: "https://example.test/path", urlFragment: "#section" } } };
        }
        return { content: "<html></html>", base64Encoded: false };
      },
      async detach() {},
    } },
  });
  const result = await vm.runInContext("captureOriginalResponse(1)", context);
  assert.equal(result.url, "https://example.test/path#section");
  assert.equal(calls[1].params.url, "https://example.test/path");
});
