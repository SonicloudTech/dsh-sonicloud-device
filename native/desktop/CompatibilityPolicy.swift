import Foundation

struct CompatibilityContext: Equatable {
    let pid: Int32
    let bundle: String
    let title: String?
    let document: String?
    let activity: [UInt32]
}

enum CompatibilityPolicy {
    // All foreground applications use the same target and input-activity guards.
    static func canPaste(_ captured: CompatibilityContext, _ current: CompatibilityContext, sameWindow: Bool) -> Bool {
        return captured.pid > 0 && sameWindow && captured == current
    }
    static func canRestoreClipboard(written: Int, current: Int) -> Bool { written == current }
}
