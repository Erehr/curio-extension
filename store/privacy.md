# Privacy statement

Send to Curio has no server and no account. It sends nothing to its makers or to anyone else, and it has no analytics, advertising or tracking.

## What it talks to

- **Curio on this computer**, at `http://127.0.0.1` on the port set in Options (41733 unless changed). Everything you save goes there, with the destination, name, notes, tags, rating and fields you gave it, and the address of the page it came from.
- **The site a file comes from, only through Curio.** To save a picture, video, sound or file with an address on the internet, the extension sends Curio the address, the page as `Referer` and the browser's `User-Agent`, and Curio downloads it. For some image hosts it also sends the address of a larger version of the picture: on the same host, on the host a resizing service (Next.js, Vercel, images.weserv.nl) was showing it from, or, for Reddit's previews, on `i.redd.it`. With *Send the site's cookies with a download* turned on in Options (off unless you turn it on), it reads the browser's cookies for that address when it sends the save, and Curio sends them to that address's own host only; neither keeps them. With *Download through the browser* turned on, the browser fetches the file itself instead, with your sign-ins for that site and the page as `Referer`, as the page itself did.
- **Pages on this computer or its network.** What has no address on the internet (a screenshot, a picture the page drew, a file on a local server) is read by the browser from the page or its address and sent to Curio as it is.

It contacts no other address.

## What it reads in pages

The extension's script runs in every page so that a right-click, Alt+click, drag or shortcut can find what is under the pointer. It notes where the pointer is, for the shortcut, and with *Mode* set to *Button* it looks at pictures the pointer rests on, to place the button. Nothing it reads leaves the page until you act: then it reads the element you act on, and the page's title and address, and sends them to Curio. A screenshot is taken only when you ask for one, and when *Save to Curio* opens the panel on a picture or video: then the visible tab is cut to that element at once and kept in memory as the panel's preview, for addresses that won't load outside the page; it is never sent anywhere or kept.

## What it keeps on this computer

In the browser's storage for the extension, never synced:

- the connection to Curio: the port, and the token Curio issued when you allowed the extension;
- your settings, site rules, last and recent destinations;
- Curio's library, folder and tag names as last listed, and Curio's colours, to draw the menus and the panel quickly;
- saves waiting for Curio to start, with the files the browser read (up to 500 MB), until they are saved or you remove them in Options; never cookies;
- the saves of the current browser session, until the browser closes.

Removing the extension deletes all of it. Curio keeps what you saved in your library, and lists the extension's token in its Settings › API, where you can revoke it.

## Store data-use answers

- Personally identifiable information, health, financial, location, personal communications: not collected.
- Authentication information: the token for Curio, kept on this computer, used only to call Curio on this computer. With *Send the site's cookies with a download* turned on, a site's cookies, read when a save is sent and passed to Curio on this computer for that one download, never stored.
- Website content: what you choose to save, sent only to Curio on this computer.
- Web history: the address of the page a save came from, sent only to Curio with that save.
- User activity: not collected.
- Data is not sold, not transferred to third parties, and not used for anything but saving into Curio.
