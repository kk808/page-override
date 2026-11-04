// Shared by the side panel and the background worker (Alt+4 shortcut).
const DEFAULT_PAGE_OVERRIDE_BASE_URL = "http://localhost:8080/Shopping/";

async function getPageOverrideBaseUrl() {
  const { baseUrl } = await chrome.storage.local.get("baseUrl");
  return baseUrl || DEFAULT_PAGE_OVERRIDE_BASE_URL;
}

// Captures the page's original HTML response body, exactly as DevTools "Override content" does:
// the raw document the server sent, before any script ran. The page's own scripts then rebuild the
// same rendered result when the saved copy is loaded.
async function captureTabHtml(tabId) {
  try {
    return await captureOriginalResponse(tabId);
  } catch (error) {
    console.warn("DevTools capture unavailable, falling back to a cached fetch", error);
    return await fetchOriginalResponse(tabId);
  }
}

// Reads the main document from the tab's resource tree via the Chrome DevTools Protocol.
async function captureOriginalResponse(tabId) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    // Page.enable is costly on heavy pages, so it is only sent if the direct read below is refused.
    const { frameTree } = await chrome.debugger.sendCommand(target, "Page.getFrameTree");
    const { id: frameId, url } = frameTree.frame;
    const read = () => chrome.debugger.sendCommand(target, "Page.getResourceContent", { frameId, url });
    let resource;
    try { resource = await read(); }
    catch { await chrome.debugger.sendCommand(target, "Page.enable"); resource = await read(); }
    const { content, base64Encoded } = resource;
    const html = base64Encoded
      ? new TextDecoder().decode(Uint8Array.from(atob(content), (c) => c.charCodeAt(0)))
      : content;
    return { html, url };
  } finally {
    chrome.debugger.detach(target).catch(() => {}); // not awaited: the HTML is already captured
  }
}

// Fallback (e.g. DevTools already open on the tab): re-read the document from the HTTP cache.
async function fetchOriginalResponse(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const response = await fetch(location.href, { cache: "force-cache", credentials: "include" });
      if (!response.ok) throw new Error(`Could not re-read the page (HTTP ${response.status}).`);
      return { html: await response.text(), url: location.href };
    },
  });
  if (!result?.result) throw new Error("Could not read the page HTML.");
  return result.result;
}

const FILE_NAME_PARAMS = ["TripType", "FromCode", "ToCode", "FromDate", "ToDate"];
const SEGMENT_FILE_NAME_PARAMS = ["TripType", "Segments"];

function overrideFileName(pageUrl, date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  let params = new URLSearchParams();
  try { params = new URL(pageUrl).searchParams; } catch { /* no usable URL */ }
  const keys = params.get("Segments") ? SEGMENT_FILE_NAME_PARAMS : FILE_NAME_PARAMS;
  const parts = keys
    .map((key) => (params.get(key) || "").replace(/_Economy/g, "").replace(/\s+/g, "").replace(/[^A-Za-z0-9_~-]+/g, ""))
    .filter(Boolean);
  const timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return ["SearchFight", ...parts, timestamp].join("-") + ".html";
}

function withTitle(html, title) {
  const titleTag = `<title>${title}</title>`;
  if (/<title[\s>]/i.test(html)) return html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, () => titleTag);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => head + titleTag);
  return html;
}

async function savePageHtml(destinationDirectory, { html, url }) {
  const name = overrideFileName(url);
  const handle = await destinationDirectory.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  try {
    await writer.write(withTitle(html, name.replace(/^SearchFight-/, "").replace(/\.html$/, "")));
    await writer.close();
  } catch (error) {
    try { await writer.abort(); }
    catch (abortError) { console.warn("Could not abort the incomplete page save", abortError); }
    throw error;
  }
  try { await updateIndex(destinationDirectory, { name, url }); }
  catch (error) { console.warn("Could not update index.html", error); }
  return name;
}
async function readSavedOverrideDirectories() {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("devtoolkit-page-override", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("directories");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open folder access storage."));
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("directories", "readonly");
      const store = transaction.objectStore("directories");
      const source = store.get("source");
      const destination = store.get("destination");
      transaction.oncomplete = () => resolve({ source: source.result || null, destination: destination.result || null });
      transaction.onerror = () => reject(transaction.error || new Error("Could not read saved folder access."));
      transaction.onabort = () => reject(transaction.error || new Error("Reading saved folder access was interrupted."));
    });
  } finally {
    database.close();
  }
}


// Keeps index.json (data) and index.html (viewer) in the destination folder in sync with saved pages.
async function updateIndex(destinationDirectory, { name, url }) {
  let entries = [];
  try {
    const file = await (await destinationDirectory.getFileHandle("index.json")).getFile();
    const parsed = JSON.parse(await file.text());
    if (Array.isArray(parsed)) entries = parsed;
  } catch { /* no index yet */ }
  const tripTypeFromName = (n) => n.replace(/\.html$/, "").split("-")[1] || "";
  let tripType = "";
  try { tripType = new URL(url).searchParams.get("TripType") || ""; } catch { /* no usable URL */ }
  entries = [{ name, tripType: tripType || tripTypeFromName(name) }, ...entries
    .filter((e) => e.name !== name)
    .map(({ name: entryName, tripType: entryTripType }) =>
      ({ name: entryName, tripType: entryTripType || tripTypeFromName(entryName) }))];
  const template = await (await fetch(chrome.runtime.getURL("index-template.html"))).text();
  for (const [fileName, content] of [["index.json", JSON.stringify(entries, null, 2)], ["index.html", template]]) {
    const writer = await (await destinationDirectory.getFileHandle(fileName, { create: true })).createWritable();
    await writer.write(content);
    await writer.close();
  }
}
