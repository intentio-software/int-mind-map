//! The tool surface an AI agent sees for a mind map library.
//!
//! Maps are read and written as indented outlines by default rather than raw
//! JSON: an outline is what a model can actually reason about and edit, while
//! the file on disk stays the exact JSON the desktop app opens.

use serde_json::{json, Value};

use crate::library::Library;
use crate::map::{self, MindmapNode};
use crate::mcp::{opt_bool, opt_str, opt_usize, require_str, ServerInfo, Tool, ToolOutput, ToolProvider};

pub struct MapTools {
    library: Library,
}

impl MapTools {
    pub fn new(library: Library) -> Self {
        MapTools { library }
    }

    fn library_property(&self) -> Value {
        let names = self.library.names().join(", ");
        json!({
            "type": "string",
            "description": format!(
                "Which map folder to act on. Open folders: {names}.{}",
                if self.library.is_single() { " Optional — only one is open." } else { " Required." }
            )
        })
    }

    fn schema(&self, properties: Value, required: &[&str]) -> Value {
        let mut props = properties.as_object().cloned().unwrap_or_default();
        props.insert("library".into(), self.library_property());
        let mut required: Vec<&str> = required.to_vec();
        if !self.library.is_single() {
            required.push("library");
        }
        json!({ "type": "object", "properties": props, "required": required })
    }
}

/// The `node` argument accepted by the editing tools.
fn node_property() -> Value {
    json!({
        "type": "string",
        "description": "Which node to act on: either its id, or its exact text. Text must identify exactly one node — if it does not, the error lists the candidates with their ids."
    })
}

/// Find a node by id or by its text.
///
/// Agents rarely have ids to hand, so text is the ergonomic path; ambiguity is
/// reported with enough context for the next call to be unambiguous.
fn resolve_node(root: &MindmapNode, selector: &str) -> Result<String, String> {
    let needle = selector.trim();
    if needle.is_empty() {
        return Err("`node` must not be empty".into());
    }
    if root.find(needle).is_some() {
        return Ok(needle.to_string());
    }

    let lowered = needle.to_lowercase();
    let exact: Vec<&MindmapNode> = root
        .walk()
        .into_iter()
        .map(|(node, _)| node)
        .filter(|node| node.content.trim().to_lowercase() == lowered)
        .collect();
    let candidates = if exact.is_empty() {
        root.walk()
            .into_iter()
            .map(|(node, _)| node)
            .filter(|node| node.content.to_lowercase().contains(&lowered))
            .collect()
    } else {
        exact
    };

    match candidates.len() {
        0 => Err(format!("no node matching `{needle}` in this map")),
        1 => Ok(candidates[0].id.clone()),
        _ => {
            let listed: Vec<String> = candidates
                .iter()
                .take(10)
                .map(|node| {
                    let trail = root.trail(&node.id).unwrap_or_default().join(" › ");
                    format!("  {} — {trail}", node.id)
                })
                .collect();
            Err(format!(
                "`{needle}` matches {} nodes. Call again with one of these ids:\n{}",
                candidates.len(),
                listed.join("\n")
            ))
        }
    }
}

/// Insert into a child list at "first", "last", or a numeric index.
fn insert_at(children: &mut Vec<MindmapNode>, node: MindmapNode, position: Option<&str>) {
    let index = match position.map(str::trim) {
        Some("first") | Some("start") => 0,
        Some(value) => match value.parse::<usize>() {
            Ok(parsed) => parsed.min(children.len()),
            Err(_) => children.len(),
        },
        None => children.len(),
    };
    children.insert(index, node);
}

fn summary(path: &str, root: &MindmapNode) -> Value {
    json!({
        "path": path,
        "title": root.content,
        "nodes": root.count(),
        "depth": root.depth(),
    })
}

impl ToolProvider for MapTools {
    fn server_info(&self) -> ServerInfo {
        ServerInfo {
            name: "intentio-mind-map".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            instructions: concat!(
                "Read and write Intentio Mind Map files — `.json` maps in the folders this server was ",
                "given. Files written here open unchanged in the desktop app.\n\n",
                "Guidance:\n",
                "- Maps are exchanged as indented markdown outlines. One bullet per node, two spaces ",
                "per level, exactly one root:\n",
                "    - Product Strategy\n",
                "      - Q3 goals\n",
                "        - Ship the updater\n",
                "- Use `read_map` then the node tools (`add_node`, `update_node`, `move_node`, ",
                "`delete_node`) for targeted edits; they preserve node ids and collapse state.\n",
                "- Use `write_map` only to restructure a whole map at once — it replaces every node.\n",
                "- Nodes are addressed by id or by their exact text.\n",
                "- Node text is capped at 360 characters, matching the app.",
            )
            .into(),
        }
    }

    fn tools(&self) -> Vec<Tool> {
        vec![
            Tool::new(
                "list_libraries",
                "List the mind map folders this server has open, with their paths and map counts.",
                json!({ "type": "object", "properties": {} }),
            ),
            Tool::new(
                "list_maps",
                "List the mind maps in a folder, with their titles and node counts.",
                self.schema(
                    json!({"folder": {"type": "string", "description": "Only maps under this subfolder."}}),
                    &[],
                ),
            ),
            Tool::new(
                "read_map",
                "Read a mind map as an indented outline (default) or as raw JSON. Read before editing.",
                self.schema(
                    json!({
                        "path": {"type": "string", "description": "Map path relative to the folder, e.g. `Plans/Q3.json`. `.json` is added if missing."},
                        "format": {"type": "string", "enum": ["outline", "json"], "description": "`outline` is compact and editable; `json` is the exact file contents. Default `outline`."},
                        "include_ids": {"type": "boolean", "description": "Append ` ^id` to each outline line. Useful when node texts repeat. Default false."}
                    }),
                    &["path"],
                ),
            ),
            Tool::new(
                "map_info",
                "Summarize a map: title, node count, depth and its top-level branches.",
                self.schema(json!({"path": {"type": "string", "description": "Map path."}}), &["path"]),
            ),
            Tool::new(
                "create_map",
                "Create a new mind map from an outline. Fails if a map already exists at that path.",
                self.schema(
                    json!({
                        "path": {"type": "string", "description": "Map path relative to the folder."},
                        "outline": {"type": "string", "description": "Indented bullet outline with exactly one root, e.g. \"- Root\\n  - Child\"."},
                        "title": {"type": "string", "description": "Used as the single root node when no outline is given."}
                    }),
                    &["path"],
                ),
            ),
            Tool::new(
                "write_map",
                "Replace a map's entire structure from an outline. Node ids and collapse state are kept for nodes whose text is unchanged. Prefer the node tools for small edits.",
                self.schema(
                    json!({
                        "path": {"type": "string", "description": "Map path."},
                        "outline": {"type": "string", "description": "The complete new outline."}
                    }),
                    &["path", "outline"],
                ),
            ),
            Tool::new(
                "add_node",
                "Add a node under a parent. Without a parent it is added under the root.",
                self.schema(
                    json!({
                        "path": {"type": "string", "description": "Map path."},
                        "content": {"type": "string", "description": "Text for the new node."},
                        "parent": node_property(),
                        "position": {"type": "string", "description": "`first`, `last`, or a 0-based index among the parent's children. Default `last`."}
                    }),
                    &["path", "content"],
                ),
            ),
            Tool::new(
                "update_node",
                "Change a node's text or collapse state, leaving its children in place.",
                self.schema(
                    json!({
                        "path": {"type": "string", "description": "Map path."},
                        "node": node_property(),
                        "content": {"type": "string", "description": "New text for the node."},
                        "collapsed": {"type": "boolean", "description": "Whether the node is folded in the app."}
                    }),
                    &["path", "node"],
                ),
            ),
            Tool::new(
                "delete_node",
                "Delete a node and everything beneath it. The root cannot be deleted.",
                self.schema(
                    json!({"path": {"type": "string", "description": "Map path."}, "node": node_property()}),
                    &["path", "node"],
                ),
            ),
            Tool::new(
                "move_node",
                "Reparent a node, carrying its subtree along.",
                self.schema(
                    json!({
                        "path": {"type": "string", "description": "Map path."},
                        "node": node_property(),
                        "parent": node_property(),
                        "position": {"type": "string", "description": "`first`, `last`, or a 0-based index among the new parent's children. Default `last`."}
                    }),
                    &["path", "node", "parent"],
                ),
            ),
            Tool::new(
                "search_maps",
                "Find nodes matching text across every map in a folder, with the path from each map's root.",
                self.schema(
                    json!({
                        "query": {"type": "string", "description": "Text to look for in node content."},
                        "limit": {"type": "integer", "description": "Maximum matches. Default 50."}
                    }),
                    &["query"],
                ),
            ),
        ]
    }

    fn call(&mut self, name: &str, args: &Value) -> Result<ToolOutput, String> {
        if name == "list_libraries" {
            let libraries: Vec<Value> = self
                .library
                .roots()
                .iter()
                .map(|root| {
                    json!({
                        "name": root.name(),
                        "path": root.path().to_string_lossy(),
                        "maps": root.list().len(),
                    })
                })
                .collect();
            return Ok(ToolOutput::json(&json!({ "libraries": libraries })));
        }

        let root_dir = self.library.select(opt_str(args, "library").as_deref())?;

        match name {
            "list_maps" => {
                let folder = opt_str(args, "folder").map(|f| {
                    let trimmed = f.trim_matches('/').to_string();
                    if trimmed.is_empty() { trimmed } else { format!("{trimmed}/") }
                });
                let maps: Vec<Value> = root_dir
                    .list()
                    .into_iter()
                    .filter(|path| match &folder {
                        Some(prefix) if !prefix.is_empty() => path.starts_with(prefix.as_str()),
                        _ => true,
                    })
                    .map(|path| match root_dir.read(&path) {
                        Ok((path, map)) => summary(&path, &map),
                        // A stray `.json` that is not a map should not hide the rest.
                        Err(err) => json!({ "path": path, "error": err }),
                    })
                    .collect();
                Ok(ToolOutput::json(&json!({ "count": maps.len(), "maps": maps })))
            }

            "read_map" => {
                let (path, map) = root_dir.read(&require_str(args, "path")?)?;
                let format = opt_str(args, "format").unwrap_or_else(|| "outline".into());
                match format.as_str() {
                    "json" => Ok(ToolOutput::json(&json!({
                        "path": path,
                        "map": serde_json::to_value(&map).map_err(|err| err.to_string())?,
                    }))),
                    "outline" => Ok(ToolOutput::json(&json!({
                        "path": path,
                        "title": map.content,
                        "nodes": map.count(),
                        "outline": map::to_outline(&map, opt_bool(args, "include_ids", false)),
                    }))),
                    other => Err(format!("unknown format `{other}`; use `outline` or `json`")),
                }
            }

            "map_info" => {
                let (path, map) = root_dir.read(&require_str(args, "path")?)?;
                let branches: Vec<Value> = map
                    .children
                    .iter()
                    .map(|child| json!({ "content": child.content, "id": child.id, "nodes": child.count() }))
                    .collect();
                let mut info = summary(&path, &map);
                info["branches"] = json!(branches);
                Ok(ToolOutput::json(&info))
            }

            "create_map" => {
                let path = require_str(args, "path")?;
                let map = match opt_str(args, "outline") {
                    Some(outline) => map::from_outline(&outline)?,
                    None => {
                        let title = opt_str(args, "title")
                            .ok_or("give either `outline` or `title` to create a map")?;
                        let mut root = MindmapNode::new(&title);
                        root.normalize(None);
                        root
                    }
                };
                let written = root_dir.create(&path, &map)?;
                Ok(ToolOutput::json(&summary(&written, &map)))
            }

            "write_map" => {
                let path = require_str(args, "path")?;
                let outline = require_str(args, "outline")?;
                let mut fresh = map::from_outline(&outline)?;
                // Keep identity for nodes that survived the rewrite, so the app's
                // collapse state and selection are not reset by an agent edit.
                if let Ok((_, previous)) = root_dir.read(&path) {
                    map::preserve_identity(&mut fresh, &previous);
                }
                let written = root_dir.write(&path, &fresh)?;
                Ok(ToolOutput::json(&summary(&written, &fresh)))
            }

            "add_node" => {
                let (path, mut map) = root_dir.read(&require_str(args, "path")?)?;
                let content = require_str(args, "content")?;
                let parent_id = match opt_str(args, "parent") {
                    Some(selector) => resolve_node(&map, &selector)?,
                    None => map.id.clone(),
                };
                let node = MindmapNode::new(&content);
                let node_id = node.id.clone();
                let parent = map.find_mut(&parent_id).ok_or("parent node disappeared")?;
                insert_at(&mut parent.children, node, opt_str(args, "position").as_deref());
                map.normalize(None);
                let written = root_dir.write(&path, &map)?;
                Ok(ToolOutput::json(&json!({
                    "path": written,
                    "added": { "id": node_id, "content": content },
                    "trail": map.trail(&node_id),
                    "nodes": map.count(),
                })))
            }

            "update_node" => {
                let (path, mut map) = root_dir.read(&require_str(args, "path")?)?;
                let node_id = resolve_node(&map, &require_str(args, "node")?)?;
                let new_content = opt_str(args, "content");
                let collapsed = args.get("collapsed").and_then(Value::as_bool);
                if new_content.is_none() && collapsed.is_none() {
                    return Err("give `content`, `collapsed`, or both".into());
                }
                let node = map.find_mut(&node_id).ok_or("node disappeared")?;
                if let Some(content) = &new_content {
                    node.content = map::clamp(content);
                }
                if let Some(collapsed) = collapsed {
                    node.collapsed = collapsed;
                }
                let content = node.content.clone();
                let written = root_dir.write(&path, &map)?;
                Ok(ToolOutput::json(&json!({
                    "path": written,
                    "updated": { "id": node_id, "content": content },
                })))
            }

            "delete_node" => {
                let (path, mut map) = root_dir.read(&require_str(args, "path")?)?;
                let node_id = resolve_node(&map, &require_str(args, "node")?)?;
                if node_id == map.id {
                    return Err("the root node cannot be deleted; delete the map file instead".into());
                }
                let removed = map.remove(&node_id).ok_or("node disappeared")?;
                let written = root_dir.write(&path, &map)?;
                Ok(ToolOutput::json(&json!({
                    "path": written,
                    "deleted": { "id": removed.id, "content": removed.content, "nodes_removed": removed.count() },
                    "nodes": map.count(),
                })))
            }

            "move_node" => {
                let (path, mut map) = root_dir.read(&require_str(args, "path")?)?;
                let node_id = resolve_node(&map, &require_str(args, "node")?)?;
                let parent_id = resolve_node(&map, &require_str(args, "parent")?)?;

                if node_id == map.id {
                    return Err("the root node cannot be moved".into());
                }
                if node_id == parent_id {
                    return Err("a node cannot be its own parent".into());
                }
                // Moving a node beneath itself would detach the subtree entirely.
                let subtree = map.find(&node_id).ok_or("node disappeared")?;
                if subtree.contains(&parent_id) {
                    return Err("cannot move a node into its own subtree".into());
                }

                let moved = map.remove(&node_id).ok_or("node disappeared")?;
                let parent = map.find_mut(&parent_id).ok_or("parent node disappeared")?;
                insert_at(&mut parent.children, moved, opt_str(args, "position").as_deref());
                map.normalize(None);
                let written = root_dir.write(&path, &map)?;
                Ok(ToolOutput::json(&json!({
                    "path": written,
                    "moved": node_id,
                    "trail": map.trail(&node_id),
                })))
            }

            "search_maps" => {
                let query = require_str(args, "query")?.to_lowercase();
                let limit = opt_usize(args, "limit", 50);
                let mut matches = Vec::new();
                let mut total = 0usize;

                for path in root_dir.list() {
                    let Ok((path, map)) = root_dir.read(&path) else { continue };
                    for (node, depth) in map.walk() {
                        if !node.content.to_lowercase().contains(&query) {
                            continue;
                        }
                        total += 1;
                        if matches.len() >= limit {
                            continue;
                        }
                        matches.push(json!({
                            "map": path,
                            "id": node.id,
                            "content": node.content,
                            "depth": depth,
                            "trail": map.trail(&node.id),
                        }));
                    }
                }
                Ok(ToolOutput::json(&json!({ "total": total, "matches": matches })))
            }

            other => Err(format!("unknown tool: {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tools_with(name: &str, maps: &[(&str, &str)]) -> MapTools {
        let dir: PathBuf = std::env::temp_dir()
            .join(format!("int-mindmap-tools-{}-{name}", std::process::id()))
            .join("maps");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let library = Library::open(&[dir]).unwrap();
        let root = library.select(None).unwrap();
        for (path, outline) in maps {
            root.write(path, &map::from_outline(outline).unwrap()).unwrap();
        }
        MapTools::new(Library::open(&[library.roots()[0].path().to_path_buf()]).unwrap())
    }

    fn call(tools: &mut MapTools, name: &str, args: Value) -> Value {
        let output = tools.call(name, &args).expect("tool call succeeded");
        serde_json::from_str(&output.text).expect("tool returned json")
    }

    const SAMPLE: &str = "- Strategy\n  - Q3 goals\n    - Ship updater\n  - Q4 goals\n";

    #[test]
    fn every_tool_has_a_description_and_object_schema() {
        let tools = tools_with("schemas", &[]);
        for tool in tools.tools() {
            assert!(!tool.description.is_empty(), "{} has no description", tool.name);
            assert_eq!(tool.input_schema["type"], "object", "{} schema is not an object", tool.name);
        }
    }

    #[test]
    fn creates_and_reads_back_an_outline() {
        let mut tools = tools_with("create", &[]);
        let created = call(&mut tools, "create_map", json!({"path": "Plans/Q3", "outline": SAMPLE}));
        assert_eq!(created["path"], "Plans/Q3.json");
        assert_eq!(created["nodes"], 4);

        let read = call(&mut tools, "read_map", json!({"path": "Plans/Q3"}));
        assert_eq!(read["outline"], SAMPLE);
        assert_eq!(read["title"], "Strategy");
    }

    #[test]
    fn create_refuses_to_overwrite() {
        let mut tools = tools_with("no-clobber", &[("A.json", SAMPLE)]);
        assert!(tools.call("create_map", &json!({"path": "A", "title": "x"})).is_err());
    }

    #[test]
    fn adds_a_node_under_a_named_parent() {
        let mut tools = tools_with("add", &[("A.json", SAMPLE)]);
        let added = call(&mut tools, "add_node", json!({
            "path": "A", "parent": "Q3 goals", "content": "Ship MCP", "position": "first"
        }));
        assert_eq!(added["trail"], json!(["Strategy", "Q3 goals", "Ship MCP"]));
        let read = call(&mut tools, "read_map", json!({"path": "A"}));
        assert_eq!(
            read["outline"],
            "- Strategy\n  - Q3 goals\n    - Ship MCP\n    - Ship updater\n  - Q4 goals\n"
        );
    }

    #[test]
    fn updates_and_deletes_nodes() {
        let mut tools = tools_with("edit", &[("A.json", SAMPLE)]);
        call(&mut tools, "update_node", json!({"path": "A", "node": "Q4 goals", "content": "Q4 plan"}));
        let deleted = call(&mut tools, "delete_node", json!({"path": "A", "node": "Q3 goals"}));
        assert_eq!(deleted["deleted"]["nodes_removed"], 2);
        let read = call(&mut tools, "read_map", json!({"path": "A"}));
        assert_eq!(read["outline"], "- Strategy\n  - Q4 plan\n");
    }

    #[test]
    fn refuses_to_delete_or_move_the_root() {
        let mut tools = tools_with("root", &[("A.json", SAMPLE)]);
        assert!(tools.call("delete_node", &json!({"path": "A", "node": "Strategy"})).is_err());
        assert!(tools
            .call("move_node", &json!({"path": "A", "node": "Strategy", "parent": "Q3 goals"}))
            .is_err());
    }

    #[test]
    fn refuses_to_move_a_node_into_its_own_subtree() {
        let mut tools = tools_with("cycle", &[("A.json", SAMPLE)]);
        let err = tools
            .call("move_node", &json!({"path": "A", "node": "Q3 goals", "parent": "Ship updater"}))
            .unwrap_err();
        assert!(err.contains("own subtree"), "{err}");
    }

    #[test]
    fn moves_a_subtree_and_rethreads_parents() {
        let mut tools = tools_with("move", &[("A.json", SAMPLE)]);
        call(&mut tools, "move_node", json!({"path": "A", "node": "Ship updater", "parent": "Q4 goals"}));
        let read = call(&mut tools, "read_map", json!({"path": "A"}));
        assert_eq!(read["outline"], "- Strategy\n  - Q3 goals\n  - Q4 goals\n    - Ship updater\n");

        let raw = call(&mut tools, "read_map", json!({"path": "A", "format": "json"}));
        let q4 = &raw["map"]["children"][1];
        assert_eq!(q4["children"][0]["parentId"], q4["id"]);
    }

    #[test]
    fn ambiguous_node_text_lists_candidates() {
        let mut tools = tools_with("ambiguous", &[("A.json", "- Root\n  - Goal\n  - Goal\n")]);
        let err = tools.call("delete_node", &json!({"path": "A", "node": "Goal"})).unwrap_err();
        assert!(err.contains("matches 2 nodes"), "{err}");
        assert!(err.contains("Root › Goal"), "{err}");
    }

    #[test]
    fn rewriting_a_map_keeps_ids_of_unchanged_nodes() {
        let mut tools = tools_with("rewrite", &[("A.json", SAMPLE)]);
        let before = call(&mut tools, "read_map", json!({"path": "A", "format": "json"}));
        let q3_id = before["map"]["children"][0]["id"].as_str().unwrap().to_string();

        call(&mut tools, "write_map", json!({
            "path": "A",
            "outline": "- Strategy\n  - Q3 goals\n    - Ship updater\n    - Ship MCP\n"
        }));
        let after = call(&mut tools, "read_map", json!({"path": "A", "format": "json"}));
        assert_eq!(after["map"]["children"][0]["id"], q3_id);
    }

    #[test]
    fn searches_across_maps() {
        let mut tools = tools_with("search", &[("A.json", SAMPLE), ("B.json", "- Other\n  - Ship it\n")]);
        let hits = call(&mut tools, "search_maps", json!({"query": "ship"}));
        assert_eq!(hits["total"], 2);
        let maps: Vec<&str> = hits["matches"].as_array().unwrap().iter().map(|m| m["map"].as_str().unwrap()).collect();
        assert_eq!(maps, vec!["A.json", "B.json"]);
    }

    #[test]
    fn rejects_paths_outside_the_library() {
        let mut tools = tools_with("escape", &[]);
        assert!(tools.call("read_map", &json!({"path": "../../secrets"})).is_err());
    }

    #[test]
    fn malformed_outlines_are_reported_clearly() {
        let mut tools = tools_with("bad-outline", &[]);
        let err = tools.call("create_map", &json!({"path": "A", "outline": "- One\n- Two\n"})).unwrap_err();
        assert!(err.contains("second"), "{err}");
    }
}
