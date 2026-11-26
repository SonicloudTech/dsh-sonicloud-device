import AppKit
import ApplicationServices
import QuartzCore

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func focus() -> AXUIElement? {
    guard let value = attribute(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func selection(_ element: AXUIElement) -> CFRange? {
    guard let raw = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let value = raw as! AXValue
    var range = CFRange()
    return AXValueGetType(value) == .cfRange && AXValueGetValue(value, .cfRange, &range) ? range : nil
}
// Capture readable text/selection when available; pasting does not require AX write support.
final class InputSnapshot {
    let element: AXUIElement?
    let value: String?
    let range: CFRange?
    init?() {
        element = focus()
        if let target = element {
            guard (attribute(target, kAXSubroleAttribute) as? String) != "AXSecureTextField",
                  (attribute(target, kAXEnabledAttribute) as? Bool) != false else { return nil }
            value = attribute(target, kAXValueAttribute) as? String
            range = selection(target)
        } else { value = nil; range = nil }
    }
    func unchanged() -> Bool {
        let current = focus()
        if let target = element {
            guard let current = current, CFEqual(current, target),
                  (attribute(current, kAXSubroleAttribute) as? String) != "AXSecureTextField",
                  (attribute(current, kAXEnabledAttribute) as? Bool) != false else { return false }
            if let value = value, (attribute(current, kAXValueAttribute) as? String) != value { return false }
            if let range = range {
                guard let selected = selection(current), selected.location == range.location, selected.length == range.length else { return false }
            }
        } else if current != nil { return false }
        return true
    }
}
// Default insertion uses guarded system paste. Event counters contain no keyboard text.
final class ClipboardInsertion {
    static var restoreClipboard: (() -> Void)?
    static var transaction: UUID?
    let context: CompatibilityContext
    let window: AXUIElement
    let input: InputSnapshot
    static func current() -> (CompatibilityContext, AXUIElement)? {
        guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier,
              let raw = attribute(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedWindowAttribute),
              CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        let window = raw as! AXUIElement
        guard (attribute(window, kAXMinimizedAttribute) as? Bool) != true else { return nil }
        let events: [CGEventType] = [.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
        let context = CompatibilityContext(pid: app.processIdentifier, bundle: app.bundleIdentifier ?? "",
            title: attribute(window, kAXTitleAttribute) as? String,
            document: attribute(window, kAXDocumentAttribute) as? String,
            activity: events.map { CGEventSource.counterForEventType(.combinedSessionState, eventType: $0) })
        return (context, window)
    }
    init?() {
        guard let (context, window) = Self.current(), let input = InputSnapshot() else { return nil }
        self.context = context; self.window = window; self.input = input
    }
    func unchanged() -> Bool {
        guard let (now, focusedWindow) = Self.current() else { return false }
        return input.unchanged() && CompatibilityPolicy.canPaste(context, now, sameWindow: CFEqual(window, focusedWindow))
    }
    func insert(_ text: String, completion: @escaping (Bool) -> Void) {
        guard unchanged(), let source = CGEventSource(stateID: .privateState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else { completion(false); return }
        Self.restoreClipboard?(); Self.restoreClipboard = nil
        let transaction = UUID(); Self.transaction = transaction
        let pasteboard = NSPasteboard.general
        let originalChange = pasteboard.changeCount
        var originals: [NSPasteboardItem] = []
        for item in pasteboard.pasteboardItems ?? [] {
            let saved = NSPasteboardItem()
            for type in item.types {
                guard let data = item.data(forType: type) else { completion(false); return }
                saved.setData(data, forType: type)
            }
            originals.append(saved)
        }
        // Recheck after copying promised clipboard data, which may take time.
        guard unchanged(), pasteboard.changeCount == originalChange else { completion(false); return }
        let payload = NSPasteboardItem()
        payload.setString(text, forType: .string)
        payload.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
        pasteboard.clearContents()
        guard pasteboard.writeObjects([payload]) else {
            pasteboard.clearContents(); if !originals.isEmpty { pasteboard.writeObjects(originals) }
            completion(false); return
        }
        let writtenChange = pasteboard.changeCount
        down.flags = .maskCommand; up.flags = .maskCommand
        down.postToPid(context.pid); up.postToPid(context.pid)
        // Keep the payload until the target has handled Paste. Restore only our own write;
        // never overwrite something the user or another application copied in the meantime.
        var restored = false
        let restore = {
            guard !restored else { return }
            restored = true
            if CompatibilityPolicy.canRestoreClipboard(written: writtenChange, current: pasteboard.changeCount) {
                pasteboard.clearContents(); if !originals.isEmpty { pasteboard.writeObjects(originals) }
            }
        }
        Self.restoreClipboard = restore
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            restore()
            if Self.transaction == transaction { Self.restoreClipboard = nil; Self.transaction = nil }
            completion(true)
        }
    }
}
// Draw only the capsule; no rectangular visual-effect backing is allowed outside it.
final class CapsuleView: NSView {
    override var isOpaque: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        let outline = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5),
            xRadius: bounds.height / 2, yRadius: bounds.height / 2)
        NSColor.windowBackgroundColor.withAlphaComponent(0.97).setFill(); outline.fill()
        NSColor(calibratedWhite: 0.97, alpha: 1).setStroke(); outline.lineWidth = 1; outline.stroke()
    }
}
final class WaveformView: NSView {
    private let bars = (0..<5).map { _ in CALayer() }
    private var running = false
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        setAccessibilityElement(true); setAccessibilityLabel("Processing speech")
        for bar in bars { bar.backgroundColor = NSColor.systemGreen.cgColor; bar.cornerRadius = 1.5; layer?.addSublayer(bar) }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func layout() {
        super.layout()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for (index, bar) in bars.enumerated() {
            let height: CGFloat = [10, 18, 26, 18, 10][index]
            bar.frame = NSRect(x: CGFloat(index) * 5, y: (bounds.height - height) / 2, width: 3, height: height)
        }
        CATransaction.commit()
    }
    func animate(_ enabled: Bool) {
        let enabled = enabled && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        guard enabled != running else { return }
        running = enabled
        for (index, bar) in bars.enumerated() {
            bar.removeAnimation(forKey: "voice-wave")
            if enabled {
                let animation = CABasicAnimation(keyPath: "transform.scale.y")
                animation.fromValue = 0.3; animation.toValue = 1
                animation.duration = 0.32 + Double(index % 3) * 0.07
                animation.beginTime = CACurrentMediaTime() - Double(index) * 0.12
                animation.autoreverses = true; animation.repeatCount = .infinity
                animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                bar.add(animation, forKey: "voice-wave")
            }
        }
    }
}
final class Panel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
// 文案由插件通过私有 IPC 下发；结果文本始终原样显示。
final class VoiceLocale {
    static var dictionary: [String: String] = [:]
    static func encode(_ key: String, _ params: [String: Any] = [:]) -> String {
        let data = try! JSONSerialization.data(withJSONObject: ["key": key, "params": params], options: [.sortedKeys])
        return "sonicloud:" + String(data: data, encoding: .utf8)!
    }
    static func text(_ value: String, _ depth: Int = 0) -> String {
        if value.isEmpty { return "" }
        if let text = dictionary[value] { return text }
        if depth < 5 && value.hasPrefix("sonicloud:"), let data = String(value.dropFirst(10)).data(using: .utf8),
           let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let key = object["key"] as? String {
            var result = dictionary[key] ?? dictionary["error.generic"] ?? "Operation failed. Please retry."
            for (name, param) in object["params"] as? [String: Any] ?? [:] {
                let raw = String(describing: param)
                let translated = raw.hasPrefix("sonicloud:") || dictionary[raw] != nil ? text(raw, depth + 1) : raw
                result = result.replacingOccurrences(of: "{" + name + "}", with: translated)
            }
            return result
        }
        return dictionary["error.generic"] ?? "Operation failed. Please retry."
    }
}
final class VoiceUI: NSObject {
    let panel = Panel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    let text = NSTextField(labelWithString: "")
    let waveform = WaveformView(frame: .zero)
    let closeButton = NSButton(title: "", target: nil, action: nil)
    let copyButton = NSButton(title: "Copy result", target: nil, action: nil)
    var session = "", preview = "", phase = "connecting", message = ""
    var copyKey = "panel.copy"
    var active = false
    var insertion: ClipboardInsertion?
    var resultPending = false
    var screen: NSScreen?
    override init() {
        super.init()
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.hidesOnDeactivate = false
        panel.isFloatingPanel = true
        panel.isReleasedWhenClosed = false
        panel.hasShadow = true
        panel.backgroundColor = .clear
        panel.isOpaque = false
        let content = CapsuleView()
        panel.contentView = content
        text.font = .systemFont(ofSize: 15)
        text.lineBreakMode = .byWordWrapping
        text.maximumNumberOfLines = 0
        text.cell?.usesSingleLineMode = false
        text.cell?.wraps = true
        text.cell?.isScrollable = false
        text.setAccessibilityLabel("Speech recognition result")
        for view in [waveform, text, closeButton, copyButton] { content.addSubview(view) }
        closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Cancel")?.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 14, weight: .medium))
        closeButton.imagePosition = .imageOnly
        closeButton.isBordered = false
        closeButton.contentTintColor = .secondaryLabelColor
        closeButton.target = self; closeButton.action = #selector(close)
        copyButton.target = self; copyButton.action = #selector(copyResult)
        copyButton.isHidden = true
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in self?.position() }
    }
    func position() {
        let display = NSScreen.screens.first(where: { $0 == screen }) ?? NSScreen.main ?? NSScreen.screens.first
        guard let frame = display?.visibleFrame else { return }
        let width = min(720, max(280, frame.width - 48))
        let copyWidth = min(width / 2, max(96, copyButton.intrinsicContentSize.width + 16))
        let available = max(100, width - (copyButton.isHidden ? 110 : copyWidth + 116))
        let bounds = (text.stringValue as NSString).boundingRect(with: NSSize(width: available, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: text.font!])
        let height: CGFloat = min(frame.height / 2, max(48, ceil(bounds.height) + 24))
        panel.setFrame(NSRect(x: frame.midX - width / 2, y: frame.minY + 24, width: width, height: height), display: true)
        waveform.frame = NSRect(x: 20, y: (height - 26) / 2, width: 23, height: 26)
        closeButton.frame = NSRect(x: width - 44, y: (height - 28) / 2, width: 28, height: 28)
        copyButton.frame = NSRect(x: width - 50 - copyWidth, y: (height - 32) / 2, width: copyWidth, height: 32)
        let left: CGFloat = active ? 54 : 22
        let right = copyButton.isHidden ? closeButton.frame.minX : copyButton.frame.minX
        let textHeight = height - 24
        text.frame = NSRect(x: left, y: (height - textHeight) / 2, width: max(0, right - left - 12), height: textHeight)
        panel.contentView?.needsDisplay = true
        panel.invalidateShadow()
    }
    func render() {
        waveform.isHidden = !active
        waveform.animate(active)
        panel.setAccessibilityLabel(VoiceLocale.text("panel.title"))
        text.setAccessibilityLabel(VoiceLocale.text("panel.result"))
        waveform.setAccessibilityLabel(VoiceLocale.text("panel.processing"))
        copyButton.title = VoiceLocale.text(copyKey)
        closeButton.setAccessibilityLabel(VoiceLocale.text(active ? "panel.cancel" : "panel.close"))
        closeButton.toolTip = VoiceLocale.text(active ? "panel.cancel" : "panel.close")
        copyButton.isHidden = active || preview.isEmpty
        let status = message.isEmpty ? VoiceLocale.text(["finishing": "panel.finishing", "translating": "panel.translating"][phase] ?? "") : VoiceLocale.text(message)
        let fullText = [status, preview].filter { !$0.isEmpty }.joined(separator: " ")
        text.stringValue = fullText.components(separatedBy: .newlines).joined(separator: " ").replacingOccurrences(of: "\t", with: " ")
        text.toolTip = fullText
        position(); panel.orderFrontRegardless()
    }
    func hide() { waveform.animate(false); panel.orderOut(nil) }
    @objc func close() {
        if active { emit(["event": "cancel", "sessionId": session]) }
        active = false; insertion = nil; preview = ""; message = ""; hide()
    }
    @objc func copyResult() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(preview, forType: .string)
        copyKey = "panel.copied"; render()
    }
    func finishInsertion(_ inserted: Bool, changed: Bool) {
        insertion = nil; active = false; resultPending = false
        if inserted { preview = ""; message = ""; hide() }
        else {
            message = !AXIsProcessTrusted() ? "panel.permission"
                : changed ? "panel.targetChanged" : "panel.targetChanged"
            render()
        }
    }
    func shutdown() {
        ClipboardInsertion.restoreClipboard?(); ClipboardInsertion.restoreClipboard = nil
        NSApplication.shared.terminate(nil)
    }
    func handle(_ command: [String: Any]) {
        let name = command["command"] as? String ?? ""
        if name == "locale" {
            if let dictionary = command["dictionary"] as? [String: String] { VoiceLocale.dictionary = dictionary }
            if panel.isVisible { render() }
            return
        }
        if name == "permissions" {
            let action = command["action"] as? String ?? "check"
            guard ["check", "refresh", "accessibility"].contains(action) else {
                if let id = command["id"] { emit(["id": id, "ok": false, "message": VoiceLocale.encode("error.permission")]) }
                return
            }
            if action == "accessibility" {
                guard !active && !resultPending else {
                    if let id = command["id"] { emit(["id": id, "ok": false, "message": VoiceLocale.encode("error.busy")]) }
                    return
                }
                if !AXIsProcessTrusted() {
                    hide()
                    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                    _ = AXIsProcessTrustedWithOptions(options)
                    if let settings = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
                        NSWorkspace.shared.open(settings)
                    }
                }
            }
            let helperApp = Bundle.main.bundlePath.hasSuffix(".app") ? Bundle.main.bundlePath
                : URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
            if let id = command["id"] {
                emit(["id": id, "ok": true, "value": ["supported": true, "accessibility": AXIsProcessTrusted(), "helperApp": helperApp]])
            }
            return
        }
        let incoming = command["sessionId"] as? String ?? ""
        var success = true
        let inserted = false
        if name == "begin" {
            session = incoming; preview = ""; message = ""; phase = "connecting"; active = true
            screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) })
            insertion = ["speechSearch", "ai_input"].contains(command["action"] as? String ?? "") ? nil : ClipboardInsertion()
            resultPending = false
            copyKey = "panel.copy"; render()
        } else if !incoming.isEmpty && incoming != session { success = false }
        else if name == "result" && active && !resultPending {
            preview = command["text"] as? String ?? ""
            if let compatibility = insertion {
                resultPending = true
                compatibility.insert(preview) { didInsert in
                    if self.session == incoming && self.active {
                        self.finishInsertion(didInsert, changed: true)
                    }
                    if let id = command["id"] { emit(["id": id, "ok": true, "value": didInsert]) }
                }
                return
            }
            finishInsertion(inserted, changed: insertion != nil)
        } else if name == "event" {
            switch command["type"] as? String {
            case "preview": if active { preview = command["text"] as? String ?? ""; render() }
            case "phase": if active { phase = command["phase"] as? String ?? phase; render() }
            case "failed": active = false; insertion = nil; message = command["message"] as? String ?? "error.generic"; render()
            case "notice": message = command["message"] as? String ?? ""; render()
            case "finished", "cancelled": active = false; insertion = nil; preview = ""; message = ""; hide()
            default: break
            }
        } else { success = false }
        if let id = command["id"] { emit(["id": id, "ok": success, "value": inserted]) }
    }
}
@main
struct VoiceApplication {
    static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let ui = VoiceUI()
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine() {
                guard line.utf8.count <= 300000, let data = line.data(using: .utf8), let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
                DispatchQueue.main.async { ui.handle(command) }
            }
            DispatchQueue.main.async { ui.shutdown() }
        }
        application.run()
    }
}
