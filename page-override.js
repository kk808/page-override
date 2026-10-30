// Shared by the side panel and the background worker (Alt+4 shortcut).
const PAGE_OVERRIDE_BASE_URL = "http://localhost:8080/Shopping/";

async function copyNewestOverrideFile(sourceDirectory, destinationDirectory) {
  let newestFile = null;
  for await (const [name, entry] of sourceDirectory.entries()) {
    if (entry.kind !== "file" || name.toLowerCase().endsWith(".crdownload")) continue;
    const file = await entry.getFile();
    if (!newestFile || file.lastModified > newestFile.file.lastModified) {
      newestFile = { name, file };
    }
  }
  if (!newestFile) throw new Error("No completed files were found in the source folder.");

  const destinationFile = await destinationDirectory.getFileHandle(newestFile.name, { create: true });
  const writer = await destinationFile.createWritable();
  try {
    await writer.write(newestFile.file);
    await writer.close();
  } catch (error) {
    try { await writer.abort(); }
    catch (abortError) { console.warn("Could not abort the incomplete page override copy", abortError); }
    throw error;
  }
  return newestFile.name;
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
