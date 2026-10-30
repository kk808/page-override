const grantButton = document.getElementById("grant");
const message = document.getElementById("message");

grantButton.addEventListener("click", async () => {
  grantButton.disabled = true;
  try {
    const saved = await readSavedOverrideDirectories();
    if (!saved.source || !saved.destination) {
      throw new Error("Choose the folders on the extension options page first.");
    }
    // Both requests must start from this click, so issue them together.
    const [source, destination] = await Promise.all([
      saved.source.requestPermission({ mode: "read" }),
      saved.destination.requestPermission({ mode: "readwrite" }),
    ]);
    if (source !== "granted" || destination !== "granted") throw new Error("Folder access was not granted.");
    const name = await copyNewestOverrideFile(saved.source, saved.destination);
    location.replace(`${PAGE_OVERRIDE_BASE_URL}${encodeURIComponent(name)}`);
  } catch (error) {
    message.textContent = `Could not complete Page Override: ${error.message || String(error)}`;
    grantButton.disabled = false;
  }
});
