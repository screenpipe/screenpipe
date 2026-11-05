// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Synthetic desktop for screenshot_redaction_probe's title-churn mode.
// Run only in a disposable VM. Write allowed, excluded, blocked or static to
// the control file. Only titles change; geometry, identity and order stay fixed.
import Cocoa

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let control = CommandLine.arguments[1]
var windows: [(NSWindow, NSWindow)] = []
for screen in NSScreen.screens {
    func window(_ rect: NSRect, _ title: String, _ color: NSColor) -> NSWindow {
        let w = NSWindow(contentRect: rect, styleMask: [.titled], backing: .buffered, defer: false)
        w.title = title
        w.backgroundColor = color
        w.isReleasedWhenClosed = false
        w.orderFrontRegardless()
        return w
    }
    let origin = screen.frame.origin
    let blocked = window(NSRect(x: origin.x + 30, y: origin.y + 50, width: 300, height: 250),
                         "WhatsApp private 0", .magenta)
    let allowed = window(NSRect(x: origin.x + 400, y: origin.y + 50, width: 300, height: 250),
                         "Public document 0", .cyan)
    windows.append((allowed, blocked))
}
app.activate(ignoringOtherApps: true)
var sequence = 0
let timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in
    sequence += 1
    let mode = (try? String(contentsOfFile: control, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "static"
    for (allowed, blocked) in windows {
        switch mode {
        case "allowed":
            allowed.title = "Public document \(sequence)"
        case "excluded":
            blocked.title = "WhatsApp private \(sequence)"
        case "blocked":
            allowed.title = "Zee5 private \(sequence)"
        default:
            allowed.title = "Public document stable"
            blocked.title = "WhatsApp private stable"
        }
    }
}
print("ready screens=\(windows.count)")
fflush(stdout)
app.run()
