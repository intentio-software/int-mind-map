# Intentio Mind Map

A fast, focused mind mapping tool for capturing strategy, story arcs, and product plans. Built with Tauri and Angular.

![License](https://img.shields.io/badge/license-personal%20use-blue)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

## Download

Grab the latest installer for your platform from the [Releases](https://github.com/intentio-software/int-mind-map/releases/latest) page.

| Platform | File |
|---|---|
| macOS | `*.dmg` (Universal — Intel + Apple Silicon) |
| Windows | `*_x64-setup.exe` |
| Linux | `*.AppImage` or `*.deb` |

## Features

- **Infinite canvas** — pan, zoom, and navigate your map freely
- **Keyboard-first** — build maps without touching the mouse
- **Themes** — dark, light, or follows your system setting
- **Auto-save** — changes persist automatically between sessions
- **Export** — SVG, PNG, JSON, and Freeplane (`.mm`) formats
- **Import** — open `.json` mind map files
- **Auto-update** — the app notifies you when a new version is available

## AI agents (MCP)

`int-mindmap-mcp` is a standalone [MCP](https://modelcontextprotocol.io) server that reads and
writes Intentio Mind Map `.json` files. It runs as its own process, so an agent can work on your
maps whether or not the app is open, and maps it writes open in the app unchanged.

```bash
# Build it
cargo build --release --manifest-path crates/int-mindmap-mcp/Cargo.toml

# Point an agent at a folder of maps
claude mcp add mindmap -- ./crates/int-mindmap-mcp/target/release/int-mindmap-mcp ~/Documents/MindMaps
```

**How maps get there:** the app keeps the map you are working on in local storage and writes a file
when you export. The MCP server works on files, so a map becomes visible to an agent once you
export it as JSON into the folder you gave the server (`File → Export → JSON`). Maps the agent
creates appear as `.json` files you open with `File → Open`.

Agents exchange maps as indented outlines rather than raw JSON, which is far cheaper to read and
edit:

```
- Product Strategy
  - Q3 goals
    - Ship the updater
  - Q4 goals
```

### Tools

| Tool | What it does |
|---|---|
| `list_libraries` | Map folders the server has open |
| `list_maps` | Maps in a folder, with titles and node counts |
| `read_map` | A map as an outline (default) or raw JSON |
| `map_info` | Title, node count, depth and top-level branches |
| `create_map` | New map from an outline; refuses to overwrite |
| `write_map` | Replace a map's structure, keeping ids and collapse state where text is unchanged |
| `add_node` | Add a node under a parent |
| `update_node` | Change a node's text or collapse state |
| `delete_node` | Delete a node and its subtree |
| `move_node` | Reparent a node, carrying its subtree |
| `search_maps` | Find nodes by text across every map |

Nodes are addressed by id or by their exact text; ambiguous text comes back with the candidate ids
listed. Every path is resolved inside the folders you named, so a tool call cannot reach anything
else on disk.

See also [Intentio Knowledge](https://github.com/intentio-software/int-knowledge) — a markdown vault
with the same MCP approach.

## Menus

File, Edit, View and Help live in the native menu bar. The top bar in the window keeps only the
map name and the theme control, so the canvas gets the space.

Undo, Redo, Copy Node and Paste Node deliberately carry no menu shortcut: those keys mean different
things depending on whether a node's text box has focus, and a menu accelerator is claimed by the OS
before the app can tell. The keyboard shortcuts below still work — the app handles them, and it knows
where focus is.

## Keyboard Shortcuts

| Action | Shortcut |
|---|---|
| Add child node | `Tab` |
| Add sibling node | `Enter` |
| Delete node | `Backspace` |
| Start editing | Any key / double-click |
| Confirm edit | `Enter` |
| Cancel edit | `Escape` |
| Collapse / expand | `Space` |
| Navigate | `Arrow keys` |
| Select multiple nodes | `Shift + ↑↓` or `Shift + Click` |
| Clear multi-selection | `Escape` |
| Move node / group up / down | `Ctrl/Cmd + ↑↓` |
| Indent / outdent node / group | `Ctrl/Cmd + ←→` |
| Undo / redo | `Ctrl/Cmd + Z` / `Ctrl/Cmd + Shift + Z` |
| Copy node | `Ctrl/Cmd + C` |
| Paste node | `Ctrl/Cmd + V` |
| Save | `Ctrl/Cmd + S` |
| Fit to screen | `Shift + F` or `Ctrl/Cmd + 0` |
| Zoom in / out | `Ctrl/Cmd + +/-` |

## Building from Source

**Prerequisites**

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- On Linux: `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`

```bash
git clone https://github.com/intentio-software/int-mind-map.git
cd int-mind-map
npm install
npx tauri dev
```

To build a release binary:

```bash
npx tauri build
```

The MCP server is a separate crate with its own toolchain requirements (Rust only):

```bash
cargo build --release --manifest-path crates/int-mindmap-mcp/Cargo.toml
cargo test --manifest-path crates/int-mindmap-mcp/Cargo.toml
```

## Tech Stack

- [Tauri v2](https://tauri.app) — native shell and auto-updater
- [Angular 20](https://angular.dev) — UI framework
- [PrimeNG](https://primeng.org) — UI components

## License

Free for personal use. Commercial license coming soon — contact [intentiosoftware.com](https://intentiosoftware.com) for enquiries.
