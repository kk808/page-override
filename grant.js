const grantButton = document.getElementById("grant");
const message = document.getElementById("message");

grantButton.addEventListener("click", async () => {
  grantButton.disabled = true;
  try {
    const saved = await readSavedOverrideDirectories();
    if (!saved.destination) throw new Error("Choose the destination folder on the extension options page first.");
    if (await saved.destination.requestPermission({ mode: "readwrite" }) !== "granted") {
      throw new Error("Folder access was not granted.");
    }
    const { pendingPage } = await chrome.storage.session.get("pendingPage");
    if (!pendingPage?.html) throw new Error("No captured page was found. Run Page Override again.");
    const name = await savePageHtml(saved.destination, pendingPage);
    await chrome.storage.session.remove("pendingPage");
    const baseUrl = await getPageOverrideBaseUrl();
    location.replace(`${baseUrl}${encodeURIComponent(name)}`);
  } catch (error) {
    message.textContent = `Could not complete Page Override: ${error.message || String(error)}`;
    grantButton.disabled = false;
  }
});
