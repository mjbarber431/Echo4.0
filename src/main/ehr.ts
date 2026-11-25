import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { screen, shell, type BrowserWindow } from 'electron'
import { DEFAULT_EHR_LAYOUT, layoutRects, siteOf, usableEhrs, usesTabs, type Ehr, type EhrLayout, type Rect } from '../shared/ehr'

// Opens the clinician's EHRs in Chrome, arranges the windows beside Echo, and brings one forward on request.
//
// Chrome is driven with Apple Events (JavaScript for Automation through osascript): make a window or tab,
// point it at the EHR's page, move it, pick a tab. macOS asks once whether Echo may control Chrome. Echo
// never runs script inside the EHR's pages: signing in is left to Chrome's own password manager, and every
// note is checked and signed by the clinician. Only when placing notes with Claude is turned on does Echo
// look at the EHR's window and click in it (placer.ts), and then only while the clinician watches.

const CHROME_APP = ['/Applications/Google Chrome.app', join(homedir(), 'Applications', 'Google Chrome.app')]

/**
 * Runs in osascript. argv[0] is JSON, one of:
 * - { mode: 'windows', ehrs: [{ url, site, bounds? }] }: a window per EHR
 * - { mode: 'tabs', ehrs: [{ url, site }], bounds?, window? }: one window with a tab per EHR
 * - { mode: 'show', ehr: { url, site }, window?, newTab?, bounds? }: bring that EHR's tab to the front (opening it if it's gone);
 *   with newTab, open a new tab of it beside the others instead, leaving the ones already open as they are; with bounds, move its window there
 * An EHR already open in a tab (on any page of its site) is reused rather than opened again.
 * Returns { window, bounds }: the id of the window holding the EHRs (tabs and show), so the next call looks there
 * first, and where it is on screen.
 */
const CHROME_SCRIPT = `
ObjC.import('AppKit')

function activateMainWindowOnly(chrome) {
  if (chrome.frontmost()) return
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.google.Chrome')
  // Without NSApplicationActivateAllWindows, only the main and key windows come forward.
  if (apps.count > 0) apps.objectAtIndex(0).activateWithOptions($.NSApplicationActivateIgnoringOtherApps)
  else chrome.activate()
}

function run(argv) {
  var cfg = JSON.parse(argv[0])
  var chrome = Application('Google Chrome')
  var wasRunning = chrome.running()
  if (!wasRunning) {
    chrome.activate()
    for (var wait = 0; wait < 20 && !chrome.running(); wait++) delay(0.25)
    delay(1)
  }
  function siteOf(url) {
    var m = /^https?:\\/\\/([^\\/?#:]+)/i.exec(url || '')
    if (!m) return ''
    return m[1].toLowerCase().replace(/^www\\./, '').split('.').slice(-2).join('.')
  }
  function windows() {
    return chrome.windows().filter(function (w) { return w.mode() !== 'incognito' })
  }
  function byId(id) {
    if (id == null) return null
    var ws = windows()
    for (var i = 0; i < ws.length; i++) if (ws[i].id() === id) return ws[i]
    return null
  }
  /** The tab index (1-based) in w showing site, or 0. */
  function tabIn(w, site) {
    var tabs = w.tabs()
    for (var t = 0; t < tabs.length; t++) if (siteOf(tabs[t].url()) === site) return t + 1
    return 0
  }
  function isBlank(w) {
    var tabs = w.tabs()
    return tabs.length === 1 && /^chrome:\\/\\/newtab/.test(tabs[0].url())
  }
  /** Adds a tab for url at the end of w and returns its index. */
  function addTab(w, url) {
    w.tabs.push(chrome.Tab({ url: url }))
    return w.tabs().length
  }
  // A window Chrome opened on launch with nothing in it, to close once the EHRs have their own.
  var blank = []
  if (!wasRunning) windows().forEach(function (w) { if (isBlank(w)) blank.push(w.id()) })
  var keep = []
  var result = {}

  if (cfg.mode === 'windows') {
    cfg.ehrs.forEach(function (ehr) {
      var win = null
      windows().forEach(function (w) {
        if (win || keep.indexOf(w.id()) >= 0) return
        var t = tabIn(w, ehr.site)
        if (t) { w.activeTabIndex = t; win = w }
      })
      if (!win) {
        win = chrome.Window().make()
        win.activeTab.url = ehr.url
      }
      keep.push(win.id())
      if (ehr.bounds) win.bounds = ehr.bounds
      win.index = 1
    })
  } else {
    // One window for the EHRs: the one used last time, else the one already showing the most of them.
    var sites = (cfg.mode === 'tabs' ? cfg.ehrs : [cfg.ehr]).map(function (e) { return e.site })
    var win = byId(cfg.window)
    if (!win) {
      var best = 0
      windows().forEach(function (w) {
        var n = sites.filter(function (s) { return tabIn(w, s) }).length
        if (n > best) { best = n; win = w }
      })
    }
    // Showing one EHR that's open elsewhere: use that tab where it is.
    if (cfg.mode === 'show' && (!win || !tabIn(win, cfg.ehr.site))) {
      windows().forEach(function (w) { if (tabIn(w, cfg.ehr.site) && (!win || !tabIn(win, cfg.ehr.site))) win = w })
    }
    var fresh = !win
    // Made where it's going, so it doesn't open over Echo first and then jump aside.
    if (fresh) win = chrome.Window(cfg.bounds ? { bounds: cfg.bounds } : {}).make()
    var list = cfg.mode === 'tabs' ? cfg.ehrs : [cfg.ehr]
    var first = 0
    list.forEach(function (ehr, i) {
      var t = cfg.newTab ? 0 : tabIn(win, ehr.site)
      if (!t) {
        if (fresh && i === 0 && isBlank(win)) { win.activeTab.url = ehr.url; t = 1 }
        else t = addTab(win, ehr.url)
      }
      if (i === 0) first = t
    })
    if (cfg.bounds) win.bounds = cfg.bounds
    win.activeTabIndex = first
    win.index = 1
    keep.push(win.id())
    result.window = win.id()
    result.bounds = win.bounds()
  }

  windows().forEach(function (w) { if (blank.indexOf(w.id()) >= 0 && keep.indexOf(w.id()) < 0) w.close() })
  // Scripted activate brings every Chrome window forward, so the clinician's other Chrome windows would land on top
  // of Echo. To show one EHR, Chrome comes forward with just its main window: the EHR's, put first above.
  if (cfg.mode === 'show') activateMainWindowOnly(chrome)
  else chrome.activate()
  return JSON.stringify(result)
}
`

type ChromeConfig =
  | { mode: 'windows'; ehrs: { url: string; site: string; bounds?: Rect }[] }
  | { mode: 'tabs'; ehrs: { url: string; site: string }[]; bounds?: Rect; window?: number }
  | { mode: 'show'; ehr: { url: string; site: string }; window?: number; newTab?: boolean; bounds?: Rect }

/** The Chrome window the EHRs were last opened in, so switching looks there first. */
let ehrWindow: number | undefined

function chromeInstalled(): boolean {
  return CHROME_APP.some((path) => existsSync(path))
}

/** The Chrome script running now, if any. Scripts run one at a time: two at once trip over each other's windows ("Can't get object", -1728). */
let chromeBusy: Promise<unknown> = Promise.resolve()

function runChrome(config: ChromeConfig): Promise<{ window?: number; bounds?: Rect }> {
  const next = chromeBusy.then(async () => {
    await unstickChrome()
    return runChromeNow(config)
  })
  chromeBusy = next.catch(() => {})
  return next
}

/** Runs a short AppleScript, resolving with whether it worked in time. */
function quick(lines: string[], timeout: number): Promise<boolean> {
  return new Promise((resolve) => execFile('osascript', lines.flatMap((l) => ['-e', l]), { timeout }, (err) => resolve(!err)))
}

/**
 * An open dropdown menu in Chrome (a <select> left open, as an EHR's template picker can be) holds up every script sent
 * to it until the menu closes. If Chrome doesn't answer straight away, Escape closes the menu.
 */
async function unstickChrome(): Promise<void> {
  // Asked only if Chrome is running: telling it anything would open it.
  const answers = await quick(['if application "Google Chrome" is running then', 'with timeout of 2 seconds', 'tell application "Google Chrome" to count windows', 'end timeout', 'end if'], 4000)
  if (answers) return
  // System Events still answers while Chrome is stuck: bring Chrome forward that way, then Escape goes to its menu.
  await quick(['tell application "System Events"', 'set frontmost of process "Google Chrome" to true', 'delay 0.2', 'if frontmost of process "Google Chrome" then key code 53', 'end tell'], 3000)
  await new Promise((r) => setTimeout(r, 300))
}

function runChromeNow(config: ChromeConfig): Promise<{ window?: number; bounds?: Rect }> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', CHROME_SCRIPT, JSON.stringify(config)], { timeout: 30_000 }, (err, stdout, stderr) => {
      if (!err) {
        try {
          return resolve(JSON.parse(stdout.trim() || '{}'))
        } catch {
          return resolve({})
        }
      }
      const text = `${stderr} ${err.message}`
      if (/-1743|not authori[sz]ed|not allowed to send/i.test(text)) {
        reject(new Error('Echo isn’t allowed to control Chrome. Turn on Google Chrome under Echo in System Settings › Privacy & Security › Automation, then try again.'))
      } else if (err.killed || /timed out|ETIMEDOUT|SIGTERM/i.test(text)) {
        reject(new Error('Chrome didn’t respond in time. If it’s showing a dialog, close it and try again.'))
      } else reject(new Error(`Chrome couldn’t open the EHR: ${stderr.trim().split('\n').pop() || 'it didn’t say why'}`))
    })
  })
}

/** Echo's window as it was before the EHRs were laid out beside it, to put back when charting ends. */
let echoBefore: { bounds: Rect; minimum: [number, number]; maximized: boolean } | null = null

/** Puts Echo's window back the way it was before the EHRs were laid out beside it. The EHRs stay open. */
export function restoreEcho(win: BrowserWindow | null): void {
  const before = echoBefore
  echoBefore = null
  if (!before || !win || win.isDestroyed()) return
  win.setMinimumSize(...before.minimum)
  win.setBounds(before.bounds, true)
  if (before.maximized) win.maximize()
}

/** Moves Echo's window, first leaving full screen (which would otherwise ignore the new bounds). */
async function placeEcho(win: BrowserWindow, rect: Rect): Promise<void> {
  // Only the first layout of a charting session is remembered, so laying out again doesn't lose it.
  if (!echoBefore) {
    const [w, h] = win.getMinimumSize()
    echoBefore = { bounds: win.isFullScreen() || win.isMaximized() ? win.getNormalBounds() : win.getBounds(), minimum: [w, h], maximized: win.isMaximized() }
  }
  if (win.isFullScreen()) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500)
      win.once('leave-full-screen', () => {
        clearTimeout(timer)
        resolve()
      })
      win.setFullScreen(false)
    })
  }
  if (win.isMinimized()) win.restore()
  if (win.isMaximized()) win.unmaximize()
  // A share of a laptop screen can be smaller than Echo's usual minimum.
  const [minWidth, minHeight] = win.getMinimumSize()
  win.setMinimumSize(Math.min(minWidth, rect.width), Math.min(minHeight, rect.height))
  win.setBounds(rect, true)
}

/** Laying the EHRs out already under way: a second request while it runs (a double click, a view opening twice) shares it. */
let opening: Promise<{ note?: string }> | null = null

export function openEhrs(win: BrowserWindow | null, saved: Ehr[] | undefined, layout: EhrLayout = DEFAULT_EHR_LAYOUT): Promise<{ note?: string }> {
  if (!opening) opening = openEhrsNow(win, saved, layout).finally(() => (opening = null))
  return opening
}

async function openEhrsNow(win: BrowserWindow | null, saved: Ehr[] | undefined, layout: EhrLayout): Promise<{ note?: string }> {
  const ehrs = usableEhrs(saved)
  if (!ehrs.length) throw new Error('Add your EHRs in Settings › EHRs first.')

  if (!chromeInstalled()) {
    for (const e of ehrs) await shell.openExternal(e.url)
    return { note: 'Chrome isn’t installed, so the EHRs opened in your default browser and weren’t arranged.' }
  }

  // Lay the windows out on the screen Echo is on.
  const display = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()
  const rects = layoutRects(ehrs.length + 1, display.workArea, layout)
  const sites = ehrs.map((e) => ({ url: e.url, site: siteOf(e.url) }))
  if (usesTabs(layout)) {
    const { window } = await runChrome({ mode: 'tabs', ehrs: sites, bounds: rects[1], window: ehrWindow })
    ehrWindow = window
  } else {
    await runChrome({ mode: 'windows', ehrs: sites.map((s, i) => ({ ...s, bounds: rects[i + 1] })) })
  }

  if (win && !win.isDestroyed() && rects.length) {
    await placeEcho(win, rects[0])
    // Echo comes back to the front: the note is copied from here.
    win.show()
    win.focus()
  }
  return {}
}

/**
 * Brings one EHR's tab to the front in Chrome, opening it if it isn't open, ready for the clinician to paste.
 * Resolves with where Chrome's window is on screen (undefined without Chrome).
 */
export async function showEhr(saved: Ehr[] | undefined, id: string, newTab = false, beside?: { win: BrowserWindow | null; layout?: EhrLayout }): Promise<Rect | undefined> {
  const ehr = usableEhrs(saved).find((e) => e.id === id)
  if (!ehr) throw new Error('That EHR isn’t in Settings › EHRs any more.')
  if (!chromeInstalled()) {
    await shell.openExternal(ehr.url)
    return undefined
  }
  // Beside: just Echo and this EHR's window, laid out as charting lays them out, both in front.
  const win = beside?.win && !beside.win.isDestroyed() ? beside.win : null
  const layout = beside?.layout ?? DEFAULT_EHR_LAYOUT
  const rects = win ? layoutRects(2, screen.getDisplayMatching(win.getBounds()).workArea, layout) : []
  if (win && rects.length === 2) await placeEcho(win, rects[0])
  const { window, bounds } = await runChrome({ mode: 'show', ehr: { url: ehr.url, site: siteOf(ehr.url) }, window: ehrWindow, newTab, ...(rects.length === 2 ? { bounds: rects[1] } : {}) })
  ehrWindow = window
  return bounds
}
