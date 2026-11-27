// @ts-check
// Message names between the extension's contexts; every message is { type, … }.

export const M = {
  // content script → worker
  hello: 'hello',
  toastAction: 'toast.action',
  // a save from the page's own gesture (Alt+click, a drop on the zone, the hover button), and the zone's destinations
  pageSave: 'page.save',
  // a keyboard shortcut caught in the page (reliable fallback for browser-reserved / Vivaldi-dropped chrome.commands)
  pageCommand: 'page.command',
  zoneRows: 'zone.rows',
  // a drag pulled far enough to show the drag card, and one that ended without a drop on it
  dragStart: 'drag.start',
  dragEnd: 'drag.end',
  // the area the person marked for a screenshot, in CSS pixels of the top frame
  cropDone: 'crop.done',
  // launch page → worker: whether a launch was granted to its tab
  launchCheck: 'launch.check',
  // worker → content script
  draftGet: 'draft.get',
  toast: 'toast',
  toastClose: 'toast.close',
  bytesRequest: 'bytes.request',
  // the text of what a site rule's selectors find in the frame, for tags
  tagsFrom: 'tags.from',
  cropStart: 'crop.start',
  // the panel in the page: open it with a secret the frame must show the worker, or close it
  frameOpen: 'frame.open',
  frameClose: 'frame.close',
  uiHide: 'ui.hide',
  // worker → sender, sender → worker
  send: 'send',
  progress: 'progress',
  done: 'done',
  launch: 'launch',
  held: 'held',
  launchTimeout: 'launch.timeout',
  shot: 'shot',
  // sender → worker, while it has nothing to do: for how long
  senderIdle: 'sender.idle',
  // worker → sender: take up what the queue holds (after a restart), and forget one removed in Options
  resume: 'resume',
  queueDrop: 'queue.drop',
  // the panel → sender: a screenshot it holds, for the preview
  shotData: 'shot.data',
  // sender → worker: the cookies of a download's address, read as it is sent
  cookies: 'cookies',
  // extension pages → worker
  captureGet: 'capture.get',
  captureNew: 'capture.new',
  captureSend: 'capture.send',
  menuClick: 'menu.click',
  launchAsk: 'launch.ask',
  // the panel in a page → worker: its secret, answered with what to show
  frameGrant: 'frame.grant',
  // the drag card → worker: dropped on its drop area (the panel) or on a folder
  frameDrop: 'frame.drop',
  sideDrop: 'side.drop',
  // side panel → worker: whether the side panel document is visible (Vivaldi keeps closed side panels loaded while hidden)
  sideState: 'side.state',
  // worker → side panel: liveness check when the browser omits the side panel from getContexts
  sidePing: 'side.ping',
  // content script → the drag card: a drop on the card, where it landed in it
  cardDrop: 'card.drop',
  // the toolbar button's menu → worker: one of its entries, for the tab it was opened over
  popupRun: 'popup.run',
  // a shortcut's command, for tools/ext.mjs, since the debugging protocol can't press one
  commandRun: 'command.run',
  // Options → worker: remove captures waiting for Curio
  queueRemove: 'queue.remove',
  // worker → extension pages
  captureState: 'capture.state',
}

/** A port a content script opens to the sender to hand over bytes only the page can read; the capture's id follows. */
export const BYTES_PORT = 'bytes:'

/** Base64 characters per chunk over that port: 8 MiB, as stage 0 measured (100 MB in under a second). */
export const CHUNK = 8 * 1024 * 1024

/**
 * Whether a message came from one of the extension's own pages or its worker, never from a content script.
 * @param {{ id?: string, url?: string }} sender
 * @param {string} base the extension's own address, chrome.runtime.getURL('')
 */
export function fromExtension(sender, base) {
  return !!sender && typeof sender.url === 'string' && sender.url.startsWith(base)
}
