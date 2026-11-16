// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import AppKit
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import ImageIO
import UniformTypeIdentifiers
import Darwin

func now() -> Double { CMClockGetTime(CMClockGetHostTimeClock()).seconds }
func cpu() -> Double {
    var r = rusage(); getrusage(RUSAGE_SELF, &r)
    return Double(r.ru_utime.tv_sec + r.ru_stime.tv_sec) + Double(r.ru_utime.tv_usec + r.ru_stime.tv_usec) / 1e6
}
func emit(_ data: [String: Any]) {
    let bytes = try! JSONSerialization.data(withJSONObject: data, options: [.sortedKeys])
    print(String(data: bytes, encoding: .utf8)!); fflush(stdout)
}
final class Frames: NSObject, SCStreamOutput, @unchecked Sendable {
    let lock = NSLock()
    var pending: CheckedContinuation<CMSampleBuffer, Never>?
    var selection: CheckedContinuation<CMSampleBuffer?, Never>?
    var idle = false
    var latest: CMSampleBuffer?
    var latestReceived = 0.0
    var count = 0
    var callbacks = 0
    var idleCount = 0
    var validIdleCount = 0
    var lastIdlePTS = 0.0
    var first: Double?
    func stream(_ stream: SCStream, didOutputSampleBuffer b: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        let received = now()
        let list = CMSampleBufferGetSampleAttachmentsArray(b, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]]
        let raw = list?.first?[.status] as? Int
        lock.lock(); callbacks += 1
        if raw == SCFrameStatus.idle.rawValue {
            idle = true
            let selected = selection; selection = nil; selected?.resume(returning: nil)
            idleCount += 1
            if b.presentationTimeStamp.isValid && b.presentationTimeStamp.seconds.isFinite {
                validIdleCount += 1; lastIdlePTS = b.presentationTimeStamp.seconds
            }
        }
        guard b.isValid, b.imageBuffer != nil, raw == SCFrameStatus.complete.rawValue else { lock.unlock(); return }
        idle = false
        let selected = selection; selection = nil; selected?.resume(returning: b)
        latest = b; latestReceived = received; count += 1; if first == nil { first = now() }; let p = pending; pending = nil; lock.unlock()
        p?.resume(returning: b)
    }
    func diagnostics() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["callbacks":callbacks,"idle_callbacks":idleCount,"valid_idle_pts":validIdleCount,"last_idle_pts":lastIdlePTS,"native_now":now()]
    }
    func countNow() -> Int { lock.lock(); defer { lock.unlock() }; return count }
    func cached() -> CMSampleBuffer {
        lock.lock(); defer { lock.unlock() }; return latest!
    }
    func available(after boundary: Double) -> CMSampleBuffer? {
        lock.lock(); defer { lock.unlock() }
        guard let sample = latest, latestReceived >= boundary,
              sample.presentationTimeStamp.isValid, sample.presentationTimeStamp.seconds >= boundary else { return nil }
        return sample
    }
    func observed(after boundary: Double) async -> CMSampleBuffer? {
        while true {
            let sample: CMSampleBuffer? = await withCheckedContinuation { c in
                lock.lock()
                if let b = latest, b.presentationTimeStamp.isValid && b.presentationTimeStamp.seconds >= boundary {
                    lock.unlock(); c.resume(returning: b)
                } else if idle { lock.unlock(); c.resume(returning: nil) }
                else { precondition(selection == nil); selection = c; lock.unlock() }
            }
            guard let sample else { return nil }
            if sample.presentationTimeStamp.isValid && sample.presentationTimeStamp.seconds >= boundary { return sample }
        }
    }
    func next() async -> CMSampleBuffer {
        await withCheckedContinuation { c in
            lock.lock(); precondition(pending == nil); pending = c; lock.unlock()
        }
    }
}
func encode(_ buffer: CMSampleBuffer) throws -> Int {
    guard let pb = buffer.imageBuffer else { throw NSError(domain: "missing pixels", code: 1) }
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    let width = CVPixelBufferGetWidth(pb), height = CVPixelBufferGetHeight(pb)
    let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb), width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    let image = ctx.makeImage()!
    let out = NSMutableData()
    let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw NSError(domain: "JPEG", code: 1) }
    return out.length
}
final class Scene: NSView {
    var tick = 0
    override func draw(_ rect: NSRect) {
        NSColor(calibratedRed: 0.10, green: 0.13, blue: 0.19, alpha: 1).setFill(); bounds.fill()
        for row in 0..<18 {
            let x = CGFloat((tick * (row + 2)) % 700)
            NSColor(calibratedHue: CGFloat(row) / 18, saturation: 0.65, brightness: 0.85, alpha: 1).setFill()
            NSBezierPath(rect: NSRect(x: x, y: CGFloat(row * 30), width: 260, height: 18)).fill()
        }
        ("Screen capture benchmark — synthetic motion\nNo screenshots are retained." as NSString).draw(at: NSPoint(x: 20, y: 570), withAttributes: [.foregroundColor: NSColor.white, .font: NSFont.systemFont(ofSize: 19)])
    }
}
let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "screenshot"
let rate = args.count > 2 ? Double(args[2])! : 4
let duration = args.count > 3 ? Double(args[3])! : 20
let dynamic = args.count > 4 ? args[4] == "dynamic" : true
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 1000, height: 650), styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Capture comparison (temporary)"
let scene = Scene(frame: NSRect(x: 0, y: 0, width: 1000, height: 650)); window.contentView = scene
window.orderFrontRegardless()
let timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { _ in
    if dynamic { scene.tick += 1; scene.needsDisplay = true }
}
Task.detached {
    do {
        guard CGPreflightScreenCaptureAccess() else { throw NSError(domain: "screen permission unavailable", code: 1) }
        let en = now()
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else { throw NSError(domain: "missing main display", code: 1) }
        let filter = SCContentFilter(display: display, including: content.windows.filter { $0.isOnScreen })
        let cfg = SCStreamConfiguration()
        let displayMode = CGDisplayCopyDisplayMode(display.displayID)!
        cfg.width = displayMode.pixelWidth; cfg.height = displayMode.pixelHeight
        cfg.pixelFormat = kCVPixelFormatType_32BGRA; cfg.showsCursor = false; cfg.queueDepth = 3
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: args.count > 6 ? Int32(args[6])! : Int32(mode.contains("24") ? 24 : mode.contains("30") ? 30 : mode.contains("60") ? 60 : rate))
        let snapshotCfg = SCStreamConfiguration()
        snapshotCfg.width = cfg.width; snapshotCfg.height = cfg.height
        snapshotCfg.pixelFormat = cfg.pixelFormat; snapshotCfg.showsCursor = false
        let enumeration = (now() - en) * 1000
        let frames = Frames()
        var stream: SCStream?
        let setupStart = now()
        if mode.hasPrefix("stream") {
            stream = SCStream(filter: filter, configuration: cfg, delegate: nil)
            try stream!.addStreamOutput(frames, type: .screen, sampleHandlerQueue: DispatchQueue(label: "capture.benchmark.frames"))
            try await stream!.startCapture()
        }
        let setupMs = (now() - setupStart) * 1000
        // Allow fixture and persistent capture startup to settle before steady-state measurement.
        try await Task.sleep(nanoseconds: 1_000_000_000)
        emit(["ready_epoch": Date().timeIntervalSince1970, "phase": "ready", "mode": mode, "rate": rate, "dynamic": dynamic, "producer_fps": cfg.minimumFrameInterval.timescale, "pid": getpid(), "width": cfg.width, "height": cfg.height])
        let deliveredAtStart = frames.countNow()
        let begin = now(), c0 = cpu()
        var rows: [[String: Double]] = []; var cacheHits = 0
        let count = Int(duration * rate)
        if mode == "idle" {
            try await Task.sleep(nanoseconds: UInt64(duration * 1e9))
        } else {
            for i in 0..<count {
                let phase = args.count > 5 && args[5] == "jitter" ? 0.1 + 0.8 * (Double(i) * 0.618033988749895).truncatingRemainder(dividingBy: 1) : 0
                let due = begin + (Double(i) + phase) / rate
                if due > now() { try await Task.sleep(nanoseconds: UInt64((due - now()) * 1e9)) }
                let t = now()
                let b: CMSampleBuffer
                var restartStopMs = 0.0
                if mode.hasPrefix("stream") {
                    if mode == "streamondemand" {
                        if let selected = frames.available(after: t) { b = selected; cacheHits += 1 }
                        else { b = try await SCScreenshotManager.captureSampleBuffer(contentFilter: filter, configuration: snapshotCfg) }
                    } else if mode == "streamdemand" {
                        let configured = cfg.minimumFrameInterval
                        cfg.minimumFrameInterval = .zero
                        try await stream!.updateConfiguration(cfg)
                        if let selected = await frames.observed(after: t) { b = selected }
                        else { b = try await SCScreenshotManager.captureSampleBuffer(contentFilter: filter, configuration: cfg) }
                        cfg.minimumFrameInterval = configured
                        try await stream!.updateConfiguration(cfg)
                    } else if mode == "streamhybrid" {
                        if let selected = await frames.observed(after: t) { b = selected }
                        else { b = try await SCScreenshotManager.captureSampleBuffer(contentFilter: filter, configuration: cfg) }
                    } else { b = mode.contains("latest") ? frames.cached() : await frames.next() }
                } else if mode == "restart" {
                    let output = Frames()
                    let s = SCStream(filter: filter, configuration: cfg, delegate: nil)
                    try s.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "capture.restart"))
                    async let next = output.next()
                    try await s.startCapture()
                    b = await next
                    let stop = now(); try await s.stopCapture(); restartStopMs = (now() - stop) * 1000
                } else {
                    b = try await SCScreenshotManager.captureSampleBuffer(contentFilter: filter, configuration: cfg)
                }
                let got = now()
                guard let pixels = b.imageBuffer, CVPixelBufferGetWidth(pixels) == cfg.width, CVPixelBufferGetHeight(pixels) == cfg.height else { throw NSError(domain: "capture dimensions differ from requested dimensions", code: 1) }
                let stamp = b.presentationTimeStamp.seconds
                let e = now()
                let bytes = try autoreleasepool { try encode(b) }
                let done = now()
                rows.append(["capture_ms": (got - t) * 1000, "encode_ms": (done - e) * 1000, "total_ms": (done - t) * 1000,
                    "frame_age_ms": (got - stamp) * 1000, "native_pts_seconds": stamp, "request_seconds": t, "late_ms": max(0, (done - due - 1 / rate) * 1000), "jpeg_bytes": Double(bytes), "stop_ms": restartStopMs])
            }
            let end = begin + duration
            if now() < end { try await Task.sleep(nanoseconds: UInt64((end - now()) * 1e9)) }
        }
        let elapsed = now() - begin, used = cpu() - c0
        let stopStart = now(); if let stream { try await stream.stopCapture() }; let stopMs = (now() - stopStart) * 1000
        func percentile(_ key: String, _ q: Double) -> Double {
            let a = rows.map { $0[key]! }.sorted(); return a.isEmpty ? 0 : a[min(a.count - 1, Int(Double(a.count - 1) * q))]
        }
        emit(["callback_diagnostics": frames.diagnostics(), "phase": "result", "mode": mode, "rate": rate, "producer_fps": cfg.minimumFrameInterval.timescale, "dynamic": dynamic, "width": cfg.width, "height": cfg.height,
            "cache_hits": cacheHits, "distinct_native_pts": Set(rows.map { $0["native_pts_seconds"]! }).count, "end_epoch": Date().timeIntervalSince1970, "seconds": elapsed, "saved": rows.count, "delivered": frames.countNow(), "delivered_steady": frames.countNow() - deliveredAtStart, "delivered_fps": Double(frames.countNow() - deliveredAtStart) / elapsed, "enumeration_ms": enumeration, "setup_ms": setupMs,
            "stream_first_frame_ms": (frames.first ?? setupStart) * 1000 - setupStart * 1000,
            "stop_ms": stopMs, "cpu_seconds": used, "cpu_percent": used / elapsed * 100, "peak_rss_bytes": { () -> Int64 in var r = rusage(); getrusage(RUSAGE_SELF, &r); return Int64(r.ru_maxrss) }(),
            "capture_p50_ms": percentile("capture_ms", 0.5), "capture_p95_ms": percentile("capture_ms", 0.95),
            "encode_p50_ms": percentile("encode_ms", 0.5), "total_p50_ms": percentile("total_ms", 0.5),
            "total_p95_ms": percentile("total_ms", 0.95), "age_p50_ms": percentile("frame_age_ms", 0.5),
            "missed_deadlines": rows.filter { $0["late_ms"]! > 0 }.count, "samples": rows])
        DispatchQueue.main.async { app.terminate(nil) }
    } catch {
        emit(["phase": "error", "error": String(describing: error), "mode": mode])
        exit(1)
    }
}
app.run()
