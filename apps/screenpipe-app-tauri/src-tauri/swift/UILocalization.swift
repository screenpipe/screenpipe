// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import Foundation
import SwiftUI
import CryptoKit

/// Each native module receives the same validated, offline catalog from Rust.
/// Publishing a locale change invalidates text without replacing a window or
/// its view identity, preserving selection, drafts and recording state.
final class UILocalization: ObservableObject {
    static let shared = UILocalization()
    @Published private(set) var locale = Locale(identifier: "en")
    private var messages: [String: String] = [:]
    private var dateFormatters: [String: DateFormatter] = [:]
    private let numberFormatter = NumberFormatter()
    private let relativeFormatter = RelativeDateTimeFormatter()

    func dateFormatter(_ template: String) -> DateFormatter {
        if let formatter = dateFormatters[template] { return formatter }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.setLocalizedDateFormatFromTemplate(template)
        dateFormatters[template] = formatter
        return formatter
    }

    func number(_ value: Int64) -> String {
        numberFormatter.locale = locale
        numberFormatter.numberStyle = .decimal
        return numberFormatter.string(from: NSNumber(value: value)) ?? String(value)
    }

    func relativeDate(_ date: Date, to now: Date = Date()) -> String {
        relativeFormatter.locale = locale
        relativeFormatter.unitsStyle = .short
        return relativeFormatter.localizedString(for: date, relativeTo: now)
    }

    func update(_ pointer: UnsafePointer<CChar>?) {
        guard let pointer, let text = String(validatingUTF8: pointer),
              let data = text.data(using: .utf8),
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let identifier = payload["locale"] as? String,
              let translations = payload["messages"] as? [String: String] else { return }
        let apply = {
            self.dateFormatters.removeAll()
            self.messages = translations
            self.locale = Locale(identifier: identifier)
        }
        if Thread.isMainThread { apply() } else { DispatchQueue.main.async(execute: apply) }
    }

    func text(_ english: String) -> String {
        let id = SHA256.hash(data: Data(english.utf8)).prefix(8)
            .map { String(format: "%02x", $0) }.joined()
        return messages[id] ?? english
    }
}

/// Only literal app-owned English belongs here. Interpolation values are never
/// included in extraction, translation requests, or support diagnostics.
func uiText(_ english: String, _ values: [String: String] = [:]) -> String {
    let translated = UILocalization.shared.text(english)
    // Replace in a single pass so an inserted value containing another token
    // cannot be interpreted as a second interpolation.
    guard !values.isEmpty else { return translated }
    let pattern = try! NSRegularExpression(pattern: "\\{([A-Za-z][A-Za-z0-9_]*)\\}")
    let source = translated as NSString
    var result = translated
    for match in pattern.matches(in: translated, range: NSRange(location: 0, length: source.length)).reversed() {
        guard let value = values[source.substring(with: match.range(at: 1))],
              let range = Range(match.range, in: result) else { continue }
        result.replaceSubrange(range, with: value)
    }
    return result
}

func uiNumber<T: BinaryInteger>(_ value: T) -> String {
    UILocalization.shared.number(Int64(clamping: value))
}
