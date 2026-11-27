# Permission justifications

For the store's review, one per entry in `manifest.json`.

| Permission | Why |
|---|---|
| Host access to all sites (`<all_urls>`) | The script that finds what is under the pointer runs in every page, since a picture worth saving can be on any site. The browser fetches the file from its own site with the person's sign-ins, which needs access to that site. Calls to Curio on `127.0.0.1` need it too. |
| `storage` | The connection to Curio, settings, site rules, recent destinations, and the saves of the current session. |
| `contextMenus` | *Save to Curio* on the right-click menu, and the toolbar button's own menu. |
| `offscreen` | A document that fetches files and calls Curio, since an add can wait up to two minutes while Curio opens a library, longer than the browser lets the background worker wait. |
| `scripting` | Registering the optional button on pictures only while it is turned on, putting the content script into tabs already open at install, and asking each frame where the pointer was for the save shortcut. |
| `cookies` | With *Send the site's cookies with a download* turned on (off unless the person turns it on), reading the cookies the browser holds for the address of a file being saved, so Curio's download of it is signed in as the browser is. Read when the save is sent, passed to Curio on this computer for that download, never stored. |
| `declarativeNetRequestWithHostAccess` | Sending the page as `Referer` when the extension fetches a file, as the page did, for sites that refuse files to other referrers. One rule per fetch, limited to the extension's own requests, removed when the fetch ends. |
| `sidePanel` | The panel can live in the browser's side panel, when turned on in Options. |
| `web_accessible_resources`: `launch/launch.html`, `panel/panel.html` | The launch page is a hidden frame that opens a `curio://` link to start Curio when the person clicks *Open Curio*; it acts only on a launch the extension granted to that tab a moment before. The panel page is the panel and the drag card drawn over a page, in a frame the page can't read; it shows only for a one-time secret the extension made for that tab. |
| Remote code | None. Every script is in the package. |
