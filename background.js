importScripts("page-override.js");

let inProgress = false;

async function setBadge(tabId, text, title) {
  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#742F14" }),
    chrome.action.setTitle({ tabId, title }),
  ]);
}

chrome.action.onClicked.addListener(async (tab) => {
  if (inProgress) return;
  inProgress = true;
  const tabId = tab?.id;
  try {
    if (typeof tabId !== "number") throw new Error("Could not find the active tab.");
    const saved = await readSavedOverrideDirectories();
    if (!saved.destination) {
      await chrome.runtime.openOptionsPage();
      return;
    }
    const html = await captureTabHtml(tabId);
    if (await saved.destination.queryPermission({ mode: "readwrite" }) !== "granted") {
      // Chrome drops folder access when no extension page is open; re-granting needs a click.
      await chrome.storage.session.set({ pendingHtml: html });
      await chrome.tabs.update(tabId, { url: chrome.runtime.getURL("grant.html") });
      return;
    }
    const name = await savePageHtml(saved.destination, html);
    const baseUrl = await getPageOverrideBaseUrl();
    await chrome.tabs.update(tabId, { url: `${baseUrl}${encodeURIComponent(name)}` });
    await setBadge(tabId, "", "Page Override");
  } catch (error) {
    console.warn("Could not run Page Override", error);
    if (typeof tabId === "number") await setBadge(tabId, "!", `Page Override failed: ${error.message || String(error)}`);
  } finally {
    inProgress = false;
  }
});
