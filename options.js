const status = document.getElementById("status");
const DB_NAME = "devtoolkit-page-override";
const MODES = { source: "read", destination: "readwrite" };

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("directories");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open folder access storage."));
  });
}

async function writeStore(action) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("directories", "readwrite");
      action(transaction.objectStore("directories"));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("Saving folder access was interrupted."));
    });
  } finally {
    database.close();
  }
}

async function readSavedOverrideDirectories() {
  const database = await openDatabase();
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

function setLabel(key, name) {
  const label = key[0].toUpperCase() + key.slice(1);
  document.getElementById(`${key}-name`).textContent = `${label}: ${name ?? "not set"}`;
}

async function refresh() {
  const saved = await readSavedOverrideDirectories();
  for (const key of Object.keys(MODES)) setLabel(key, saved[key]?.name);
}

for (const key of Object.keys(MODES)) {
  document.getElementById(key).addEventListener("click", async () => {
    try {
      const handle = await window.showDirectoryPicker({ id: `dtk-override-${key}`, mode: MODES[key] });
      await writeStore((store) => store.put(handle, key));
      status.textContent = `${key} folder saved.`;
      setLabel(key, handle.name);
      await refresh();
    } catch (error) {
      if (error.name !== "AbortError") status.textContent = `Could not save folder: ${error.message || String(error)}`;
    }
  });
}

document.getElementById("clear").addEventListener("click", async () => {
  try {
    await writeStore((store) => store.clear());
    status.textContent = "Folders cleared.";
    for (const key of Object.keys(MODES)) setLabel(key, null);
  } catch (error) {
    status.textContent = `Could not clear folders: ${error.message || String(error)}`;
  }
});

refresh().catch((error) => { status.textContent = String(error.message || error); });
