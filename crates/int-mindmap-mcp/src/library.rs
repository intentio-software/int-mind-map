//! The folders of `.json` mind maps this server is allowed to touch.
//!
//! Intentio Mind Map saves maps wherever the user points the export dialog, so a
//! library here is simply one or more directories named at launch. Every path a
//! tool receives is resolved inside one of them; nothing else on the filesystem
//! is reachable.

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::map::MindmapNode;

pub const MAP_EXTENSION: &str = "json";

/// Directory names never worth scanning for maps.
const SKIPPED_DIRS: [&str; 4] = ["node_modules", "target", "dist", ".git"];

#[derive(Debug, Clone)]
pub struct LibraryRoot {
    root: PathBuf,
}

impl LibraryRoot {
    pub fn path(&self) -> &Path {
        &self.root
    }

    pub fn name(&self) -> String {
        self.root
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| self.root.to_string_lossy().to_string())
    }

    /// Turn caller input into a safe library-relative path ending in `.json`.
    pub fn normalize(&self, input: &str) -> Result<String, String> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Err("path is empty".into());
        }

        let candidate = Path::new(trimmed);
        let relative = if candidate.is_absolute() {
            candidate
                .strip_prefix(&self.root)
                .map_err(|_| format!("`{trimmed}` is outside the library at {}", self.root.display()))?
                .to_path_buf()
        } else {
            candidate.to_path_buf()
        };

        let mut parts: Vec<String> = Vec::new();
        for component in relative.components() {
            match component {
                Component::Normal(part) => parts.push(part.to_string_lossy().to_string()),
                Component::CurDir => {}
                Component::ParentDir => {
                    parts.pop().ok_or_else(|| format!("`{trimmed}` escapes the library"))?;
                }
                Component::RootDir | Component::Prefix(_) => {
                    return Err(format!("`{trimmed}` escapes the library"))
                }
            }
        }
        if parts.is_empty() {
            return Err(format!("`{trimmed}` is not a valid map path"));
        }

        let mut path = parts.join("/");
        if !path.to_ascii_lowercase().ends_with(&format!(".{MAP_EXTENSION}")) {
            path.push_str(&format!(".{MAP_EXTENSION}"));
        }
        Ok(path)
    }

    fn absolute(&self, relative: &str) -> PathBuf {
        self.root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR))
    }

    pub fn exists(&self, relative: &str) -> bool {
        self.absolute(relative).is_file()
    }

    /// Every map file in the library, sorted by path.
    pub fn list(&self) -> Vec<String> {
        let mut found = Vec::new();
        walk(&self.root, &self.root, &mut found);
        found.sort();
        found
    }

    /// Load and normalize a map.
    pub fn read(&self, relative: &str) -> Result<(String, MindmapNode), String> {
        let path = self.normalize(relative)?;
        let absolute = self.absolute(&path);
        if !absolute.is_file() {
            return Err(format!("no map at `{path}`"));
        }
        let text = fs::read_to_string(&absolute).map_err(|err| format!("cannot read `{path}`: {err}"))?;
        let mut root: MindmapNode = serde_json::from_str(&text)
            .map_err(|err| format!("`{path}` is not a mind map file: {err}"))?;
        root.normalize(None);
        Ok((path, root))
    }

    /// Write a map, creating parent folders. Returns the library-relative path.
    pub fn write(&self, relative: &str, root: &MindmapNode) -> Result<String, String> {
        let path = self.normalize(relative)?;
        let absolute = self.absolute(&path);
        if let Some(parent) = absolute.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("cannot create folder: {err}"))?;
        }
        // Two-space pretty printing matches the app's own export, so a map saved
        // here produces no diff noise against one saved from the UI.
        let json = serde_json::to_string_pretty(root).map_err(|err| format!("cannot serialize map: {err}"))?;
        fs::write(&absolute, format!("{json}\n")).map_err(|err| format!("cannot write `{path}`: {err}"))?;
        Ok(path)
    }

    pub fn create(&self, relative: &str, root: &MindmapNode) -> Result<String, String> {
        let path = self.normalize(relative)?;
        if self.exists(&path) {
            return Err(format!("a map already exists at `{path}`"));
        }
        self.write(&path, root)
    }
}

fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            if SKIPPED_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk(base, &path, out);
            continue;
        }
        let is_map = path
            .extension()
            .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case(MAP_EXTENSION))
            .unwrap_or(false);
        if is_map {
            if let Ok(relative) = path.strip_prefix(base) {
                out.push(relative.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/"));
            }
        }
    }
}

pub struct Library {
    roots: Vec<LibraryRoot>,
}

impl Library {
    pub fn open(paths: &[PathBuf]) -> Result<Self, String> {
        if paths.is_empty() {
            return Err("no map folder configured: pass a folder or set INT_MINDMAP_DIR".into());
        }
        let mut roots = Vec::new();
        for path in paths {
            if !path.exists() {
                fs::create_dir_all(path).map_err(|err| format!("{}: {err}", path.display()))?;
            }
            if !path.is_dir() {
                return Err(format!("{} is not a folder", path.display()));
            }
            let root = fs::canonicalize(path).map_err(|err| format!("{}: {err}", path.display()))?;
            roots.push(LibraryRoot { root });
        }

        let mut names: Vec<String> = roots.iter().map(|root| root.name().to_lowercase()).collect();
        names.sort();
        let total = names.len();
        names.dedup();
        if names.len() != total {
            return Err("map folder names must be unique so tools can address them by name".into());
        }

        Ok(Library { roots })
    }

    pub fn is_single(&self) -> bool {
        self.roots.len() == 1
    }

    pub fn names(&self) -> Vec<String> {
        self.roots.iter().map(LibraryRoot::name).collect()
    }

    pub fn roots(&self) -> &[LibraryRoot] {
        &self.roots
    }

    /// Pick the library a tool call refers to; optional when only one is open.
    pub fn select(&self, requested: Option<&str>) -> Result<&LibraryRoot, String> {
        match requested {
            None if self.roots.len() == 1 => Ok(&self.roots[0]),
            None => Err(format!(
                "`library` is required when several map folders are open. Available: {}",
                self.names().join(", ")
            )),
            Some(name) => {
                let needle = name.trim();
                self.roots
                    .iter()
                    .find(|root| root.name().eq_ignore_ascii_case(needle) || root.path() == Path::new(needle))
                    .ok_or_else(|| format!("unknown library `{needle}`. Available: {}", self.names().join(", ")))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("int-mindmap-lib-{}-{name}", std::process::id()))
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn normalizes_and_adds_the_extension() {
        let library = Library::open(&[temp_root("norm")]).unwrap();
        let root = library.select(None).unwrap();
        assert_eq!(root.normalize("Plans/Q3").unwrap(), "Plans/Q3.json");
        assert_eq!(root.normalize("./Plans/../Q3.json").unwrap(), "Q3.json");
    }

    #[test]
    fn refuses_paths_outside_the_library() {
        let library = Library::open(&[temp_root("escape")]).unwrap();
        let root = library.select(None).unwrap();
        assert!(root.normalize("../elsewhere.json").is_err());
        assert!(root.normalize("/etc/passwd").is_err());
    }

    #[test]
    fn creates_reads_and_lists_maps() {
        let library = Library::open(&[temp_root("io")]).unwrap();
        let root = library.select(None).unwrap();
        let map = crate::map::from_outline("- Root\n  - Child\n").unwrap();

        assert_eq!(root.create("Plans/Q3", &map).unwrap(), "Plans/Q3.json");
        assert!(root.create("Plans/Q3.json", &map).is_err(), "must not clobber");
        assert_eq!(root.list(), vec!["Plans/Q3.json"]);

        let (path, loaded) = root.read("Plans/Q3").unwrap();
        assert_eq!(path, "Plans/Q3.json");
        assert_eq!(loaded.children[0].content, "Child");
    }

    #[test]
    fn rejects_files_that_are_not_maps() {
        let dir = temp_root("bad");
        fs::write(dir.join("notes.json"), r#"{"hello":"world"}"#).unwrap();
        let library = Library::open(&[dir]).unwrap();
        assert!(library.select(None).unwrap().read("notes.json").is_err());
    }

    #[test]
    fn multiple_libraries_are_addressed_by_name() {
        let library = Library::open(&[temp_root("work"), temp_root("personal")]).unwrap();
        assert!(library.select(None).is_err());
        assert_eq!(library.select(Some("WORK")).unwrap().name(), "work");
        assert!(library.select(Some("nope")).is_err());
    }
}
