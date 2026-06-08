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
| Select multiple nodes | `Shift + ↑↓` |
| Clear multi-selection | `Escape` |
| Move node up / down | `Ctrl/Cmd + ↑↓` |
| Move selected group up / down | `Ctrl/Cmd + ↑↓` (with multi-select) |
| Indent / outdent | `Ctrl/Cmd + ←→` |
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

## Tech Stack

- [Tauri v2](https://tauri.app) — native shell and auto-updater
- [Angular 20](https://angular.dev) — UI framework
- [PrimeNG](https://primeng.org) — UI components

## License

Free for personal use. Commercial license coming soon — contact [intentiosoftware.com](https://intentiosoftware.com) for enquiries.
