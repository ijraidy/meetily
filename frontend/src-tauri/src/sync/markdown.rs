//! Turns the JSON blob stored in `summary_processes.result` into markdown.
//!
//! The desktop app stores summaries in one of three shapes:
//! 1. `{ "markdown": "...", ... }` - produced by the summary service
//! 2. `{ "summary_json": [BlockNote blocks] }` - saved by the BlockNote editor
//! 3. legacy `{ "MeetingName": "...", "<section>": { "title", "blocks": [{ "content" }] } }`
//!
//! Shape 1 is returned as-is. Shape 2 and 3 are flattened into simple
//! markdown. Anything that is not JSON is treated as raw markdown.

use serde_json::Value;

/// Extracts markdown from a stored summary result. Returns `None` when there is
/// no visible content.
pub fn extract_summary_markdown(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let value: Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(_) => return non_empty(trimmed.to_string()),
    };

    match &value {
        Value::String(text) => non_empty(text.trim().to_string()),
        Value::Object(object) => {
            if let Some(markdown) = object.get("markdown").and_then(Value::as_str) {
                return non_empty(markdown.trim().to_string());
            }
            if let Some(blocks) = object.get("summary_json") {
                return non_empty(blocknote_to_markdown(blocks).trim().to_string());
            }
            non_empty(legacy_sections_to_markdown(object).trim().to_string())
        }
        Value::Array(_) => non_empty(blocknote_to_markdown(&value).trim().to_string()),
        _ => non_empty(trimmed.to_string()),
    }
}

/// Builds the JSON document to store when a client sends plain markdown.
///
/// Existing metadata (`MeetingName`, `english_cache`, flags) is preserved so the
/// UI keeps working, `markdown` is replaced, and `summary_json` is removed
/// because the editor prefers it over `markdown` when both are present.
pub fn merge_markdown_into_summary(existing: Option<&str>, markdown: &str) -> Value {
    let mut object = existing
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| match value {
            Value::Object(object) => Some(object),
            _ => None,
        })
        .unwrap_or_default();
    object.remove("summary_json");
    object.insert(
        "markdown".to_string(),
        Value::String(markdown.trim().to_string()),
    );
    Value::Object(object)
}

fn non_empty(text: String) -> Option<String> {
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn blocknote_to_markdown(blocks: &Value) -> String {
    let mut out = String::new();
    if let Value::Array(items) = blocks {
        let mut numbered = 0usize;
        for block in items {
            render_block(block, 0, &mut numbered, &mut out);
        }
    }
    out
}

fn render_block(block: &Value, depth: usize, numbered: &mut usize, out: &mut String) {
    let Some(object) = block.as_object() else {
        return;
    };
    let block_type = object.get("type").and_then(Value::as_str).unwrap_or("paragraph");
    let text = inline_text(object.get("content"));
    let indent = "  ".repeat(depth);

    if block_type != "numberedListItem" {
        *numbered = 0;
    }

    match block_type {
        "heading" => {
            let level = object
                .get("props")
                .and_then(|props| props.get("level"))
                .and_then(Value::as_u64)
                .unwrap_or(2)
                .clamp(1, 6) as usize;
            if !text.trim().is_empty() {
                if !out.is_empty() && !out.ends_with("\n\n") {
                    out.push('\n');
                }
                out.push_str(&format!("{}{} {}\n\n", indent, "#".repeat(level), text.trim()));
            }
        }
        "bulletListItem" => {
            if !text.trim().is_empty() {
                out.push_str(&format!("{}- {}\n", indent, text.trim()));
            }
        }
        "numberedListItem" => {
            if !text.trim().is_empty() {
                *numbered += 1;
                out.push_str(&format!("{}{}. {}\n", indent, numbered, text.trim()));
            }
        }
        "checkListItem" => {
            if !text.trim().is_empty() {
                let checked = object
                    .get("props")
                    .and_then(|props| props.get("checked"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                out.push_str(&format!(
                    "{}- [{}] {}\n",
                    indent,
                    if checked { "x" } else { " " },
                    text.trim()
                ));
            }
        }
        "codeBlock" => {
            if !text.trim().is_empty() {
                out.push_str(&format!("{}```\n{}\n{}```\n\n", indent, text.trim_end(), indent));
            }
        }
        _ => {
            if !text.trim().is_empty() {
                if depth == 0 && !out.is_empty() && !out.ends_with("\n\n") {
                    out.push('\n');
                }
                out.push_str(&format!("{}{}\n\n", indent, text.trim()));
            }
        }
    }

    if let Some(Value::Array(children)) = object.get("children") {
        let mut child_numbered = 0usize;
        for child in children {
            render_block(child, depth + 1, &mut child_numbered, out);
        }
    }
}

fn inline_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items.iter().map(inline_item).collect::<String>(),
        Some(Value::Object(object)) => {
            // Table content or other nested containers: best effort.
            inline_text(object.get("content").or_else(|| object.get("rows")))
        }
        _ => String::new(),
    }
}

fn inline_item(item: &Value) -> String {
    match item {
        Value::String(text) => text.clone(),
        Value::Object(object) => {
            let item_type = object.get("type").and_then(Value::as_str).unwrap_or("text");
            match item_type {
                "link" => {
                    let label = inline_text(object.get("content"));
                    let href = object.get("href").and_then(Value::as_str).unwrap_or("");
                    if href.is_empty() {
                        label
                    } else {
                        format!("[{}]({})", label, href)
                    }
                }
                _ => {
                    let text = object
                        .get("text")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| inline_text(object.get("content")));
                    apply_styles(text, object.get("styles"))
                }
            }
        }
        Value::Array(items) => items.iter().map(inline_item).collect(),
        _ => String::new(),
    }
}

fn apply_styles(text: String, styles: Option<&Value>) -> String {
    let Some(styles) = styles.and_then(Value::as_object) else {
        return text;
    };
    if text.trim().is_empty() {
        return text;
    }
    let flag = |key: &str| styles.get(key).and_then(Value::as_bool).unwrap_or(false);
    let mut result = text;
    if flag("code") {
        result = format!("`{}`", result);
    }
    if flag("bold") {
        result = format!("**{}**", result);
    }
    if flag("italic") {
        result = format!("_{}_", result);
    }
    if flag("strike") {
        result = format!("~~{}~~", result);
    }
    result
}

fn legacy_sections_to_markdown(object: &serde_json::Map<String, Value>) -> String {
    let mut out = String::new();

    let order: Vec<String> = object
        .get("_section_order")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_else(|| {
            object
                .keys()
                .filter(|key| !matches!(key.as_str(), "MeetingName" | "_section_order"))
                .cloned()
                .collect()
        });

    for key in order {
        let Some(section) = object.get(&key).and_then(Value::as_object) else {
            continue;
        };
        let Some(blocks) = section.get("blocks").and_then(Value::as_array) else {
            continue;
        };
        let lines: Vec<String> = blocks
            .iter()
            .filter_map(|block| block.get("content").and_then(Value::as_str))
            .map(str::trim)
            .filter(|content| !content.is_empty())
            .map(str::to_string)
            .collect();
        if lines.is_empty() {
            continue;
        }
        let title = section
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| key.clone());
        out.push_str(&format!("## {}\n\n", title.trim()));
        for line in lines {
            out.push_str(&format!("- {}\n", line));
        }
        out.push('\n');
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn returns_markdown_field_when_present() {
        let raw = json!({"markdown": "## Decisions\n- ship it", "english_cache": {"markdown": "x"}});
        assert_eq!(
            extract_summary_markdown(&raw.to_string()).as_deref(),
            Some("## Decisions\n- ship it")
        );
    }

    #[test]
    fn empty_markdown_field_yields_none() {
        let raw = json!({"markdown": "   "});
        assert_eq!(extract_summary_markdown(&raw.to_string()), None);
        assert_eq!(extract_summary_markdown(""), None);
        assert_eq!(extract_summary_markdown("   \n "), None);
    }

    #[test]
    fn raw_text_is_returned_verbatim() {
        assert_eq!(
            extract_summary_markdown("  # Not JSON\nplain text  ").as_deref(),
            Some("# Not JSON\nplain text")
        );
        // A JSON string literal is unwrapped.
        assert_eq!(
            extract_summary_markdown("\"quoted markdown\"").as_deref(),
            Some("quoted markdown")
        );
    }

    #[test]
    fn flattens_blocknote_blocks() {
        let raw = json!({
            "summary_json": [
                {"type": "heading", "props": {"level": 2}, "content": [{"type": "text", "text": "Decisions", "styles": {}}]},
                {"type": "bulletListItem", "content": [{"type": "text", "text": "Ship ", "styles": {}}, {"type": "text", "text": "Friday", "styles": {"bold": true}}]},
                {"type": "bulletListItem", "content": [{"type": "text", "text": "Nested parent", "styles": {}}],
                 "children": [{"type": "bulletListItem", "content": [{"type": "text", "text": "child", "styles": {}}]}]},
                {"type": "numberedListItem", "content": [{"type": "text", "text": "one", "styles": {}}]},
                {"type": "numberedListItem", "content": [{"type": "text", "text": "two", "styles": {}}]},
                {"type": "paragraph", "content": [{"type": "link", "href": "https://example.com", "content": [{"type": "text", "text": "docs", "styles": {}}]}]},
                {"type": "paragraph", "content": []}
            ]
        });
        let markdown = extract_summary_markdown(&raw.to_string()).unwrap();
        assert_eq!(
            markdown,
            "## Decisions\n\n- Ship **Friday**\n- Nested parent\n  - child\n1. one\n2. two\n\n[docs](https://example.com)"
        );
    }

    #[test]
    fn blocknote_without_visible_text_yields_none() {
        let raw = json!({"summary_json": [{"type": "paragraph", "content": []}]});
        assert_eq!(extract_summary_markdown(&raw.to_string()), None);
    }

    #[test]
    fn flattens_legacy_sections_in_order() {
        let raw = json!({
            "MeetingName": "Weekly",
            "_section_order": ["actions", "notes"],
            "notes": {"title": "Notes", "blocks": [{"content": "first note"}, {"content": "  "}]},
            "actions": {"title": "Action Items", "blocks": [{"content": "call Ali"}]},
            "empty": {"title": "Empty", "blocks": []}
        });
        let markdown = extract_summary_markdown(&raw.to_string()).unwrap();
        assert_eq!(
            markdown,
            "## Action Items\n\n- call Ali\n\n## Notes\n\n- first note"
        );
    }

    #[test]
    fn legacy_without_content_yields_none() {
        let raw = json!({"MeetingName": "Weekly", "notes": {"title": "Notes", "blocks": []}});
        assert_eq!(extract_summary_markdown(&raw.to_string()), None);
    }

    #[test]
    fn merge_preserves_metadata_and_drops_blocknote() {
        let existing = json!({
            "markdown": "old",
            "summary_json": [{"type": "paragraph"}],
            "english_cache": {"markdown": "old-en"},
            "reasoning_stripped": true
        })
        .to_string();
        let merged = merge_markdown_into_summary(Some(&existing), "  new body  ");
        assert_eq!(merged["markdown"], "new body");
        assert!(merged.get("summary_json").is_none());
        assert_eq!(merged["english_cache"]["markdown"], "old-en");
        assert_eq!(merged["reasoning_stripped"], true);
    }

    #[test]
    fn merge_without_existing_creates_markdown_object() {
        let merged = merge_markdown_into_summary(None, "body");
        assert_eq!(merged, json!({"markdown": "body"}));
        let merged = merge_markdown_into_summary(Some("not json"), "body");
        assert_eq!(merged, json!({"markdown": "body"}));
    }
}
