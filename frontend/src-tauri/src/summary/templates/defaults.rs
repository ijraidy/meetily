/// Embedded default templates using compile-time inclusion
///
/// These templates are bundled into the binary and serve as fallbacks
/// when custom templates are not available.

/// Daily standup template for engineering/product teams
pub const DAILY_STANDUP: &str = include_str!("../../../templates/daily_standup.json");

/// Standard meeting notes template
pub const STANDARD_MEETING: &str = include_str!("../../../templates/standard_meeting.json");

pub const MEETING_ACTION_PLAN: &str = include_str!("../../../templates/meeting_action_plan.json");

/// Registry of all built-in templates
///
/// Maps template identifiers to their embedded JSON content
pub fn get_builtin_templates() -> Vec<(&'static str, &'static str)> {
    vec![
        ("daily_standup", DAILY_STANDUP),
        ("standard_meeting", STANDARD_MEETING),
        ("meeting_action_plan", MEETING_ACTION_PLAN),
    ]
}

/// Get a built-in template by identifier
///
/// # Arguments
/// * `id` - Template identifier (e.g., "daily_standup", "standard_meeting")
///
/// # Returns
/// The template JSON content if found, None otherwise
pub fn get_builtin_template(id: &str) -> Option<&'static str> {
    match id {
        "daily_standup" => Some(DAILY_STANDUP),
        "standard_meeting" => Some(STANDARD_MEETING),
        "meeting_action_plan" => Some(MEETING_ACTION_PLAN),
        _ => None,
    }
}

/// List all built-in template identifiers
pub fn list_builtin_template_ids() -> Vec<&'static str> {
    vec!["daily_standup", "standard_meeting", "meeting_action_plan"]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_builtin_templates_valid_json() {
        for (id, content) in get_builtin_templates() {
            let result = serde_json::from_str::<serde_json::Value>(content);
            assert!(
                result.is_ok(),
                "Built-in template '{}' contains invalid JSON: {:?}",
                id,
                result.err()
            );
        }
    }

    #[test]
    fn test_action_plan_loads_and_generates_section_instructions() {
        let template: crate::summary::templates::Template =
            serde_json::from_str(get_builtin_template("meeting_action_plan").unwrap()).unwrap();
        assert!(template.validate().is_ok());
        let instructions = template.to_section_instructions();
        assert!(instructions.contains("- [ ]"));
        assert!(instructions.contains("Not specified"));
        assert!(template.to_markdown_structure().contains("Action Plan"));
        assert!(list_builtin_template_ids().contains(&"meeting_action_plan"));
    }

    /// The action-plan template must keep the rules that fixed the 2026-09-07
    /// defects: completed tasks as checked boxes, unassigned tasks kept in the
    /// checklist with "Owner: Not specified", no invented priority, and
    /// suggestions kept out of decisions and tasks.
    #[test]
    fn test_action_plan_section_rules_cover_known_defects() {
        let template: crate::summary::templates::Template =
            serde_json::from_str(get_builtin_template("meeting_action_plan").unwrap()).unwrap();
        let titles: Vec<&str> = template.sections.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(
            titles,
            vec![
                "Meeting Summary",
                "Decisions",
                "Task Checklist",
                "Action Plan",
                "Open Questions and Blockers"
            ]
        );

        let section = |title: &str| {
            template
                .sections
                .iter()
                .find(|s| s.title == title)
                .unwrap_or_else(|| panic!("missing section {title}"))
        };

        let checklist = section("Task Checklist");
        assert!(checklist.instruction.contains("- [x]"));
        assert!(checklist.instruction.contains("a finished task must never be omitted"));
        assert!(checklist.instruction.contains("Owner: Not specified"));
        assert!(checklist
            .instruction
            .contains("never move an unassigned task to Open Questions and Blockers"));
        assert!(checklist.instruction.contains("is not a task"));
        assert!(checklist.instruction.contains("never convert them to calendar dates"));
        assert!(checklist
            .instruction
            .contains("Do not invent tasks, names, dates, timestamps, or completion status"));
        let item_format = checklist.item_format.as_deref().unwrap();
        assert!(item_format.starts_with("- [x] "));
        assert!(item_format.contains("- [ ] Open task"));
        assert!(item_format.contains("Owner: name or Not specified"));

        let plan = section("Action Plan");
        assert!(plan.instruction.contains("never assign a priority level yourself"));
        assert!(plan.instruction.contains("Do not repeat completed tasks"));
        assert!(plan.instruction.contains("do not invent a strategy or schedule"));

        let decisions = section("Decisions");
        assert!(decisions.instruction.contains("explicitly agreed"));
        assert!(decisions
            .instruction
            .contains("Suggestions that were not agreed, unresolved questions, and task assignments are not decisions"));

        let open = section("Open Questions and Blockers");
        assert!(open.instruction.contains("is not an open question"));
    }

    #[test]
    fn test_get_builtin_template() {
        assert!(get_builtin_template("daily_standup").is_some());
        assert!(get_builtin_template("standard_meeting").is_some());
        assert!(get_builtin_template("nonexistent").is_none());
    }
}
