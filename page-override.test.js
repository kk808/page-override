const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "page-override.js"), "utf8");
const indexTemplate = fs.readFileSync(path.join(__dirname, "index-template.html"), "utf8");

function loadHelpers(extra = {}) {
  const context = vm.createContext({ URL, URLSearchParams, console, ...extra });
  vm.runInContext(source, context);
  return context;
}

function assertBrandLogoClickHandler(html, expectedUrl) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, "snapshot contains a complete handler script");
  let handler;
  let selector;
  let readyListener;
  const opened = [];
  vm.runInNewContext(match[1], {
    window: {
      open(url, target, features) {
        opened.push({ url, target, features });
      },
    },
    document: {
      addEventListener(type, listener) {
        assert.equal(type, "DOMContentLoaded");
        readyListener = listener;
      },
      querySelector(value) {
        selector = value;
        return {
          addEventListener(type, listener) {
            assert.equal(type, "click");
            handler = listener;
          },
        };
      },
    },
  });
  assert.equal(typeof readyListener, "function");
  readyListener();
  assert.equal(selector, "a.brand-logo");
  let prevented = false;
  handler({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(opened, [
    { url: expectedUrl, target: "_blank", features: "noopener,noreferrer" },
  ]);
}

test("saved HTML opens the captured URL when the brand logo link is clicked", async () => {
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
  context.page = { html: '<!doctype html><html><head><meta charset="utf-8"><title>Old</title></head><body><a class="brand-logo" href="/">Logo</a>Saved</body></html>', url };
  const name = await vm.runInContext("savePageHtml(destination, page)", context);
  const saved = files.get(name);
  assert.match(saved, /^<!doctype html>/);
  assert.match(saved, /<title>(?!Old)/);
  assert.ok(saved.indexOf('<meta charset="utf-8">') < saved.indexOf("<script>"));
  assert.ok(!saved.includes("</script><script>bad()"));
  assertBrandLogoClickHandler(saved, url);
  assert.ok(files.has("index.json"));
  assert.ok(files.has("index.html"));
  assert.doesNotMatch(saved, /page-override-favicon|icon-32\.png/);
});

test("saved index entries retain original URLs and trip types across saves", async () => {
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
    'updateIndex(destination, { name: "SearchFight-20261106185414.html", url: "https://example.test/search?query=one" })',
    context,
  );
  await vm.runInContext(
    'updateIndex(destination, { name: "SearchFight-Return-20261106185415.html", url: "https://example.test/search?TripType=Return" })',
    context,
  );

  assert.deepEqual(JSON.parse(files.get("index.json")), [
    { name: "SearchFight-Return-20261106185415.html", tripType: "Return", url: "https://example.test/search?TripType=Return" },
    { name: "SearchFight-20261106185414.html", tripType: "Other", url: "https://example.test/search?query=one" },
  ]);

  await vm.runInContext(
    'updateIndex(destination, { name: "SearchFight-20261106185416.html", url: "https://example.test/search?query=two" })',
    context,
  );
  assert.deepEqual(JSON.parse(files.get("index.json")), [
    { name: "SearchFight-20261106185416.html", tripType: "Other", url: "https://example.test/search?query=two" },
    { name: "SearchFight-Return-20261106185415.html", tripType: "Return", url: "https://example.test/search?TripType=Return" },
    { name: "SearchFight-20261106185414.html", tripType: "Other", url: "https://example.test/search?query=one" },
  ]);
});

test("documents without a head still receive the brand logo handler", () => {
  const context = loadHelpers();
  context.html = '<!doctype html><body><a class="brand-logo" href="/">Logo</a>Saved</body>';
  context.url = "https://example.test/#section";
  const result = vm.runInContext("withOriginalUrlBrandLogoClick(html, url)", context);
  assertBrandLogoClickHandler(result, context.url);
});

test("legacy double-click handlers still yield the captured URL and are replaced", () => {
  const context = loadHelpers();
  const url = "https://example.test/legacy";
  context.html = `<html><head><script>
window.addEventListener("dblclick", (event) => {
  if (document.body && document.body.contains(event.target)) window.open(${JSON.stringify(url)}, "_blank", "noopener,noreferrer");
}, true);
</script></head><body><a class="brand-logo" href="/">Logo</a></body></html>`;
  assert.equal(context.extractOriginalUrl(context.html), url);
  const updated = context.withOriginalUrlBrandLogoClick(context.html, url);
  assert.equal((updated.match(/<script>/g) || []).length, 1);
  assertBrandLogoClickHandler(updated, url);
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
  assertBrandLogoClickHandler(files.get(existingName), originalUrl);
});

function memoryDirectory(files) {
  return {
    async getFileHandle(name, options) {
      if (!files.has(name) && !options?.create) throw new Error(`Missing file: ${name}`);
      return {
        async getFile() { return { text: async () => files.get(name) }; },
        async createWritable() {
          let content;
          return {
            async write(value) { content = value; },
            async close() { files.set(name, content); },
            async abort() {},
          };
        },
      };
    },
  };
}

test("saved index detection matches only the configured index page", () => {
  const context = loadHelpers();
  const base = "http://localhost:8080/Shopping/";
  assert.equal(context.isSavedIndexPage(`${base}index.html?filter=x#list`, base), true);
  assert.equal(context.isSavedIndexPage(`${base}index.html`, base.slice(0, -1)), true);
  assert.equal(context.isSavedIndexPage(`${base}index.html.evil`, base), false);
  assert.equal(context.isSavedIndexPage("http://localhost:8081/Shopping/index.html", base), false);
  assert.equal(context.isSavedIndexPage(`${base}nested/index.html`, base), false);
  assert.equal(context.isSavedIndexPage(undefined, base), false);
});

test("bulk refresh overwrites snapshots except Other trip types without modifying index files", async () => {
  const firstUrl = "https://example.test/one?q=1#section";
  const legacyUrl = "https://example.test/two?TripType=Return";
  const firstName = "SearchFight-First.html";
  const legacyName = "SearchFight-Legacy.html";
  const entries = [
    { name: firstName, tripType: "Other", url: firstUrl },
    { name: legacyName, tripType: "Return", extra: "preserved" },
  ];
  const indexJson = JSON.stringify(entries, null, 2);
  const indexHtml = "<html><body>Keep this file unchanged.</body></html>";
  const files = new Map([
    ["index.json", indexJson],
    ["index.html", indexHtml],
    [firstName, "<html><head></head><body>Old</body></html>"],
    [legacyName, "<html><head></head><body>Legacy</body></html>"],
  ]);
  const fetched = [];
  const context = loadHelpers({
    chrome: { storage: { local: { get: async () => ({ captureOriginalResponse: false }) } } },
    fetch: async (url) => {
      fetched.push(url);
      return { ok: true, text: async () => `<html><head></head><body>New ${url}</body></html>` };
    },
  });
  files.set(legacyName, context.withOriginalUrlBrandLogoClick(files.get(legacyName), legacyUrl));
  context.destination = memoryDirectory(files);
  assert.equal(await vm.runInContext("refreshSavedPages(destination)", context), 1);
  assert.deepEqual(fetched, [legacyUrl]);
  assert.equal(files.get(firstName), "<html><head></head><body>Old</body></html>");
  assert.match(files.get(legacyName), /New https:\/\/example\.test\/two/);
  assertBrandLogoClickHandler(files.get(legacyName), legacyUrl);
  assert.equal(files.get("index.json"), indexJson);
  assert.equal(files.get("index.html"), indexHtml);
});

test("index progress counts only entries eligible for update", () => {
  assert.match(indexTemplate, /const updateList = entries\.filter\(\(entry\) => entry\.tripType !== "Other"\)/);
  assert.match(indexTemplate, /progressBar\.max = updateList\.length/);
  assert.match(indexTemplate, /"Updating " \+ \(i \+ 1\) \+ " of " \+ updateList\.length/);
  assert.match(indexTemplate, /"Updated " \+ \(updateList\.length - failures\.length\) \+ " of " \+ updateList\.length/);
  assert.doesNotMatch(indexTemplate, /progressEl\.classList\.remove\("active", "done", "fading"\)/);
});

test("saved index uses the test pages title without a custom favicon", () => {
  assert.match(indexTemplate, /<title>Test Pages<\/title>/);
  assert.doesNotMatch(indexTemplate, /rel="icon"|icon-32\.png/);
});

test("saved index tables can be reordered and retain their group positions", () => {
  assert.match(indexTemplate, /table\.draggable = true/);
  assert.match(indexTemplate, /table\.ondragstart/);
  assert.match(indexTemplate, /table\.ondrop/);
  assert.match(indexTemplate, /localStorage\.setItem\(GROUP_ORDER_KEY, JSON\.stringify\(groupOrder\)\)/);
  assert.match(indexTemplate, /restoreGroupOrder\(\);[\s\S]*load\(\);/);
});

test("saved index provides a rename action and safely updates the filename", () => {
  assert.match(indexTemplate, /actionCol\.style\.width = "56px"/);
  assert.match(indexTemplate, /rename\.setAttribute\("aria-label", "Rename " \+ e\.name\)/);
  assert.match(indexTemplate, /async function renamePage\(entry\)/);
  assert.match(indexTemplate, /item\.name\.toLowerCase\(\) === newName\.toLowerCase\(\)/);
  assert.match(indexTemplate, /entries = entries\.map\(\(item\) => item\.name === entry\.name \? \{ \.\.\.item, name: newName \} : item\)/);
  assert.match(indexTemplate, /await dir\.removeEntry\(entry\.name\)/);
});

test("saved index opens the original URL with shift-click shortcuts", () => {
  assert.match(indexTemplate, /a\.draggable = false/);
  assert.match(indexTemplate, /a\.onclick = \(event\) => \{[\s\S]*if \(!event\.shiftKey/);
  assert.match(indexTemplate, /entries\.find\(\(item\) => item\.name === a\.dataset\.snapshotName\)/);
  assert.match(indexTemplate, /if \(event\.ctrlKey \|\| event\.metaKey\)[\s\S]*window\.open\(originalUrl, "_blank", "noopener,noreferrer"\)/);
  assert.match(indexTemplate, /window\.location\.assign\(originalUrl\)/);
  assert.match(indexTemplate, /body\.live-links-ready a\[data-original-url\] \{ color: [^;]+; \}/);
  assert.match(indexTemplate, /document\.addEventListener\("keydown", updateLiveLinkState\)/);
  assert.match(indexTemplate, /event\.shiftKey && \(event\.ctrlKey \|\| event\.metaKey\)/);
  assert.match(indexTemplate, /if \(e\.url\) a\.dataset\.originalUrl = e\.url/);
});

test("bulk refresh continues after failures and preserves failed snapshots", async () => {
  const entries = [
    { name: "SearchFight-Bad.html", url: "https://example.test/bad" },
    { name: "Good.html", url: "https://example.test/good" },
    { name: "SearchFight-Old.html" },
    { name: "../index.html", url: "https://example.test/unsafe" },
  ];
  const files = new Map([
    ["index.json", JSON.stringify(entries)],
    ["index.html", "<html><body>Keep this file unchanged.</body></html>"],
    ["SearchFight-Bad.html", "old bad"],
    ["Good.html", "old good"],
    ["SearchFight-Old.html", "old without URL"],
  ]);
  const fetched = [];
  const context = loadHelpers({
    chrome: { storage: { local: { get: async () => ({ captureOriginalResponse: true }) } } },
    fetch: async (url) => {
      fetched.push(url);
      if (url.endsWith("/bad")) return { ok: false, status: 500 };
      return { ok: true, text: async () => "<html><head></head><body>Updated</body></html>" };
    },
  });
  context.destination = memoryDirectory(files);
  await assert.rejects(vm.runInContext("refreshSavedPages(destination)", context), (error) => {
    assert.match(error.message, /Refreshed 1 of 4 pages/);
    assert.match(error.message, /SearchFight-Bad\.html:.*HTTP 500/);
    assert.match(error.message, /SearchFight-Old\.html: No original URL/);
    assert.match(error.message, /Invalid snapshot filename/);
    return true;
  });
  assert.deepEqual(fetched, ["https://example.test/bad", "https://example.test/good"]);
  assert.equal(files.get("SearchFight-Bad.html"), "old bad");
  assert.match(files.get("Good.html"), /Updated/);
  assert.doesNotMatch(files.get("Good.html"), /<base /);
  assert.deepEqual(JSON.parse(files.get("index.json")), entries);
  assert.equal(files.get("index.html"), "<html><body>Keep this file unchanged.</body></html>");
});

test("bulk refresh rejects malformed index data", async () => {
  const context = loadHelpers();
  context.destination = memoryDirectory(new Map([["index.json", "{}"]]));
  await assert.rejects(vm.runInContext("refreshSavedPages(destination)", context), /must contain an array/);
});

test("index action refreshes directly or hands off to the permission page", async () => {
  for (const permission of ["granted", "prompt"]) {
    let listener;
    const calls = [];
    const chrome = {
      action: {
        onClicked: { addListener: (fn) => { listener = fn; } },
        setBadgeText: async (value) => calls.push(["badge", value.text]),
        setBadgeBackgroundColor: async () => {},
        setTitle: async () => {},
      },
      runtime: { getURL: (name) => `chrome-extension://test/${name}`, onMessageExternal: { addListener: () => {} } },
      tabs: {
        reload: async (id) => calls.push(["reload", id]),
        update: async (id, value) => calls.push(["update", id, value.url]),
      },
      storage: { session: { set: async (value) => calls.push(["pending", value.pendingPage]) } },
    };
    const context = loadHelpers({ chrome, importScripts: () => {} });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "background.js"), "utf8"), context);
    context.readSavedOverrideDirectories = async () => ({
      destination: { queryPermission: async () => permission },
    });
    context.getPageOverrideBaseUrl = async () => "http://localhost:8080/Shopping/";
    context.refreshSavedPages = async () => { calls.push(["refresh"]); return 2; };
    const url = "http://localhost:8080/Shopping/index.html?filter=x";
    await listener({ id: 12, url });
    if (permission === "granted") {
      assert.ok(calls.some((call) => call[0] === "refresh"));
      assert.ok(calls.some((call) => call[0] === "reload" && call[1] === 12));
      assert.ok(!calls.some((call) => call[0] === "pending"));
    } else {
      const pending = calls.find((call) => call[0] === "pending")[1];
      assert.equal(pending.refreshIndex, true);
      assert.equal(pending.indexUrl, url);
      assert.ok(calls.some((call) => call[0] === "update" && call[2].endsWith("/grant.html")));
      assert.ok(!calls.some((call) => call[0] === "refresh"));
    }
  }
});

test("permission page completes a pending index refresh and returns to the index", async () => {
  let click;
  const button = { addEventListener: (event, fn) => { click = fn; }, disabled: false };
  const message = { textContent: "" };
  const calls = [];
  const indexUrl = "http://localhost:8080/Shopping/index.html";
  const context = vm.createContext({
    document: { getElementById: (id) => id === "grant" ? button : message },
    chrome: { storage: { session: {
      get: async () => ({ pendingPage: { refreshIndex: true, indexUrl } }),
      remove: async (key) => calls.push(["remove", key]),
    } } },
    readSavedOverrideDirectories: async () => ({
      destination: { requestPermission: async () => "granted" },
    }),
    refreshSavedPages: async () => calls.push(["refresh"]),
    location: { replace: (url) => calls.push(["replace", url]) },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "grant.js"), "utf8"), context);
  await click();
  assert.deepEqual(calls, [["refresh"], ["remove", "pendingPage"], ["replace", indexUrl]]);
});

test("permission page reports a bulk refresh failure and allows retry", async () => {
  let click;
  const button = { addEventListener: (event, fn) => { click = fn; }, disabled: false };
  const message = { textContent: "" };
  const calls = [];
  const context = vm.createContext({
    document: { getElementById: (id) => id === "grant" ? button : message },
    chrome: { storage: { session: {
      get: async () => ({ pendingPage: { refreshIndex: true, indexUrl: "http://localhost/index.html" } }),
      remove: async () => calls.push("remove"),
    } } },
    readSavedOverrideDirectories: async () => ({
      destination: { requestPermission: async () => "granted" },
    }),
    refreshSavedPages: async () => { throw new Error("Refreshed 1 of 2 pages. Fetch failed."); },
    location: { replace: () => calls.push("replace") },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "grant.js"), "utf8"), context);
  await click();
  assert.match(message.textContent, /Refreshed 1 of 2 pages/);
  assert.equal(button.disabled, false);
  assert.deepEqual(calls, []);
});
