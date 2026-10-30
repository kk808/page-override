const status = document.getElementById("status");
const DB_NAME = "devtoolkit-page-override";
const MODES = { source: "readwrite", destination: "readwrite" };

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

const DEFAULT_BASE_URL = "http://localhost:8080/Shopping/";
const baseUrlInput = document.getElementById("base-url");

async function loadBaseUrl() {
  const { baseUrl } = await chrome.storage.local.get("baseUrl");
  baseUrlInput.value = baseUrl || DEFAULT_BASE_URL;
}

document.getElementById("save-url").addEventListener("click", async () => {
  try {
    const url = new URL(baseUrlInput.value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Use an http or https URL.");
    const baseUrl = url.href.endsWith("/") ? url.href : `${url.href}/`;
    await chrome.storage.local.set({ baseUrl });
    baseUrlInput.value = baseUrl;
    status.textContent = "Base URL saved.";
  } catch (error) {
    status.textContent = `Could not save URL: ${error.message || String(error)}`;
  }
});

document.getElementById("reset-url").addEventListener("click", async () => {
  await chrome.storage.local.remove("baseUrl");
  baseUrlInput.value = DEFAULT_BASE_URL;
  status.textContent = "Base URL reset to default.";
});

loadBaseUrl().catch((error) => { status.textContent = String(error.message || error); });

refresh().catch((error) => { status.textContent = String(error.message || error); });
