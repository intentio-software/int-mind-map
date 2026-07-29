//! The mind map document model, matching what Intentio Mind Map reads and writes.
//!
//! A `.json` map file is exactly one serialized root node — no wrapper object —
//! so anything written here opens in the app unchanged, and anything the app
//! exports is readable here. Unrecognised fields are carried through verbatim so
//! a future app version can add to the format without this server dropping data.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Matches `MAX_NODE_CHARS` in the app; longer content is truncated there too.
pub const MAX_NODE_CHARS: usize = 360;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MindmapNode {
    pub id: String,
    #[serde(default)]
    pub content: String,
    #[serde(rename = "parentId", default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub collapsed: bool,
    #[serde(default)]
    pub children: Vec<MindmapNode>,
    /// Fields this server does not model (layout hints, future additions).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl MindmapNode {
    pub fn new(content: &str) -> Self {
        MindmapNode {
            id: new_id(),
            content: clamp(content),
            parent_id: None,
            collapsed: false,
            children: Vec::new(),
            extra: Map::new(),
        }
    }

    /// Fill in missing ids and re-thread `parentId`, the way the app does on import.
    pub fn normalize(&mut self, parent: Option<&str>) {
        if self.id.trim().is_empty() {
            self.id = new_id();
        }
        self.parent_id = parent.map(str::to_string);
        self.content = clamp(&self.content);
        let id = self.id.clone();
        for child in &mut self.children {
            child.normalize(Some(&id));
        }
    }

    pub fn count(&self) -> usize {
        1 + self.children.iter().map(MindmapNode::count).sum::<usize>()
    }

    pub fn depth(&self) -> usize {
        1 + self.children.iter().map(MindmapNode::depth).max().unwrap_or(0)
    }

    /// Depth-first walk yielding every node with its depth.
    pub fn walk(&self) -> Vec<(&MindmapNode, usize)> {
        let mut out = Vec::new();
        collect(self, 0, &mut out);
        out
    }

    pub fn find(&self, id: &str) -> Option<&MindmapNode> {
        if self.id == id {
            return Some(self);
        }
        self.children.iter().find_map(|child| child.find(id))
    }

    pub fn find_mut(&mut self, id: &str) -> Option<&mut MindmapNode> {
        if self.id == id {
            return Some(self);
        }
        self.children.iter_mut().find_map(|child| child.find_mut(id))
    }

    /// Remove a node and its subtree, returning it. The root cannot be removed.
    pub fn remove(&mut self, id: &str) -> Option<MindmapNode> {
        if let Some(position) = self.children.iter().position(|child| child.id == id) {
            return Some(self.children.remove(position));
        }
        self.children.iter_mut().find_map(|child| child.remove(id))
    }

    /// True when `id` is this node or anywhere beneath it — the check that stops
    /// a move from reparenting a node into its own subtree.
    pub fn contains(&self, id: &str) -> bool {
        self.find(id).is_some()
    }

    /// Path of node contents from the root down to `id`, for readable results.
    pub fn trail(&self, id: &str) -> Option<Vec<String>> {
        if self.id == id {
            return Some(vec![self.content.clone()]);
        }
        for child in &self.children {
            if let Some(mut trail) = child.trail(id) {
                trail.insert(0, self.content.clone());
                return Some(trail);
            }
        }
        None
    }
}

fn collect<'a>(node: &'a MindmapNode, depth: usize, out: &mut Vec<(&'a MindmapNode, usize)>) {
    out.push((node, depth));
    for child in &node.children {
        collect(child, depth + 1, out);
    }
}

pub fn clamp(content: &str) -> String {
    if content.chars().count() <= MAX_NODE_CHARS {
        return content.to_string();
    }
    content.chars().take(MAX_NODE_CHARS).collect()
}

/// Ids only need to be unique within a file; the app treats them as opaque.
pub fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    format!("node-{:x}{:x}", nanos, seq)
}

// ---------------------------------------------------------------------------
// outline form
// ---------------------------------------------------------------------------

/// Render a map as an indented markdown bullet list.
///
/// This is the form agents read and write most cheaply. Newlines inside a node
/// become `\n` so that one node is always one line, which keeps the outline
/// unambiguous to re-parse.
pub fn to_outline(root: &MindmapNode, include_ids: bool) -> String {
    let mut out = String::new();
    for (node, depth) in root.walk() {
        let indent = "  ".repeat(depth);
        let content = escape(&node.content);
        out.push_str(&format!("{indent}- {content}"));
        if include_ids {
            out.push_str(&format!("  ^{}", node.id));
        }
        out.push('\n');
    }
    out
}

/// Parse an indented bullet list back into a tree.
///
/// Indentation sets the hierarchy; two spaces per level is the canonical form,
/// but any consistent increase nests one level, so hand-written outlines work.
/// Lines carrying a trailing `^id` keep that id.
pub fn from_outline(outline: &str) -> Result<MindmapNode, String> {
    // (indent, node) for each ancestor currently open.
    let mut stack: Vec<(usize, MindmapNode)> = Vec::new();
    let mut root: Option<MindmapNode> = None;

    for (number, raw) in outline.lines().enumerate() {
        if raw.trim().is_empty() {
            continue;
        }
        let indent = raw.len() - raw.trim_start().len();
        let text = raw.trim_start();
        let text = text
            .strip_prefix("- ")
            .or_else(|| text.strip_prefix("* "))
            .or_else(|| text.strip_prefix("-"))
            .unwrap_or(text);

        let (content, id) = split_id(text.trim());
        let mut node = MindmapNode::new(&unescape(content));
        if let Some(id) = id {
            node.id = id;
        }

        // Close every open node indented at or deeper than this one.
        while let Some((open_indent, _)) = stack.last() {
            if *open_indent < indent {
                break;
            }
            let (_, finished) = stack.pop().expect("stack non-empty");
            match stack.last_mut() {
                Some((_, parent)) => parent.children.push(finished),
                None => {
                    if root.is_some() {
                        return Err(format!(
                            "line {}: a map has one root, but this line starts a second one",
                            number + 1
                        ));
                    }
                    root = Some(finished);
                }
            }
        }

        if stack.is_empty() && root.is_some() {
            return Err(format!(
                "line {}: `{}` is a second top-level item; indent it under the root",
                number + 1,
                content
            ));
        }
        stack.push((indent, node));
    }

    // Unwind whatever is still open.
    while let Some((_, finished)) = stack.pop() {
        match stack.last_mut() {
            Some((_, parent)) => parent.children.push(finished),
            None => root = Some(finished),
        }
    }

    let mut root = root.ok_or("the outline is empty")?;
    root.normalize(None);
    Ok(root)
}

/// Carry ids and collapsed state from an old tree onto a newly parsed one.
///
/// Rewriting a whole map from an outline would otherwise reset every node's
/// identity and fold state. Nodes are matched by their content path from the
/// root, which is stable for the common case of editing text in place.
pub fn preserve_identity(fresh: &mut MindmapNode, previous: &MindmapNode) {
    if fresh.content == previous.content {
        fresh.id = previous.id.clone();
        fresh.collapsed = previous.collapsed;
        for (key, value) in &previous.extra {
            fresh.extra.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
    let mut used: Vec<usize> = Vec::new();
    for child in &mut fresh.children {
        let matched = previous
            .children
            .iter()
            .enumerate()
            .find(|(index, old)| !used.contains(index) && old.content == child.content);
        if let Some((index, old)) = matched {
            used.push(index);
            preserve_identity(child, old);
        }
    }
    // Re-thread parent ids after any id changed.
    let id = fresh.id.clone();
    for child in &mut fresh.children {
        child.parent_id = Some(id.clone());
    }
}

fn split_id(text: &str) -> (&str, Option<String>) {
    let Some(position) = text.rfind(" ^") else {
        return (text, None);
    };
    let candidate = &text[position + 2..];
    if candidate.is_empty() || !candidate.chars().all(|c| c.is_alphanumeric() || c == '-') {
        return (text, None);
    }
    (text[..position].trim_end(), Some(candidate.to_string()))
}

fn escape(content: &str) -> String {
    content.replace('\\', "\\\\").replace('\n', "\\n").replace('\r', "")
}

fn unescape(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut chars = content.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> MindmapNode {
        from_outline("- Root\n  - Child A\n    - Grandchild\n  - Child B\n").unwrap()
    }

    #[test]
    fn parses_indentation_into_hierarchy() {
        let root = sample();
        assert_eq!(root.content, "Root");
        assert_eq!(root.children.len(), 2);
        assert_eq!(root.children[0].content, "Child A");
        assert_eq!(root.children[0].children[0].content, "Grandchild");
        assert_eq!(root.children[1].content, "Child B");
        assert_eq!(root.count(), 4);
        assert_eq!(root.depth(), 3);
    }

    #[test]
    fn threads_parent_ids() {
        let root = sample();
        assert!(root.parent_id.is_none());
        assert_eq!(root.children[0].parent_id.as_deref(), Some(root.id.as_str()));
        let child_a = &root.children[0];
        assert_eq!(child_a.children[0].parent_id.as_deref(), Some(child_a.id.as_str()));
    }

    #[test]
    fn round_trips_through_outline() {
        let root = sample();
        let outline = to_outline(&root, false);
        assert_eq!(outline, "- Root\n  - Child A\n    - Grandchild\n  - Child B\n");
        assert_eq!(to_outline(&from_outline(&outline).unwrap(), false), outline);
    }

    #[test]
    fn round_trips_multiline_content() {
        let mut root = MindmapNode::new("Root");
        root.children.push(MindmapNode::new("line one\nline two"));
        root.normalize(None);
        let outline = to_outline(&root, false);
        assert_eq!(outline.lines().count(), 2);
        let parsed = from_outline(&outline).unwrap();
        assert_eq!(parsed.children[0].content, "line one\nline two");
    }

    #[test]
    fn keeps_ids_when_present() {
        let root = from_outline("- Root  ^abc\n  - Child  ^def\n").unwrap();
        assert_eq!(root.id, "abc");
        assert_eq!(root.children[0].id, "def");
    }

    #[test]
    fn caret_in_prose_is_not_an_id() {
        let root = from_outline("- Root ^ not an id\n").unwrap();
        assert_eq!(root.content, "Root ^ not an id");
    }

    #[test]
    fn rejects_a_second_root() {
        assert!(from_outline("- One\n- Two\n").is_err());
        assert!(from_outline("").is_err());
    }

    #[test]
    fn tolerates_uneven_indentation() {
        let root = from_outline("- Root\n    - Child\n        - Grandchild\n").unwrap();
        assert_eq!(root.children[0].children[0].content, "Grandchild");
    }

    #[test]
    fn preserves_ids_and_collapse_across_a_rewrite() {
        let mut original = sample();
        original.children[0].collapsed = true;
        let original_id = original.children[0].id.clone();

        let mut rewritten = from_outline("- Root\n  - Child A\n    - Grandchild\n  - Child B\n  - Child C\n").unwrap();
        preserve_identity(&mut rewritten, &original);

        assert_eq!(rewritten.children[0].id, original_id);
        assert!(rewritten.children[0].collapsed);
        assert_eq!(rewritten.children[2].content, "Child C");
        assert_eq!(rewritten.children[2].parent_id.as_deref(), Some(rewritten.id.as_str()));
    }

    #[test]
    fn removes_subtrees_and_reports_trails() {
        let mut root = sample();
        let target = root.children[0].id.clone();
        assert_eq!(root.trail(&target).unwrap(), vec!["Root", "Child A"]);
        let removed = root.remove(&target).unwrap();
        assert_eq!(removed.count(), 2);
        assert_eq!(root.count(), 2);
        assert!(root.find(&target).is_none());
    }

    #[test]
    fn serializes_to_the_apps_shape() {
        let root = sample();
        let json = serde_json::to_value(&root).unwrap();
        assert!(json.get("parentId").is_none(), "root must not carry parentId");
        assert!(json.get("collapsed").is_none(), "false collapsed is omitted");
        assert_eq!(json["children"][0]["parentId"], json["id"]);
    }

    #[test]
    fn preserves_unknown_fields() {
        let source = r#"{"id":"a","content":"Root","x":10,"y":20,"children":[]}"#;
        let node: MindmapNode = serde_json::from_str(source).unwrap();
        let round_tripped = serde_json::to_value(&node).unwrap();
        assert_eq!(round_tripped["x"], 10);
        assert_eq!(round_tripped["y"], 20);
    }

    #[test]
    fn clamps_overlong_content() {
        let long = "x".repeat(MAX_NODE_CHARS + 50);
        assert_eq!(MindmapNode::new(&long).content.chars().count(), MAX_NODE_CHARS);
    }
}
