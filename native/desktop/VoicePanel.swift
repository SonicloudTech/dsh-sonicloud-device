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
        setAccessibilityElement(true); setAccessibilityLabel("语音处理中")
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
final class VoiceUI: NSObject {
    let panel = Panel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    let text = NSTextField(labelWithString: "")
    let waveform = WaveformView(frame: .zero)
    let closeButton = NSButton(title: "", target: nil, action: nil)
    let copyButton = NSButton(title: "复制结果", target: nil, action: nil)
    var session = "", preview = "", phase = "connecting", message = ""
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
        text.lineBreakMode = .byTruncatingHead
        text.maximumNumberOfLines = 1
        text.cell?.usesSingleLineMode = true
        text.cell?.wraps = false
        text.cell?.isScrollable = false
        text.setAccessibilityLabel("语音识别结果")
        for view in [waveform, text, closeButton, copyButton] { content.addSubview(view) }
        closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "取消")?.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 14, weight: .medium))
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
        let width = min(720, max(280, frame.width - 48)), height: CGFloat = 48
        panel.setFrame(NSRect(x: frame.midX - width / 2, y: frame.minY + 24, width: width, height: height), display: true)
        waveform.frame = NSRect(x: 20, y: (height - 26) / 2, width: 23, height: 26)
        closeButton.frame = NSRect(x: width - 44, y: (height - 28) / 2, width: 28, height: 28)
        copyButton.frame = NSRect(x: width - 146, y: (height - 32) / 2, width: 96, height: 32)
        let left: CGFloat = active ? 54 : 22
        let right = copyButton.isHidden ? closeButton.frame.minX : copyButton.frame.minX
        let textHeight = ceil(text.intrinsicContentSize.height)
        text.frame = NSRect(x: left, y: (height - textHeight) / 2, width: max(0, right - left - 12), height: textHeight)
        panel.contentView?.needsDisplay = true
        panel.invalidateShadow()
    }
    func render() {
        waveform.isHidden = !active
        waveform.animate(active)
        closeButton.setAccessibilityLabel(active ? "取消" : "关闭")
        closeButton.toolTip = active ? "取消" : "关闭"
        copyButton.isHidden = active || preview.isEmpty
        let status = message.isEmpty ? (["finishing": "正在整理…", "translating": "正在翻译…"][phase] ?? "") : message
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
        copyButton.title = "已复制"
    }
    func finishInsertion(_ inserted: Bool, changed: Bool) {
        insertion = nil; active = false; resultPending = false
        if inserted { preview = ""; message = ""; hide() }
        else {
            message = !AXIsProcessTrusted() ? "请授权辅助功能以回填；可复制结果"
                : changed ? "输入目标已变化或不支持写入，可复制结果" : "此输入框不支持自动回填，可复制结果"
            render()
        }
    }
    func shutdown() {
        ClipboardInsertion.restoreClipboard?(); ClipboardInsertion.restoreClipboard = nil
        NSApplication.shared.terminate(nil)
    }
    func handle(_ command: [String: Any]) {
        let name = command["command"] as? String ?? ""
        let incoming = command["sessionId"] as? String ?? ""
        var success = true
        let inserted = false
        if name == "begin" {
            session = incoming; preview = ""; message = ""; phase = "connecting"; active = true
            screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) })
            insertion = ["speechSearch", "ai_input"].contains(command["action"] as? String ?? "") ? nil : ClipboardInsertion()
            resultPending = false
            copyButton.title = "复制结果"; render()
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
            case "failed": active = false; insertion = nil; message = command["message"] as? String ?? "语音处理失败"; render()
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
