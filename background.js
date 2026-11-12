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
    const baseUrl = await getPageOverrideBaseUrl();
    if (isSavedIndexPage(tab.url, baseUrl)) {
      if (await saved.destination.queryPermission({ mode: "readwrite" }) !== "granted") {
        await chrome.storage.session.set({ pendingPage: { refreshIndex: true, indexUrl: tab.url } });
        await chrome.tabs.update(tabId, { url: chrome.runtime.getURL("grant.html") });
        return;
      }
      await setBadge(tabId, "...", "Page Override: refreshing saved pages");
      const count = await refreshSavedPages(saved.destination);
      await chrome.tabs.reload(tabId);
      await setBadge(tabId, "", `Page Override: refreshed ${count} saved pages`);
      return;
    }
    const existingName = savedPageFileName(tab.url, baseUrl);
    const recaptured = existingName
      ? await recaptureSavedPage(tabId, saved.destination, existingName)
      : null;
    const isSavedPage = Boolean(recaptured);
    const page = recaptured || await captureTabHtml(tabId);
    if (await saved.destination.queryPermission({ mode: "readwrite" }) !== "granted") {
      // Chrome drops folder access when no extension page is open; re-granting needs a click.
      await chrome.storage.session.set({ pendingPage: page });
      if (isSavedPage) {
        await chrome.tabs.update(tabId, { url: chrome.runtime.getURL("grant.html") });
      } else {
        await chrome.tabs.create({ url: chrome.runtime.getURL("grant.html"), index: tab.index + 1, openerTabId: tabId });
      }
      return;
    }
    const name = await savePageHtml(saved.destination, page);
    if (isSavedPage) {
      await chrome.tabs.reload(tabId);
    } else {
      await chrome.tabs.create({ url: `${baseUrl}${encodeURIComponent(name)}`, index: tab.index + 1, openerTabId: tabId });
    }
    await setBadge(tabId, "", "Page Override");
  } catch (error) {
    console.warn("Could not run Page Override", error);
    if (typeof tabId === "number") await setBadge(tabId, "!", `Page Override failed: ${error.message || String(error)}`);
  } finally {
    inProgress = false;
  }
});
