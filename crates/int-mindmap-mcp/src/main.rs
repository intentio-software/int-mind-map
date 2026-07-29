//! `int-mindmap-mcp` — an MCP server over Intentio Mind Map files.
//!
//! Runs as a plain stdio process against one or more folders of `.json` maps, so
//! it works whether or not the desktop app is open:
//!
//! ```text
//! claude mcp add mindmap -- int-mindmap-mcp ~/Documents/Mind\ Maps
//! ```

mod library;
mod map;
mod mcp;
mod tools;

use std::path::PathBuf;
use std::process::ExitCode;

use library::Library;
use tools::MapTools;

const USAGE: &str = "\
int-mindmap-mcp — MCP server for Intentio Mind Map files

USAGE:
    int-mindmap-mcp [OPTIONS] [MAP_FOLDER]...

ARGS:
    <MAP_FOLDER>...    One or more folders holding `.json` mind maps.
                       Folders are created if they do not exist.

OPTIONS:
    --dir <PATH>       Add a map folder (repeatable; same as a positional path)
    -h, --help         Print this help
    -V, --version      Print version

ENVIRONMENT:
    INT_MINDMAP_DIR    Comma-separated map folders, used when none are given

The server speaks MCP over stdio. Register it with an agent, for example:

    claude mcp add mindmap -- int-mindmap-mcp ~/Documents/MindMaps
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let dirs = match parse_args(&args) {
        Ok(Some(dirs)) => dirs,
        // --help / --version already printed.
        Ok(None) => return ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}\n\n{USAGE}");
            return ExitCode::FAILURE;
        }
    };

    let library = match Library::open(&dirs) {
        Ok(library) => library,
        Err(message) => {
            eprintln!("error: {message}");
            return ExitCode::FAILURE;
        }
    };

    // Startup diagnostics go to stderr; stdout carries protocol traffic only.
    eprintln!("[mindmap] serving {} folder(s): {}", dirs.len(), library.names().join(", "));

    match mcp::serve(MapTools::new(library)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::FAILURE
        }
    }
}

/// Collect map folders from the command line, falling back to the environment.
///
/// `Ok(None)` means the process printed help or version and should exit cleanly.
fn parse_args(args: &[String]) -> Result<Option<Vec<PathBuf>>, String> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut index = 0usize;

    while index < args.len() {
        match args[index].as_str() {
            "-h" | "--help" => {
                println!("{USAGE}");
                return Ok(None);
            }
            "-V" | "--version" => {
                println!("int-mindmap-mcp {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            "--dir" | "--vault" => {
                let value = args.get(index + 1).ok_or("`--dir` needs a path")?;
                dirs.push(expand(value));
                index += 2;
            }
            other if other.starts_with('-') => return Err(format!("unknown option: {other}")),
            other => {
                dirs.push(expand(other));
                index += 1;
            }
        }
    }

    if dirs.is_empty() {
        if let Ok(from_env) = std::env::var("INT_MINDMAP_DIR") {
            dirs.extend(from_env.split(',').map(str::trim).filter(|p| !p.is_empty()).map(expand));
        }
    }

    if dirs.is_empty() {
        return Err("no map folder given".into());
    }
    Ok(Some(dirs))
}

/// Expand a leading `~`, which clients routinely pass through unexpanded.
fn expand(path: &str) -> PathBuf {
    let trimmed = path.trim();
    if trimmed == "~" || trimmed.starts_with("~/") {
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            return if trimmed == "~" { home } else { home.join(&trimmed[2..]) };
        }
    }
    PathBuf::from(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn collects_positional_and_flagged_folders() {
        let dirs = parse_args(&to_args(&["/a", "--dir", "/b"])).unwrap().unwrap();
        assert_eq!(dirs, vec![PathBuf::from("/a"), PathBuf::from("/b")]);
    }

    #[test]
    fn rejects_unknown_options_and_missing_values() {
        assert!(parse_args(&to_args(&["--nope"])).is_err());
        assert!(parse_args(&to_args(&["--dir"])).is_err());
        assert!(parse_args(&[]).is_err());
    }

    #[test]
    fn expands_home_relative_paths() {
        std::env::set_var("HOME", "/home/test");
        assert_eq!(expand("~/Maps"), PathBuf::from("/home/test/Maps"));
        assert_eq!(expand("/absolute"), PathBuf::from("/absolute"));
    }
}
