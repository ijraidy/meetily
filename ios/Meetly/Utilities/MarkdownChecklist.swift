import Foundation

/// Line-oriented Markdown model used by the summary view. Only the constructs
/// the desktop templates emit are recognised; everything else is a paragraph.
struct MarkdownBlock: Identifiable, Equatable {
    enum Kind: Equatable {
        case heading(level: Int, text: String)
        case checkbox(checked: Bool, text: String)
        case bullet(text: String)
        case numbered(label: String, text: String)
        case paragraph(text: String)
        case blank
    }

    /// Zero-based line index inside the markdown source.
    let id: Int
    let kind: Kind
}

enum MarkdownChecklist {
    static func parse(_ markdown: String) -> [MarkdownBlock] {
        let lines = markdown.components(separatedBy: .newlines)
        return lines.enumerated().map { index, line in
            MarkdownBlock(id: index, kind: classify(line))
        }
    }

    /// Returns the markdown with the checkbox on `lineIndex` flipped, or nil if that line is not a checkbox.
    static func toggleCheckbox(in markdown: String, atLine lineIndex: Int) -> String? {
        var lines = markdown.components(separatedBy: .newlines)
        guard lines.indices.contains(lineIndex) else { return nil }
        guard let toggled = toggledLine(lines[lineIndex]) else { return nil }
        lines[lineIndex] = toggled
        return lines.joined(separator: "\n")
    }

    static func taskCounts(in markdown: String) -> (done: Int, total: Int) {
        var done = 0
        var total = 0
        for block in parse(markdown) {
            if case let .checkbox(checked, _) = block.kind {
                total += 1
                if checked { done += 1 }
            }
        }
        return (done, total)
    }

    // MARK: - Private

    private static func classify(_ rawLine: String) -> MarkdownBlock.Kind {
        let line = rawLine.trimmingCharacters(in: .whitespaces)
        if line.isEmpty { return .blank }

        if line.hasPrefix("#") {
            var level = 0
            var rest = Substring(line)
            while rest.first == "#", level < 6 {
                level += 1
                rest = rest.dropFirst()
            }
            if rest.first == " " || rest.isEmpty {
                return .heading(level: level, text: rest.trimmingCharacters(in: .whitespaces))
            }
        }

        if let checkbox = checkboxParts(of: line) {
            return .checkbox(checked: checkbox.checked, text: checkbox.text)
        }

        if let bulletText = listItemText(of: line) {
            return .bullet(text: bulletText)
        }

        if let numbered = numberedParts(of: line) {
            return .numbered(label: numbered.label, text: numbered.text)
        }

        return .paragraph(text: line)
    }

    private static func checkboxParts(of line: String) -> (checked: Bool, text: String)? {
        guard let itemText = listItemText(of: line) else { return nil }
        let lower = itemText.lowercased()
        if lower.hasPrefix("[ ]") {
            return (false, String(itemText.dropFirst(3)).trimmingCharacters(in: .whitespaces))
        }
        if lower.hasPrefix("[x]") {
            return (true, String(itemText.dropFirst(3)).trimmingCharacters(in: .whitespaces))
        }
        if lower.hasPrefix("[]") {
            return (false, String(itemText.dropFirst(2)).trimmingCharacters(in: .whitespaces))
        }
        return nil
    }

    private static func listItemText(of line: String) -> String? {
        for marker in ["- ", "* ", "+ "] where line.hasPrefix(marker) {
            return String(line.dropFirst(marker.count)).trimmingCharacters(in: .whitespaces)
        }
        return nil
    }

    private static func numberedParts(of line: String) -> (label: String, text: String)? {
        var digits = ""
        var rest = Substring(line)
        while let first = rest.first, first.isNumber, digits.count < 4 {
            digits.append(first)
            rest = rest.dropFirst()
        }
        guard !digits.isEmpty, let punct = rest.first, punct == "." || punct == ")" else { return nil }
        rest = rest.dropFirst()
        guard rest.first == " " || rest.isEmpty else { return nil }
        return ("\(digits).", rest.trimmingCharacters(in: .whitespaces))
    }

    private static func toggledLine(_ line: String) -> String? {
        guard let openRange = line.range(of: "[") else { return nil }
        let prefix = line[line.startIndex..<openRange.lowerBound]
        let afterOpen = line[openRange.upperBound...]
        let trimmedPrefix = prefix.trimmingCharacters(in: .whitespaces)
        guard trimmedPrefix == "-" || trimmedPrefix == "*" || trimmedPrefix == "+" else { return nil }

        let head = String(prefix)
        if afterOpen.hasPrefix(" ]") {
            return head + "[x]" + String(afterOpen.dropFirst(2))
        }
        if afterOpen.hasPrefix("]") {
            return head + "[x]" + String(afterOpen.dropFirst(1))
        }
        if afterOpen.hasPrefix("x]") || afterOpen.hasPrefix("X]") {
            return head + "[ ]" + String(afterOpen.dropFirst(2))
        }
        return nil
    }
}
