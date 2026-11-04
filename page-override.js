// Shared by the side panel and the background worker (Alt+4 shortcut).
const DEFAULT_PAGE_OVERRIDE_BASE_URL = "http://localhost:8080/Shopping/";

async function getPageOverrideBaseUrl() {
  const { baseUrl } = await chrome.storage.local.get("baseUrl");
  return baseUrl || DEFAULT_PAGE_OVERRIDE_BASE_URL;
}

async function captureTabHtml(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    // MAIN world so live state (adopted stylesheets, CSSOM rules, shadow roots) is read exactly as the page sees it.
    world: "MAIN",
    func: () => {
      const doctype = document.doctype ? new XMLSerializer().serializeToString(document.doctype) : "";
      // Serialize a clone of the live DOM, folding in state that outerHTML alone loses.
      const cssText = (sheet) => {
        try { return Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n"); }
        catch { return null; } // cross-origin sheet: keep the original <link>
      };
      const inline = (liveRoot, cloneRoot, styleHost) => {
        const live = Array.from(liveRoot.querySelectorAll("*"));
        const clone = Array.from(cloneRoot.querySelectorAll("*"));
        live.forEach((src, i) => {
          const dst = clone[i];
          if (!dst || src.localName !== dst.localName) return;
          // Rules added via CSSOM (insertRule, CSS-in-JS) never reach the <style> text.
          if (src.localName === "style" && src.sheet) {
            const text = cssText(src.sheet);
            if (text !== null) dst.textContent = text;
          }
          // Current form state lives in properties, not attributes.
          if (src.localName === "input") {
            if (src.type === "checkbox" || src.type === "radio") dst.toggleAttribute("checked", src.checked);
            else if (src.type !== "password" && src.type !== "file") dst.setAttribute("value", src.value);
          } else if (src.localName === "textarea") {
            dst.textContent = src.value;
          } else if (src.localName === "option") {
            dst.toggleAttribute("selected", src.selected);
          }
        });
        // Constructable stylesheets (adoptedStyleSheets) are not in the markup at all.
        const adopted = Array.from(liveRoot.adoptedStyleSheets || [], cssText).filter((t) => t !== null);
        if (adopted.length && styleHost) {
          const style = document.createElement("style");
          style.setAttribute("data-adopted-stylesheets", "");
          style.textContent = adopted.join("\n");
          styleHost.append(style);
        }
        // Open shadow roots become declarative shadow DOM so the generated markup is kept.
        live.forEach((src, i) => {
          const dst = clone[i];
          if (!dst || src.localName !== dst.localName || !src.shadowRoot) return;
          const template = document.createElement("template");
          template.setAttribute("shadowrootmode", src.shadowRoot.mode);
          for (const child of src.shadowRoot.childNodes) template.content.append(child.cloneNode(true));
          inline(src.shadowRoot, template.content, template.content);
          dst.prepend(template);
        });
      };
      const root = document.documentElement.cloneNode(true);
      inline(document, root, root.querySelector("head"));
      // Relative URLs must keep resolving against the original site once the file is served from localhost.
      const head = root.querySelector("head");
      if (head && !head.querySelector("base[href]")) {
        const base = document.createElement("base");
        base.setAttribute("href", location.href);
        head.prepend(base);
      }
      return { html: doctype + root.outerHTML, url: location.href };
    },
  });
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
