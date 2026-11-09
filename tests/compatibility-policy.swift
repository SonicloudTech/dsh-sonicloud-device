import Foundation

@main struct CompatibilityTests {
    static func main() {
        func context(pid: Int32 = 42, bundle: String = "dev.zed.Zed", title: String? = "Untitled", document: String? = nil, activity: [UInt32] = [1, 2, 3, 4, 5, 6]) -> CompatibilityContext {
            CompatibilityContext(pid: pid, bundle: bundle, title: title, document: document, activity: activity)
        }
        let original = context()
        precondition(CompatibilityPolicy.canPaste(original, context(), sameWindow: true))
        precondition(!CompatibilityPolicy.canPaste(original, context(), sameWindow: false))
        for change in [context(pid: 43), context(bundle: "com.apple.Terminal"), context(title: "Another tab"), context(document: "file:///changed.txt")] {
            precondition(!CompatibilityPolicy.canPaste(original, change, sameWindow: true))
        }
        for index in 0..<6 {
            var counts = original.activity; counts[index] += 1
            precondition(!CompatibilityPolicy.canPaste(original, context(activity: counts), sameWindow: true))
        }
        let otherApp = context(bundle: "other.editor")
        precondition(CompatibilityPolicy.canPaste(otherApp, otherApp, sameWindow: true))
        for bundle in ["com.apple.TextEdit", "com.google.Chrome", "com.deepseek.dsh"] {
            let target = context(bundle: bundle)
            precondition(CompatibilityPolicy.canPaste(target, target, sameWindow: true))
        }
        precondition(!CompatibilityPolicy.canPaste(context(pid: 0), context(pid: 0), sameWindow: true))
        precondition(CompatibilityPolicy.canRestoreClipboard(written: 12, current: 12))
        precondition(!CompatibilityPolicy.canRestoreClipboard(written: 12, current: 13))
        print("Default paste guards passed")
    }
}
