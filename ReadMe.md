# Page Override

**Page Override** is a Manifest V3 Chrome extension (minimum Chrome 116) designed for local flight-shopping development workflows (e.g., Webjet). With a single click or keyboard shortcut (`Alt+4`), it captures the live rendered DOM of the active tab, saves it as a snapshot file into a local directory on disk, and navigates the tab to load that snapshot from a `localhost` server.

---

## Features

- **One-step capture & redirect:** Captures the live rendered HTML (`doctype` + `documentElement.outerHTML`) of the current tab and opens it on your local server in the same tab.
- **Keyboard shortcut:** Trigger via toolbar icon click or **`Alt+4`** (`_execute_action`).
- **Smart flight-search naming:** Automatically derives descriptive snapshot filenames from flight query parameters (`TripType`, `FromCode`, `ToCode`, `FromDate`, `ToDate`, or `Segments`) plus a timestamp.
- **Tab title tagging:** Updates the saved HTML `<title>` tag to match the snapshot identifier so local override tabs are easy to distinguish.
- **Seamless folder permission recovery:** Handles Chrome's session-scoped File System Access API permissions via a built-in re-grant screen (`grant.html`) without losing the captured page.

---

## Saved Pages Index

Every save also updates `index.json` and `index.html` in the destination folder (from `index-template.html`). Open `<Base URL>index.html` (e.g. `http://localhost:8080/Shopping/index.html`) to list, filter and open all saved pages. To delete pages, click **Enable delete** on that page and pick the destination folder; delete removes the file and its index entry.

---

## Installation & Setup

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `PageOverride` directory.
4. Configure the extension (right-click the extension icon → **Options**, or click the icon once before setup):
   - **Destination folder:** Click **Choose destination** and select the local directory served by your local web server.
   - **Base URL:** Set the URL prefix that maps to that local folder (defaults to `http://localhost:8080/Shopping/`) and click **Save URL**.

---

## Usage

1. Navigate to the page you want to capture (e.g., a live or staging flight search results page).
2. Click the **Page Override** toolbar icon or press **`Alt+4`**.
3. If Chrome requires re-confirming folder write access after a browser restart, click **Grant access and open page** on the prompt page.
4. The HTML snapshot is written to your destination folder and the current tab automatically navigates to `<Base URL><Snapshot Filename>`.

> If an error occurs, the extension displays a `!` badge on its toolbar icon—hover over the icon to view the error message.

---

## How It Works

1. **Trigger (`background.js`)**
   - Listens to `chrome.action.onClicked`.
   - Reads the saved `destination` `FileSystemDirectoryHandle` from IndexedDB (`devtoolkit-page-override` via `readSavedOverrideDirectories()`). If unset, opens `options.html`.
2. **Capture Live HTML (`page-override.js`)**
   - `captureTabHtml()` uses `chrome.scripting.executeScript` on the active tab to serialize `document.doctype` and `document.documentElement.outerHTML`, along with `location.href`.
3. **Filename & Title Formatting (`page-override.js`)**
   - `overrideFileName()` extracts URL query parameters:
     - When `Segments` is present: `TripType`, `Segments`
     - Otherwise: `TripType`, `FromCode`, `ToCode`, `FromDate`, `ToDate`
   - Strips `_Economy`, whitespace, and special characters, prefixes with `SearchFight-`, and appends a `YYYYMMDDHHmmss` timestamp and a `.html` extension, e.g.:
     ```text
     SearchFight-Return-MEL-SYD-20261101-20261105-20261101220650
     ```
   - `withTitle()` replaces or injects `<title>` inside `<head>` using the generated name without the `SearchFight-` prefix.
   - `savePageHtml()` writes the formatted HTML to the destination folder via the File System Access API.
4. **Folder Permission Re-grant (`grant.html`, `grant.js`)**
   - Chrome revokes `FileSystemDirectoryHandle` write access across sessions, and service workers cannot invoke `requestPermission()` without a user gesture.
   - When `queryPermission({ mode: "readwrite" })` is not `"granted"`, `background.js` stores the captured payload in `chrome.storage.session` (`pendingPage`) and opens `grant.html`. Clicking the button re-requests permission, writes the file, clears `pendingPage`, and redirects to `localhost`.
5. **Localhost Redirect**
   - `getPageOverrideBaseUrl()` reads `baseUrl` from `chrome.storage.local` (falling back to `http://localhost:8080/Shopping/`) and navigates the tab to `<baseUrl><encodeURIComponent(name)>`.

---

## Project Structure

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 configuration, permissions (`storage`, `activeTab`, `scripting`), and `Alt+4` shortcut. |
| `background.js` | Service worker handling toolbar/shortcut triggers, permission checks, tab redirection, and error badges. |
| `page-override.js` | Shared helpers for DOM capture, filename generation, `<title>` rewriting, file saving, and IndexedDB lookup. |
| `options.html` / `options.js` | Settings UI for choosing/clearing the local destination directory and configuring the `localhost` base URL. |
| `grant.html` / `grant.js` | User-gesture prompt page to re-authorize local folder write access and complete a pending save. |
| `icons/` | Extension icons (`16`, `32`, `48`, `128` px). |

