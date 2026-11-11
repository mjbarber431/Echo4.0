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
// never runs script inside the EHR's pages, reads them or types into them: signing in is left to Chrome's
// own password manager, and every note is pasted, checked and signed by the clinician.

const CHROME_APP = ['/Applications/Google Chrome.app', join(homedir(), 'Applications', 'Google Chrome.app')]

/**
 * Runs in osascript. argv[0] is JSON, one of:
 * - { mode: 'windows', ehrs: [{ url, site, bounds? }] }: a window per EHR
 * - { mode: 'tabs', ehrs: [{ url, site }], bounds?, window? }: one window with a tab per EHR
 * - { mode: 'show', ehr: { url, site }, window? }: bring that EHR's tab to the front (opening it if it's gone)
 * An EHR already open in a tab (on any page of its site) is reused rather than opened again.
 * Returns { window }: the id of the window holding the EHRs (tabs and show), so the next call looks there first.
 */
const CHROME_SCRIPT = `
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
    if (fresh) win = chrome.Window().make()
    var list = cfg.mode === 'tabs' ? cfg.ehrs : [cfg.ehr]
    var first = 0
    list.forEach(function (ehr, i) {
      var t = tabIn(win, ehr.site)
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
  }

  windows().forEach(function (w) { if (blank.indexOf(w.id()) >= 0 && keep.indexOf(w.id()) < 0) w.close() })
  chrome.activate()
  return JSON.stringify(result)
}
`

type ChromeConfig =
  | { mode: 'windows'; ehrs: { url: string; site: string; bounds?: Rect }[] }
  | { mode: 'tabs'; ehrs: { url: string; site: string }[]; bounds?: Rect; window?: number }
  | { mode: 'show'; ehr: { url: string; site: string }; window?: number }

/** The Chrome window the EHRs were last opened in, so switching looks there first. */
let ehrWindow: number | undefined

function chromeInstalled(): boolean {
  return CHROME_APP.some((path) => existsSync(path))
}

function runChrome(config: ChromeConfig): Promise<{ window?: number }> {
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
      } else if (/timed out|ETIMEDOUT|SIGTERM/i.test(text)) {
        reject(new Error('Chrome didn’t respond in time. If it’s showing a dialog, close it and try again.'))
      } else reject(new Error(`Chrome couldn’t open the EHR: ${stderr.trim().split('\n').pop() || err.message}`))
    })
  })
}

/** Moves Echo's window, first leaving full screen (which would otherwise ignore the new bounds). */
async function placeEcho(win: BrowserWindow, rect: Rect): Promise<void> {
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

export async function openEhrs(win: BrowserWindow | null, saved: Ehr[] | undefined, layout: EhrLayout = DEFAULT_EHR_LAYOUT): Promise<{ note?: string }> {
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

/** Brings one EHR's tab to the front in Chrome, opening it if it isn't open, ready for the clinician to paste. */
export async function showEhr(saved: Ehr[] | undefined, id: string): Promise<void> {
  const ehr = usableEhrs(saved).find((e) => e.id === id)
  if (!ehr) throw new Error('That EHR isn’t in Settings › EHRs any more.')
  if (!chromeInstalled()) {
    await shell.openExternal(ehr.url)
    return
  }
  const { window } = await runChrome({ mode: 'show', ehr: { url: ehr.url, site: siteOf(ehr.url) }, window: ehrWindow })
  ehrWindow = window
}
