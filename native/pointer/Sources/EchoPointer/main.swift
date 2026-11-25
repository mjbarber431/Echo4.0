import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

// EchoPointer: one JSON request per line on stdin, one JSON reply per line on stdout.
//
// Request: { "id": 1, "cmd": "...", ...arguments }
// Reply:   { "id": 1, "ok": true, ...result }  or  { "id": 1, "ok": false, "error": "..." }
//
// Coordinates are global screen points with the origin at the top left of the main display
// (the space Chrome's AppleScript window bounds and CGEvent use). Every pointer action names
// the target window and is refused unless that window's app is what's at the spot, so a click
// can't land in Echo or anything else that has moved over the EHR.
//
// Nothing is written to stderr or to disk: screenshots go straight back over stdout.

let out = FileHandle.standardOutput
let writeLock = NSLock()

func reply(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object), var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    writeLock.lock()
    out.write(line.data(using: .utf8)!)
    writeLock.unlock()
}

struct Failure: Error { let message: String }

func fail(_ message: String) -> Failure { Failure(message: message) }

// MARK: - Windows

struct WindowInfo {
    let id: CGWindowID
    let pid: pid_t
    let owner: String
    let layer: Int
    let alpha: Double
    let frame: CGRect
}

/** On-screen windows, front to back. */
func onScreenWindows() -> [WindowInfo] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    return list.compactMap { w in
        guard let id = w[kCGWindowNumber as String] as? CGWindowID,
              let pid = w[kCGWindowOwnerPID as String] as? pid_t,
              let boundsDict = w[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: boundsDict) else { return nil }
        return WindowInfo(
            id: id,
            pid: pid,
            owner: w[kCGWindowOwnerName as String] as? String ?? "",
            layer: w[kCGWindowLayer as String] as? Int ?? 0,
            alpha: w[kCGWindowAlpha as String] as? Double ?? 1,
            frame: frame
        )
    }
}

func windowInfo(_ id: CGWindowID) -> WindowInfo? {
    guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]], let w = list.first,
          let pid = w[kCGWindowOwnerPID as String] as? pid_t,
          let boundsDict = w[kCGWindowBounds as String] as? NSDictionary,
          let frame = CGRect(dictionaryRepresentation: boundsDict) else { return nil }
    let onScreen = w[kCGWindowIsOnscreen as String] as? Bool ?? false
    if !onScreen { return nil }
    return WindowInfo(id: id, pid: pid, owner: w[kCGWindowOwnerName as String] as? String ?? "", layer: w[kCGWindowLayer as String] as? Int ?? 0, alpha: 1, frame: frame)
}

func frameJSON(_ r: CGRect) -> [String: Any] {
    ["x": Double(r.origin.x), "y": Double(r.origin.y), "width": Double(r.width), "height": Double(r.height)]
}

/** The Chrome window whose bounds match what Chrome's AppleScript reported (within a couple of points). */
func findWindow(_ args: [String: Any]) throws -> [String: Any] {
    guard let b = args["bounds"] as? [String: Any],
          let x = b["x"] as? Double, let y = b["y"] as? Double, let w = b["width"] as? Double, let h = b["height"] as? Double else { throw fail("No bounds given.") }
    let target = CGRect(x: x, y: y, width: w, height: h)
    let candidates = onScreenWindows().filter { $0.owner == "Google Chrome" && $0.layer == 0 }
    let close = candidates.filter { abs($0.frame.minX - target.minX) <= 3 && abs($0.frame.minY - target.minY) <= 3 && abs($0.frame.width - target.width) <= 3 && abs($0.frame.height - target.height) <= 3 }
    guard let match = close.first ?? candidates.first(where: { $0.frame.intersects(target) }) else { throw fail("Couldn’t find the EHR’s Chrome window on screen.") }
    return ["window": Int(match.id), "pid": Int(match.pid), "frame": frameJSON(match.frame)]
}

/** Throws unless the topmost visible window at `point` belongs to the same app as `window`. */
func checkTarget(_ point: CGPoint, window: CGWindowID) throws {
    guard let target = windowInfo(window) else { throw fail("The EHR’s window isn’t on screen any more.") }
    guard target.frame.contains(point) else { throw fail("That spot is outside the EHR’s window.") }
    // Ordinary app windows (layers 0–19: documents, panels, alerts) can cover the EHR. The system's own layers
    // above them (the Dock's invisible full-screen window, the menu bar, notifications) aren't counted: the EHR's
    // window is placed inside the screen's work area, clear of the Dock and menu bar. Chrome's own menus and pop-ups,
    // on any layer, belong to the EHR.
    let hit = onScreenWindows().first { w in
        guard w.alpha > 0.01, w.frame.contains(point) else { return false }
        return w.pid == target.pid || (w.layer >= 0 && w.layer < 20)
    }
    if let hit, hit.pid != target.pid {
        throw fail("\(hit.owner.isEmpty ? "Another window" : hit.owner) is covering the EHR at that spot.")
    }
}

/**
 * Keys go to whichever app is in front, and a click on an app that isn't in front only brings it forward, so before
 * typing or clicking make sure the EHR's app (Chrome) is in front, bringing it forward if the clinician was last in
 * Echo. Throws rather than type into anything else.
 */
func ensureFront(_ window: CGWindowID) throws {
    guard let target = windowInfo(window) else { throw fail("The EHR’s window isn’t on screen any more.") }
    if frontPid() == target.pid { return }
    guard let app = NSRunningApplication(processIdentifier: target.pid) else { throw fail("Chrome isn’t running.") }
    // macOS can take a moment to hand the front to another app when the request comes from a helper like this one.
    app.activate(options: [.activateIgnoringOtherApps])
    for _ in 0..<60 {
        usleep(50_000)
        // Once it's in front, a moment more for its window to take clicks and keys: a click sooner only brings it forward.
        if frontPid() == target.pid { usleep(300_000); return }
    }
    throw fail("Couldn’t bring the EHR’s window to the front.")
}

/**
 * The app in front now. Asked of the accessibility system each time: NSWorkspace's frontmostApplication only updates
 * when this helper handles notifications, which it never does while it waits for commands, so it goes stale.
 */
func frontPid() -> pid_t? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &value) == .success,
          let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return NSWorkspace.shared.frontmostApplication?.processIdentifier }
    var pid: pid_t = 0
    return AXUIElementGetPid(value as! AXUIElement, &pid) == .success ? pid : nil
}

// MARK: - Capture

/// Chrome's windows only, cropped to the EHR window's frame: Echo and every other app are left out.
func grab(_ id: CGWindowID, maxEdge: Double, cursor: Bool) throws -> (CGImage, CGRect) {
    guard let info = windowInfo(id) else { throw fail("The EHR’s window isn’t on screen any more.") }
    var result: Result<(CGImage, CGRect), Error> = .failure(fail("Capture didn’t finish."))
    let done = DispatchSemaphore(value: 0)
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            guard let window = content.windows.first(where: { $0.windowID == id }), let app = window.owningApplication else { throw fail("The EHR’s window isn’t on screen any more.") }
            let center = CGPoint(x: info.frame.midX, y: info.frame.midY)
            guard let display = content.displays.first(where: { $0.frame.contains(center) }) ?? content.displays.first else { throw fail("No display found.") }
            // Only Chrome's own windows are drawn: the EHR window plus its menus and pop-ups. Echo and every other app are left out.
            let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
            let region = info.frame.intersection(display.frame)
            let scale = min(2.0, maxEdge / Double(max(region.width, region.height)))
            let config = SCStreamConfiguration()
            config.sourceRect = CGRect(x: region.minX - display.frame.minX, y: region.minY - display.frame.minY, width: region.width, height: region.height)
            config.width = Int((Double(region.width) * scale).rounded())
            config.height = Int((Double(region.height) * scale).rounded())
            config.showsCursor = cursor
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            result = .success((image, region))
        } catch {
            result = .failure(error)
        }
        done.signal()
    }
    if done.wait(timeout: .now() + 15) == .timedOut { throw fail("The screenshot took too long.") }
    switch result {
    case .success(let value): return value
    case .failure(let error):
        if let f = error as? Failure { throw f }
        throw fail("Couldn’t capture the EHR’s window. Check that Echo is on under Screen Recording in System Settings › Privacy & Security.")
    }
}

func capture(_ args: [String: Any]) throws -> [String: Any] {
    guard let id = (args["window"] as? NSNumber)?.uint32Value else { throw fail("No window given.") }
    let (image, region) = try grab(id, maxEdge: (args["maxEdge"] as? Double) ?? 1280, cursor: true)
    let rep = NSBitmapImageRep(cgImage: image)
    guard let png = rep.representation(using: .png, properties: [:]) else { throw fail("Couldn’t encode the screenshot.") }
    return ["png": png.base64EncodedString(), "width": image.width, "height": image.height, "frame": frameJSON(region)]
}

// MARK: - Reading text

/// The text under a point, short enough to sit inside one button: the word there (or nearest, within a little),
/// with a neighbouring word added only when the word alone appears elsewhere on screen. (Vision's word boxes
/// run up to the next word, so spacing can't tell where one button ends; a word inside the button is enough
/// to click it again.) Nil when there's no text there, as on an icon.
func label(at point: CGPoint, in image: CGImage, region: CGRect) throws -> [String: Any]? {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    let toScreen = { (b: CGRect) in CGRect(x: region.minX + b.minX * region.width, y: region.minY + (1 - b.maxY) * region.height, width: b.width * region.width, height: b.height * region.height) }
    var lines: [String] = []
    var best: (distance: CGFloat, line: String, words: [(range: Range<String.Index>, box: CGRect)], index: Int)?
    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let line = candidate.string
        lines.append(line.lowercased())
        var words: [(range: Range<String.Index>, box: CGRect)] = []
        line.enumerateSubstrings(in: line.startIndex..<line.endIndex, options: .byWords) { _, range, _, _ in
            if let b = try? candidate.boundingBox(for: range)?.boundingBox { words.append((range, toScreen(b))) }
        }
        let distances = words.map { w -> CGFloat in
            hypot(max(w.box.minX - point.x, 0, point.x - w.box.maxX), max(w.box.minY - point.y, 0, point.y - w.box.maxY))
        }
        guard let i = distances.indices.min(by: { distances[$0] < distances[$1] }), distances[i] <= 24 else { continue }
        if let b = best, b.distance <= distances[i] { continue }
        best = (distances[i], line, words, i)
    }
    guard let best else { return nil }
    let count = { (text: String) -> Int in
        let t = text.lowercased()
        return lines.reduce(0) { total, line in total + line.components(separatedBy: t).count - 1 }
    }
    let w = best.words, i = best.index
    var options = [(i, i)]
    if i + 1 < w.count { options.append((i, i + 1)) }
    if i > 0 { options.append((i - 1, i)) }
    if i > 0 && i + 1 < w.count { options.append((i - 1, i + 1)) }
    let text = { (o: (Int, Int)) in String(best.line[w[o.0].range.lowerBound..<w[o.1].range.upperBound]) }
    let pick = options.first(where: { count(text($0)) == 1 }) ?? options[0]
    return ["label": text(pick), "box": frameJSON(w[i].box), "unique": count(text(pick)) == 1]
}

func squash(_ s: String) -> String {
    s.lowercased().replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
}

/// Finds visible text in the EHR window with the Mac's own text recognition (on this Mac, nothing sent anywhere).
/// Returns each place the text appears, as a box in screen points around just that text, best match first.
func findText(_ args: [String: Any]) throws -> [String: Any] {
    guard let id = (args["window"] as? NSNumber)?.uint32Value else { throw fail("No window given.") }
    let wanted = squash(args["text"] as? String ?? "")
    if wanted.isEmpty { throw fail("No text given.") }
    // Full resolution, no cursor over the words.
    let (image, region) = try grab(id, maxEdge: 6000, cursor: false)
    return ["found": try read(image, region: region, wanted: wanted)]
}

/// The text recognition itself, mapping Vision's boxes (0–1, origin bottom left) onto the window's frame in screen points.
func read(_ image: CGImage, region: CGRect, wanted: String) throws -> [[String: Any]] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    var found: [[String: Any]] = []
    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let line = candidate.string
        let lower = line.lowercased()
        // Find the words within the line, so a label in a row of buttons gets its own box.
        var box = observation.boundingBox
        var exact = false
        if let range = lower.range(of: wanted) ?? lower.range(of: wanted.replacingOccurrences(of: " ", with: "")) {
            if let sub = try? candidate.boundingBox(for: range) { box = sub.boundingBox }
            exact = squash(line) == wanted
        } else if squash(line).contains(wanted) {
            exact = squash(line) == wanted
        } else {
            continue
        }
        let rect = CGRect(x: region.minX + box.minX * region.width, y: region.minY + (1 - box.maxY) * region.height, width: box.width * region.width, height: box.height * region.height)
        found.append(["text": line, "exact": exact, "box": frameJSON(rect)])
    }
    return found
}

// MARK: - Keys

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
    "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
    "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,
    "return": 36, "enter": 36, "kp_enter": 76, "tab": 48, "space": 49, "backspace": 51, "delete": 51, "escape": 53, "esc": 53,
    "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "page_up": 116, "prior": 116, "pagedown": 121, "page_down": 121, "next": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111
]

let modifierFlags: [String: CGEventFlags] = [
    "cmd": .maskCommand, "command": .maskCommand, "super": .maskCommand, "meta": .maskCommand, "win": .maskCommand,
    "shift": .maskShift, "ctrl": .maskControl, "control": .maskControl, "alt": .maskAlternate, "option": .maskAlternate, "opt": .maskAlternate,
    "fn": .maskSecondaryFn
]

let modifierKeyCodes: [String: CGKeyCode] = ["cmd": 55, "command": 55, "super": 55, "meta": 55, "win": 55, "shift": 56, "ctrl": 59, "control": 59, "alt": 58, "option": 58, "opt": 58, "fn": 63]

/** "cmd+shift+t" → (flags, key code of t). A combination of modifiers alone presses the last one. */
func parseCombo(_ combo: String) throws -> (CGEventFlags, CGKeyCode) {
    let parts = combo.split(separator: "+", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
    var flags: CGEventFlags = []
    var key: CGKeyCode?
    for (i, part) in parts.enumerated() {
        let last = i == parts.count - 1
        if !last {
            guard let flag = modifierFlags[part] else { throw fail("Unknown modifier “\(part)”.") }
            flags.insert(flag)
        } else if let code = keyCodes[part] ?? keyCodes[part.replacingOccurrences(of: "arrow", with: "").replacingOccurrences(of: "_", with: "")] {
            key = code
        } else if let code = modifierKeyCodes[part] {
            key = code
        } else {
            throw fail("Unknown key “\(part)”.")
        }
    }
    guard let key else { throw fail("No key in “\(combo)”.") }
    return (flags, key)
}

let source = CGEventSource(stateID: .hidSystemState)

func post(_ event: CGEvent?) { event?.post(tap: .cghidEventTap) }

func pressKey(_ combo: String, repeat count: Int) throws {
    let (flags, key) = try parseCombo(combo)
    for _ in 0..<max(1, min(count, 100)) {
        let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true)
        down?.flags = flags
        post(down)
        let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false)
        up?.flags = flags
        post(up)
        usleep(12_000)
    }
}

func holdKey(_ combo: String, seconds: Double) throws {
    let (flags, key) = try parseCombo(combo)
    let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true)
    down?.flags = flags
    post(down)
    usleep(useconds_t(max(0, min(seconds, 30)) * 1_000_000))
    let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false)
    up?.flags = flags
    post(up)
}

func typeText(_ text: String) {
    let units = Array(text.utf16)
    var i = 0
    while i < units.count {
        let chunk = Array(units[i..<min(i + 16, units.count)])
        for keyDown in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: keyDown)
            chunk.withUnsafeBufferPointer { event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress) }
            post(event)
        }
        usleep(15_000)
        i += 16
    }
}

// MARK: - Mouse

func point(_ args: [String: Any], _ key: String = "point") throws -> CGPoint {
    guard let p = args[key] as? [String: Any], let x = p["x"] as? Double, let y = p["y"] as? Double else { throw fail("No position given.") }
    return CGPoint(x: x, y: y)
}

func flags(_ args: [String: Any]) throws -> CGEventFlags {
    guard let text = args["modifiers"] as? String, !text.isEmpty else { return [] }
    var flags: CGEventFlags = []
    for part in text.split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces).lowercased() }) {
        guard let flag = modifierFlags[part] else { throw fail("Unknown modifier “\(part)”.") }
        flags.insert(flag)
    }
    return flags
}

func window(_ args: [String: Any]) throws -> CGWindowID {
    guard let id = (args["window"] as? NSNumber)?.uint32Value else { throw fail("No window given.") }
    return id
}

func mouseLocation() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

func move(to p: CGPoint) {
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    usleep(20_000)
}

func click(at p: CGPoint, button: String, count: Int, flags: CGEventFlags) {
    let (downType, upType, mouseButton): (CGEventType, CGEventType, CGMouseButton) = switch button {
    case "right": (.rightMouseDown, .rightMouseUp, .right)
    case "middle": (.otherMouseDown, .otherMouseUp, .center)
    default: (.leftMouseDown, .leftMouseUp, .left)
    }
    move(to: p)
    for n in 1...max(1, min(count, 3)) {
        for type in [downType, upType] {
            let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: mouseButton)
            event?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
            event?.flags = flags
            post(event)
            usleep(8_000)
        }
        usleep(40_000)
    }
}

func drag(from a: CGPoint, to b: CGPoint, flags: CGEventFlags) {
    move(to: a)
    let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: a, mouseButton: .left)
    down?.flags = flags
    post(down)
    let steps = 12
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
        let event = CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)
        event?.flags = flags
        post(event)
        usleep(15_000)
    }
    let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: b, mouseButton: .left)
    up?.flags = flags
    post(up)
}

func scroll(at p: CGPoint, dx: Int32, dy: Int32, flags: CGEventFlags) {
    move(to: p)
    for _ in 0..<max(abs(dx), abs(dy)) {
        let event = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy == 0 ? 0 : (dy > 0 ? -3 : 3), wheel2: dx == 0 ? 0 : (dx > 0 ? -3 : 3), wheel3: 0)
        event?.flags = flags
        post(event)
        usleep(20_000)
    }
}

// MARK: - Commands

func handle(_ args: [String: Any]) throws -> [String: Any] {
    switch args["cmd"] as? String ?? "" {
    case "permissions":
        if args["prompt"] as? Bool == true {
            if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        }
        return ["screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]
    case "find":
        return try findWindow(args)
    case "frame":
        guard let info = windowInfo(try window(args)) else { throw fail("The EHR’s window isn’t on screen any more.") }
        return ["frame": frameJSON(info.frame)]
    case "capture":
        return try capture(args)
    case "findText":
        return try findText(args)
    case "labelAt":
        let id = try window(args)
        let (image, region) = try grab(id, maxEdge: 6000, cursor: false)
        return try label(at: try point(args), in: image, region: region) ?? [:]
    case "labelAtInFile":
        guard let path = args["path"] as? String, let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw fail("Couldn’t read that image.") }
        return try label(at: try point(args), in: image, region: CGRect(x: 0, y: 0, width: image.width, height: image.height)) ?? [:]
    case "findTextInFile":
        // For checking the box maths against a known image in development; reads no screen.
        guard let path = args["path"] as? String, let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw fail("Couldn’t read that image.") }
        let region = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        return ["found": try read(image, region: region, wanted: squash(args["text"] as? String ?? ""))]
    case "mouse":
        let p = mouseLocation()
        return ["x": Double(p.x), "y": Double(p.y)]
    case "move":
        let p = try point(args)
        try checkTarget(p, window: try window(args))
        move(to: p)
    case "click":
        // A click on a window of an app that isn't in front only brings the app forward (the page never sees it), so
        // Chrome comes to the front first, as it does for keys.
        let p = try point(args)
        try ensureFront(try window(args))
        try checkTarget(p, window: try window(args))
        click(at: p, button: args["button"] as? String ?? "left", count: args["count"] as? Int ?? 1, flags: try flags(args))
    case "button":
        // Press or release the left button where the pointer is.
        let p = mouseLocation()
        try checkTarget(p, window: try window(args))
        let down = args["down"] as? Bool ?? true
        if down { try ensureFront(try window(args)) }
        post(CGEvent(mouseEventSource: source, mouseType: down ? .leftMouseDown : .leftMouseUp, mouseCursorPosition: p, mouseButton: .left))
    case "drag":
        let a = try point(args, "from"), b = try point(args, "to")
        let id = try window(args)
        try ensureFront(id)
        try checkTarget(a, window: id)
        try checkTarget(b, window: id)
        drag(from: a, to: b, flags: try flags(args))
    case "scroll":
        let p = try point(args)
        try checkTarget(p, window: try window(args))
        scroll(at: p, dx: Int32(args["dx"] as? Int ?? 0), dy: Int32(args["dy"] as? Int ?? 0), flags: try flags(args))
    case "key":
        try ensureFront(try window(args))
        try pressKey(args["combo"] as? String ?? "", repeat: args["repeat"] as? Int ?? 1)
    case "hold":
        try ensureFront(try window(args))
        try holdKey(args["combo"] as? String ?? "", seconds: args["seconds"] as? Double ?? 0.5)
    case "type":
        try ensureFront(try window(args))
        typeText(args["text"] as? String ?? "")
    default:
        throw fail("Unknown command.")
    }
    return [:]
}

while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8), let args = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
    let id = args["id"] ?? 0
    do {
        var result = try handle(args)
        result["id"] = id
        result["ok"] = true
        reply(result)
    } catch let f as Failure {
        reply(["id": id, "ok": false, "error": f.message])
    } catch {
        reply(["id": id, "ok": false, "error": "Something went wrong."])
    }
}
