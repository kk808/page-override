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
  const opened = [];
  vm.runInNewContext(match[1], {
    window: {
      addEventListener(type, listener, options) {
        assert.equal(type, "dblclick");
        handler = listener;
        capture = options;
      },
      open(url, target, features) {
        opened.push({ url, target, features });
      },
    },
    document: { body },
  });
  assert.equal(capture, true);
  handler({ target: {} });
  assert.deepEqual(opened, []);
  handler({ target: bodyTarget });
  handler({ target: body });
  assert.deepEqual(opened, [
    { url: expectedUrl, target: "_blank", features: "noopener,noreferrer" },
    { url: expectedUrl, target: "_blank", features: "noopener,noreferrer" },
  ]);
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

test("savedPageFileName identifies saved snapshot URLs and excludes index files or other origins", () => {
  const context = loadHelpers();
  const baseUrl = "http://localhost:8080/Shopping/";
  assert.equal(
    context.savedPageFileName("http://localhost:8080/Shopping/SearchFight-Return-20261106185415.html?foo=1#bar", baseUrl),
    "SearchFight-Return-20261106185415.html",
  );
  assert.equal(context.savedPageFileName("http://localhost:8080/Shopping/index.html", baseUrl), null);
  assert.equal(context.savedPageFileName("http://localhost:8080/Shopping/Flights?TripType=Return", baseUrl), null);
  assert.equal(context.savedPageFileName("https://example.test/Shopping/SearchFight-Return.html", baseUrl), null);
});

test("recaptureSavedPage returns null when a page has no embedded original URL so it can be saved normally", async () => {
  const context = loadHelpers({
    chrome: {
      scripting: {
        executeScript: async () => [{ result: "<html><head><base href=\"http://localhost:8080/Shopping/\"></head><body>Live</body></html>" }],
      },
    },
  });
  const result = await vm.runInContext(
    'recaptureSavedPage(1, null, "SearchFight-Return-20261101120000.html")',
    context,
  );
  assert.equal(result, null);
});

test("recaptureSavedPage re-fetches the original URL in the background and overwrites the same file", async () => {
  const originalUrl = "https://example.test/flights?TripType=Return&FromCode=MEL&ToCode=SYD#results";
  const existingName = "SearchFight-Return-MEL-SYD-20261101120000.html";
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
          async abort() {},
        };
      } };
    },
  };

  let captureOriginalResponse = false;
  let fetchedHtml = "<!doctype html><html><head><title>Live</title></head><body>Refreshed v1</body></html>";
  const fetchedUrls = [];
  const context = loadHelpers({
    chrome: {
      runtime: { getURL: (name) => name },
      storage: { local: { get: async () => ({ captureOriginalResponse }) } },
    },
    fetch: async (targetUrl) => {
      if (targetUrl === "index-template.html") return { ok: true, text: async () => "<html>index</html>" };
      fetchedUrls.push(targetUrl);
      return { ok: true, status: 200, text: async () => fetchedHtml };
    },
  });
  context.destination = destination;

  // Initial save to establish the saved snapshot file
  await vm.runInContext(
    `savePageHtml(destination, { html: "<!doctype html><html><head><title>Initial</title></head><body>Old</body></html>", url: ${JSON.stringify(originalUrl)}, name: ${JSON.stringify(existingName)} })`,
    context,
  );

  // Recapture with Capture Original Response = false (default: injects <base href>)
  const recapturedRendered = await vm.runInContext(
    `recaptureSavedPage(1, destination, ${JSON.stringify(existingName)})`,
    context,
  );
  assert.equal(recapturedRendered.name, existingName);
  assert.equal(recapturedRendered.url, originalUrl);
  const savedName1 = await vm.runInContext("savePageHtml(destination, recapturedRendered)", Object.assign(context, { recapturedRendered }));
  assert.equal(savedName1, existingName);
  assert.match(files.get(existingName), /Refreshed v1/);
  assert.match(files.get(existingName), /<base href="https:\/\/example\.test\/flights\?TripType=Return&amp;FromCode=MEL&amp;ToCode=SYD#results">/);

  // Recapture with Capture Original Response = true (raw server response, no <base href>)
  captureOriginalResponse = true;
  fetchedHtml = "<!doctype html><html><head><title>Live</title></head><body>Refreshed v2</body></html>";
  const recapturedOriginal = await vm.runInContext(
    `recaptureSavedPage(1, destination, ${JSON.stringify(existingName)})`,
    context,
  );
  const savedName2 = await vm.runInContext("savePageHtml(destination, recapturedOriginal)", Object.assign(context, { recapturedOriginal }));
  assert.equal(savedName2, existingName);
  assert.match(files.get(existingName), /Refreshed v2/);
  assert.doesNotMatch(files.get(existingName), /<base /);
  assert.deepEqual(fetchedUrls, [originalUrl, originalUrl]);
  assertDoubleClickHandler(files.get(existingName), originalUrl);
});
