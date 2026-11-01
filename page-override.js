// Shared by the side panel and the background worker (Alt+4 shortcut).
const DEFAULT_PAGE_OVERRIDE_BASE_URL = "http://localhost:8080/Shopping/";

async function getPageOverrideBaseUrl() {
  const { baseUrl } = await chrome.storage.local.get("baseUrl");
  return baseUrl || DEFAULT_PAGE_OVERRIDE_BASE_URL;
}

async function captureTabHtml(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const doctype = document.doctype ? new XMLSerializer().serializeToString(document.doctype) : "";
      return { html: doctype + document.documentElement.outerHTML, url: location.href };
    },
  });
  return result.result;
}

const FILE_NAME_PARAMS = ["TripType", "FromCode", "ToCode", "FromDate", "ToDate"];

function overrideFileName(pageUrl, date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  let params = new URLSearchParams();
  try { params = new URL(pageUrl).searchParams; } catch { /* no usable URL */ }
  const parts = FILE_NAME_PARAMS
    .map((key) => (params.get(key) || "").replace(/[^A-Za-z0-9]+/g, ""))
    .filter(Boolean);
  const timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return ["SearchFight", ...parts, timestamp].join("-");
}

async function savePageHtml(destinationDirectory, { html, url }) {
  const name = overrideFileName(url);
  const handle = await destinationDirectory.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  try {
    await writer.write(html);
    await writer.close();
  } catch (error) {
    try { await writer.abort(); }
    catch (abortError) { console.warn("Could not abort the incomplete page save", abortError); }
    throw error;
  }
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
