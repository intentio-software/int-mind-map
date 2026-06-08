import { CommonModule } from "@angular/common";
import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  QueryList,
  ViewChild,
  ViewChildren,
  computed,
  effect,
  inject,
  signal,
  untracked
} from "@angular/core";
import { UpdaterService } from "./services/updater.service";
import JSZip from "jszip";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

declare global {
  interface Window {
    __TAURI__?: {
      fs?: {
        writeFile(options: {
          path: string;
          contents: Uint8Array | string;
        }): Promise<void>;
      };
      dialog?: {
        save?(options: {
          defaultPath?: string;
          filters?: { name: string; extensions: string[] }[];
        }): Promise<string | null>;
      };
    };
  }
}

interface MindmapNode {
  id: string;
  content: string;
  parentId?: string;
  children: MindmapNode[];
  x?: number;
  y?: number;
  collapsed?: boolean;
}

interface ClipboardNode {
  id?: string;
  content?: string;
  children?: ClipboardNode[];
  collapsed?: boolean;
}

interface LayoutNode {
  id: string;
  node: MindmapNode;
  parentId?: string;
  depth: number;
  x: number;
  y: number;
}

interface LayoutEdge {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface LayoutResult {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

interface ContentBounds {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

interface ExportPalette {
  nodeFill: string;
  nodeStroke: string;
  nodeText: string;
  edgeColor: string;
  accent: string;
}

interface RecentMapEntry {
  id: string;
  name: string;
  tree: MindmapNode;
  openedAt: number;
}

interface XMindTopic {
  id: string;
  title: string;
  children?: { attached: XMindTopic[] };
}

interface ViewportState {
  offsetX: number;
  offsetY: number;
  scale: number;
  userMoved: boolean;
}

interface MindmapSnapshot {
  tree: MindmapNode;
  selectedId: string;
  viewport: ViewportState;
}

type ThemePreference = "dark" | "light" | "system";

const NODE_WIDTH = 280;
const NODE_MIN_HEIGHT = 42;
const NODE_VERTICAL_PADDING = 8;
const AVERAGE_CHARS_PER_LINE = 28;
const NODE_LINE_HEIGHT = 18;
const H_SPACING = 320;
const V_SPACING = 56;
const MIN_SCALE = 0.4;
const MAX_SCALE = 2;
const STORAGE_KEY = "intentio:last-mindmap";
const THEME_STORAGE_KEY = "intentio:theme-preference";
const PERSIST_DEBOUNCE = 250;
const MAX_NODE_CHARS = 360;
const HISTORY_LIMIT = 50;
const MOUSE_ZOOM_SENSITIVITY = 0.0009;
const KEYBOARD_ZOOM_IN = 1.04;
const KEYBOARD_ZOOM_OUT = 0.96;
const THEME_CYCLE: ThemePreference[] = ["system", "dark", "light"];
const MAP_NAME_STORAGE_KEY = "intentio:map-name";
const MAP_NAME_AUTO_STORAGE_KEY = "intentio:map-name-auto";
const RECENTS_STORAGE_KEY = "intentio:recent-maps";
const DEFAULT_MAP_NAME = "Untitled Mind Map";
const RECENT_LIMIT = 5;
const EXPORT_FONT_SIZE = 12;
const EXPORT_LINE_HEIGHT = 16;
const APP_VERSION_FALLBACK = "v0.1.0";
const COMMANDS: Record<string, () => string> = {
  "/date": () => new Date().toLocaleDateString(),
  "/time": () => new Date().toLocaleTimeString(),
  "/datetime": () => new Date().toLocaleString()
};

@Component({
  selector: "app-mindmap",
  standalone: true,
  imports: [CommonModule],
  templateUrl: "./mindmap.component.html",
  styleUrls: ["./mindmap.component.css"]
})
export class MindmapComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChildren("nodeInput") nodeInputs?: QueryList<
    ElementRef<HTMLTextAreaElement>
  >;
  @ViewChild("importInput") importInput?: ElementRef<HTMLInputElement>;
  @ViewChild("svgCanvas") svgCanvas?: ElementRef<SVGSVGElement>;
  @ViewChild("canvasWrapper") canvasWrapper?: ElementRef<HTMLDivElement>;

  readonly nodeWidth = NODE_WIDTH;

  readonly themePreference = signal<ThemePreference>(
    this.restoreThemePreference()
  );
  private readonly systemPrefersDark = signal(this.detectSystemPrefersDark());
  readonly theme = computed<"dark" | "light">(() => {
    const preference = this.themePreference();
    if (preference === "system") {
      return this.systemPrefersDark() ? "dark" : "light";
    }
    return preference;
  });

  readonly mapName = signal(this.restoreMapName());
  readonly mapNameFollowsRoot = signal(this.restoreMapNameAutoFlag());
  readonly displayedMapName = computed(
    () => this.mapName() || this.mapTitleText()
  );
  readonly licensingNotice =
    "Free for personal use – commercial license coming soon.";
  readonly isSaved = signal(true);
  readonly fileMenuOpen = signal(false);
  readonly exportMenuOpen = signal(false);
  readonly recentMaps = signal<RecentMapEntry[]>(this.restoreRecentMaps());
  readonly commandSelectionIndex = signal(0);
  readonly commandSuggestionAnchor = signal<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  readonly commandSuggestions = computed(() => {
    const editingId = this.editingNodeId();
    this.layoutVersion();
    if (!editingId) {
      return [];
    }
    const input = this.findInputRef(editingId);
    const value = input?.value ?? "";
    if (!value.startsWith("/")) {
      return [];
    }
    return this.getCommandMatches(value);
  });

  private lastPointer = { x: 0, y: 0 };
  private editOriginal = "";
  private shouldSelectAll = true;
  private editingHistoryCaptured = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressHistory = false;
  private historyPast: MindmapSnapshot[] = [];
  private historyFuture: MindmapSnapshot[] = [];
  private systemPreferenceQuery?: MediaQueryList;
  private systemPreferenceListener?: (event: MediaQueryListEvent) => void;
  private exportNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private savedFilePath: string | null = null;
  private suppressDirty = false;
  private hasNamedSave = false;

  readonly rootNode = signal<MindmapNode>(this.restoreInitialTree());
  private readonly layoutVersion = signal(0);
  readonly selectedNodeId = signal<string>(this.rootNode().id);
  readonly selectedNodeIds = signal<Set<string>>(
    new Set([this.rootNode().id])
  );
  readonly editingNodeId = signal<string | null>(null);
  readonly canvasSize = signal({
    width:
      typeof window !== "undefined" && window.innerWidth
        ? window.innerWidth
        : 1280,
    height:
      typeof window !== "undefined" && window.innerHeight
        ? window.innerHeight
        : 720
  });
  readonly viewport = signal<ViewportState>({
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    userMoved: false
  });
  readonly mapTitleText = signal(this.rootNode().content || "Mind Map");
  readonly isDragging = signal(false);
  readonly aboutDialogOpen = signal(false);
  readonly exportNotice = signal<string | null>(null);
  readonly appVersion = signal(APP_VERSION_FALLBACK);
  readonly isCheckingUpdates = signal(false);
  private readonly updaterService = inject(UpdaterService);


  readonly layout = computed<LayoutResult>(() => {
    this.layoutVersion();
    const tree = untracked(() => this.rootNode());
    return this.computeLayout(tree);
  });
  private readonly focusEffectCleanup = effect(() => {
    const editingId = this.editingNodeId();
    if (!editingId) {
      return;
    }
    queueMicrotask(() => {
      const input = this.findInputRef(editingId);
      if (!input) {
        return;
      }
      input.focus();
      if (this.shouldSelectAll) {
        input.select();
      } else {
        const length = input.value.length;
        input.setSelectionRange(length, length);
      }
      this.autoSizeInput(editingId);
    });
  });

  private readonly viewportEffectCleanup = effect(() => {
    const selectedId = this.selectedNodeId();
    const layoutSnapshot = this.layout();
    const canvas = this.canvasSize();
    const node = layoutSnapshot.nodes.find((n) => n.id === selectedId);
    if (!node) {
      return;
    }
    const viewport = untracked(() => this.viewport());
    if (!this.isNodeOffscreen(node, viewport, canvas)) {
      return;
    }
    this.centerOnNode(node, viewport.scale);
  });

  private readonly themeEffectCleanup = effect(() => {
    const mode = this.theme();
    if (typeof document === "undefined") {
      return;
    }
    document.body.dataset["theme"] = mode;
  });

  private readonly resizeListener = () => {
    if (typeof window === "undefined") {
      return;
    }
    this.canvasSize.set({
      width: window.innerWidth,
      height: window.innerHeight
    });
  };

  private readonly commandSuggestionPositionEffect = effect(() => {
    const suggestions = this.commandSuggestions();
    if (!suggestions.length) {
      this.commandSuggestionAnchor.set(null);
      this.commandSelectionIndex.set(0);
      return;
    }
    const editingId = this.editingNodeId();
    if (!editingId) {
      this.commandSuggestionAnchor.set(null);
      return;
    }
    const input = this.findInputRef(editingId);
    const wrapper = this.canvasWrapper?.nativeElement;
    if (!input || !wrapper) {
      this.commandSuggestionAnchor.set(null);
      this.commandSelectionIndex.set(0);
      return;
    }
    const inputRect = input.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const width = Math.min(inputRect.width, wrapperRect.width - 24);
    this.commandSuggestionAnchor.set({
      top: inputRect.bottom - wrapperRect.top + 8,
      left: inputRect.left - wrapperRect.left + inputRect.width / 2,
      width: Math.max(160, width)
    });
    const currentIndex = this.commandSelectionIndex();
    if (currentIndex >= suggestions.length) {
      this.commandSelectionIndex.set(0);
    }
  });

  constructor() {
    this.syncMapNameFromRoot(this.rootNode().content);
  }

  ngOnInit(): void {
    if (typeof window !== "undefined") {
      window.addEventListener("resize", this.resizeListener);
      this.resizeListener();
      this.setupSystemPreferenceWatcher();
      if ((window as any).__TAURI_INTERNALS__) {
        import("@tauri-apps/api/app").then(({ getVersion }) =>
          getVersion().then(v => this.appVersion.set(`v${v}`))
        );
      }
    }
  }

  async checkForUpdates(): Promise<void> {
    this.isCheckingUpdates.set(true);
    await this.updaterService.manualCheck();
    this.isCheckingUpdates.set(false);
  }

  ngAfterViewInit(): void {
    queueMicrotask(() => {
      this.fitToScreen();
      this.centerCurrentSelection();
    });
  }

  ngOnDestroy(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", this.resizeListener);
    }
    if (this.systemPreferenceQuery && this.systemPreferenceListener) {
      if (
        typeof this.systemPreferenceQuery.removeEventListener === "function"
      ) {
        this.systemPreferenceQuery.removeEventListener(
          "change",
          this.systemPreferenceListener
        );
      } else {
        this.systemPreferenceQuery.removeListener(
          this.systemPreferenceListener
        );
      }
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    if (this.exportNoticeTimer) {
      clearTimeout(this.exportNoticeTimer);
    }
    this.focusEffectCleanup.destroy();
    this.viewportEffectCleanup.destroy();
    this.themeEffectCleanup.destroy();
  }

  toggleTheme(): void {
    this.setThemePreference(this.nextThemePreference());
  }

  themeAriaLabel(): string {
    const nextPreference = this.describeThemePreference(
      this.nextThemePreference()
    );
    return `Theme preference: ${this.describeThemePreference(
      this.themePreference()
    )}. Click to switch to ${nextPreference}.`;
  }

  themePreferenceLabel(): string {
    switch (this.themePreference()) {
      case "dark":
        return "Dark";
      case "light":
        return "Light";
      default:
        return "System";
    }
  }

  toggleFileMenu(event?: Event): void {
    event?.stopPropagation();
    const next = !this.fileMenuOpen();
    this.fileMenuOpen.set(next);
    if (!next) {
      this.exportMenuOpen.set(false);
    }
  }

  openExportMenu(): void {
    this.exportMenuOpen.set(true);
  }

  closeExportMenu(): void {
    this.exportMenuOpen.set(false);
  }

  toggleExportMenu(event: Event): void {
    event.stopPropagation();
    this.exportMenuOpen.update((open) => !open);
  }

  closeMenus(): void {
    if (this.fileMenuOpen()) {
      this.fileMenuOpen.set(false);
    }
    if (this.exportMenuOpen()) {
      this.exportMenuOpen.set(false);
    }
  }

  @HostListener("document:click", ["$event"])
  handleDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest(".file-menu")) {
      return;
    }
    this.closeMenus();
  }

  trackRecent(_: number, entry: RecentMapEntry): string {
    return `${entry.name}-${entry.openedAt}`;
  }

  triggerOpenDialog(): void {
    this.closeMenus();
    const input = this.importInput?.nativeElement;
    if (!input) {
      return;
    }
    input.value = "";
    input.click();
  }

  handleNewMap(): void {
    this.closeMenus();
    this.recordSnapshot();
    this.savedFilePath = null;
    this.hasNamedSave = false;
    this.runWithoutDirty(() => {
      const root = this.createRoot();
      this.rootNode.set(root);
      this.mapTitleText.set(root.content || "Mind Map");
      this.selectNode(root.id);
      this.viewport.set({
        offsetX: 0,
        offsetY: 0,
        scale: 1,
        userMoved: false
      });
      this.editingNodeId.set(null);
      this.bumpLayoutVersion();
    });
    this.enableAutoMapName();
    this.isSaved.set(false);
  }

  openRecentMap(entry: RecentMapEntry): void {
    this.closeMenus();
    this.recordSnapshot();
    this.loadMapFromTree(entry.tree, { mapName: entry.name, markSaved: true });
    this.storeRecentMap(entry.name, entry.tree);
    this.hasNamedSave = true;
  }

  async handleSave(): Promise<void> {
    this.closeMenus();
    if (!this.hasNamedSave) {
      await this.handleSaveAs();
      return;
    }
    const success = await this.persistCurrentMap(this.savedFilePath);
    if (success) {
      this.markMapSaved();
    }
  }

  async handleSaveAs(): Promise<void> {
    this.closeMenus();
    if (this.shouldUseTauri()) {
      const defaultFile = this.exportFilename("json");
      const filters = this.buildDialogFilters(defaultFile);
      const targetPath = await this.openTauriSaveDialog(defaultFile, filters);
      if (!targetPath) {
        return;
      }
      this.setMapName(this.extractFileName(targetPath), { manual: true });
      const success = await this.persistCurrentMap(targetPath);
      if (success) {
        this.hasNamedSave = true;
        this.markMapSaved();
      }
      return;
    }
    const proposed = prompt("Save map as:", this.mapName());
    if (proposed === null) {
      return;
    }
    const trimmed = proposed.trim();
    if (!trimmed) {
      return;
    }
    this.setMapName(trimmed, { manual: true });
    this.savedFilePath = null;
    const success = await this.persistCurrentMap();
    if (success) {
      this.hasNamedSave = true;
      this.markMapSaved();
    }
  }

  exportJsonFromMenu(): void {
    this.closeMenus();
    void this.exportJson();
  }

  exportSvgFromMenu(): void {
    this.closeMenus();
    void this.exportSvg();
  }

  exportFreeplaneFromMenu(): void {
    this.closeMenus();
    void this.exportFreeplane();
  }

  exportPngFromMenu(): void {
    this.closeMenus();
    void this.exportPng();
  }

  toggleAboutDialog(): void {
    this.closeMenus();
    this.aboutDialogOpen.update((open) => !open);
  }

  closeAboutDialog(): void {
    this.aboutDialogOpen.set(false);
  }

  applyCommandSuggestion(command: string): void {
    const editingId = this.editingNodeId();
    if (!editingId) {
      return;
    }
    const input = this.findInputRef(editingId);
    if (!input) {
      return;
    }
    input.value = command;
    this.updateNodeContent(editingId, command);
    this.autoSizeInput(editingId);
    input.focus();
    const suggestions = this.commandSuggestions();
    const index = suggestions.indexOf(command);
    this.commandSelectionIndex.set(index >= 0 ? index : 0);
  }

  private moveCommandSelection(delta: number): void {
    const suggestions = this.commandSuggestions();
    if (!suggestions.length) {
      this.commandSelectionIndex.set(0);
      return;
    }
    const count = suggestions.length;
    const current = this.commandSelectionIndex();
    const next = (current + delta + count) % count;
    this.commandSelectionIndex.set(next);
  }

  private describeThemePreference(pref: ThemePreference): string {
    switch (pref) {
      case "system":
        return "system (matches device setting)";
      case "dark":
        return "dark";
      default:
        return "light";
    }
  }

  private setThemePreference(preference: ThemePreference): void {
    if (this.themePreference() === preference) {
      return;
    }
    this.themePreference.set(preference);
    this.persistThemePreference(preference);
  }

  private nextThemePreference(): ThemePreference {
    const current = this.themePreference();
    const index = THEME_CYCLE.indexOf(current);
    const nextIndex = index >= 0 ? (index + 1) % THEME_CYCLE.length : 0;
    return THEME_CYCLE[nextIndex];
  }

  private restoreThemePreference(): ThemePreference {
    if (!this.canUseStorage()) {
      return "system";
    }
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "dark" || stored === "light" || stored === "system") {
        return stored;
      }
    } catch (error) {
      console.warn("Failed to restore theme preference", error);
    }
    return "system";
  }

  private persistThemePreference(preference: ThemePreference): void {
    if (!this.canUseStorage()) {
      return;
    }
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch (error) {
      console.warn("Failed to persist theme preference", error);
    }
  }

  private detectSystemPrefersDark(): boolean {
    if (typeof window === "undefined" || !window.matchMedia) {
      return true;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  private setupSystemPreferenceWatcher(): void {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    this.systemPreferenceQuery = window.matchMedia(
      "(prefers-color-scheme: dark)"
    );
    this.systemPrefersDark.set(this.systemPreferenceQuery.matches);
    this.systemPreferenceListener = (event: MediaQueryListEvent) => {
      this.systemPrefersDark.set(event.matches);
    };
    if (typeof this.systemPreferenceQuery.addEventListener === "function") {
      this.systemPreferenceQuery.addEventListener(
        "change",
        this.systemPreferenceListener
      );
    } else {
      this.systemPreferenceQuery.addListener(this.systemPreferenceListener);
    }
  }

  onCanvasClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    this.closeMenus();
    if (target.closest(".node, .control-panel")) {
      return;
    }
    if (this.editingNodeId()) {
      this.commitEditing();
    }
  }

  onNodeClick(event: MouseEvent, nodeId: string): void {
    event.stopPropagation();
    if (this.editingNodeId() && this.selectedNodeId() !== nodeId) {
      this.commitEditing();
    }
    this.selectNode(nodeId, event.shiftKey);
  }

  onCanvasPointerDown(event: MouseEvent): void {
    if (event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest(".node, .control-panel")) {
      return;
    }
    this.isDragging.set(true);
    this.lastPointer = { x: event.clientX, y: event.clientY };
    event.preventDefault();
  }

  onCanvasPointerLeave(): void {
    this.isDragging.set(false);
  }

  @HostListener("window:mousemove", ["$event"])
  onPointerMove(event: MouseEvent): void {
    if (!this.isDragging()) {
      return;
    }
    const dx = event.clientX - this.lastPointer.x;
    const dy = event.clientY - this.lastPointer.y;
    this.viewport.update((view) => ({
      offsetX: view.offsetX + dx,
      offsetY: view.offsetY + dy,
      scale: view.scale,
      userMoved: true
    }));
    this.lastPointer = { x: event.clientX, y: event.clientY };
  }

  @HostListener("window:mouseup")
  onPointerUp(): void {
    this.isDragging.set(false);
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    const zoomFactor = Math.exp(-event.deltaY * MOUSE_ZOOM_SENSITIVITY);
    const eased = 1 + (zoomFactor - 1) * 0.85;
    this.applyZoom(eased, event.clientX, event.clientY);
  }

  centerCurrentSelection(): void {
    const node = this.layout().nodes.find(
      (n) => n.id === this.selectedNodeId()
    );
    if (!node) {
      return;
    }
    this.centerOnNode(node, this.viewport().scale);
  }

  fitToScreen(): void {
    const snapshot = this.layout();
    if (!snapshot.nodes.length) {
      return;
    }
    const bounds = snapshot.nodes.reduce(
      (acc, node) => {
        const height = this.nodeHeightFor(node.node);
        const top = node.y - height / 2;
        const bottom = node.y + height / 2;
        const left = node.x - this.nodeWidth / 2;
        const right = node.x + this.nodeWidth / 2;
        return {
          minX: Math.min(acc.minX, left),
          maxX: Math.max(acc.maxX, right),
          minY: Math.min(acc.minY, top),
          maxY: Math.max(acc.maxY, bottom)
        };
      },
      {
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity
      }
    );
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const padding = 80;
    const canvas = this.canvasSize();
    const scaleX = (canvas.width - padding * 2) / width;
    const scaleY = (canvas.height - padding * 2) / height;
    const scale = this.clampScale(Math.min(scaleX, scaleY));
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    this.viewport.set({
      offsetX: canvas.width / 2 - centerX * scale,
      offsetY: canvas.height / 2 - centerY * scale,
      scale,
      userMoved: false
    });
  }

  addChild(targetId = this.selectedNodeId(), startEditing = false): void {
    const parentInfo = this.findNode(targetId);
    if (!parentInfo) {
      return;
    }
    this.recordSnapshot();
    const newNode = this.createNode("", parentInfo.node.id);
    parentInfo.node.collapsed = false;
    parentInfo.node.children = [...parentInfo.node.children, newNode];
    this.bumpLayoutVersion();
    this.selectNode(newNode.id);
    if (startEditing) {
      this.beginEditing(newNode.id, true);
    }
  }

  addSibling(startEditing = false): void {
    const selectedId = this.selectedNodeId();
    const info = this.findNode(selectedId);
    if (!info) {
      return;
    }
    if (!info.parent) {
      this.addChild(selectedId, startEditing);
      return;
    }
    this.recordSnapshot();
    const parent = info.parent;
    const siblings = [...parent.children];
    const index = siblings.findIndex((child) => child.id === info.node.id);
    const newNode = this.createNode("", parent.id);
    siblings.splice(index + 1, 0, newNode);
    parent.children = siblings;
    this.bumpLayoutVersion();
    this.selectNode(newNode.id);
    if (startEditing) {
      this.beginEditing(newNode.id, true);
    }
  }

  deleteSelected(): void {
    const selectedIds = this.selectedNodeIds();

    // Only delete nodes whose parent is not also being deleted (avoids double-free)
    const toDelete = [...selectedIds].filter((id) => {
      const info = this.findNode(id);
      return info?.parent && !selectedIds.has(info.parent.id);
    });

    if (toDelete.length === 0) return;

    this.recordSnapshot();

    // Determine fallback selection before mutating the tree
    const primaryInfo = this.findNode(this.selectedNodeId());
    let fallback = this.rootNode().id;
    if (primaryInfo?.parent && !selectedIds.has(primaryInfo.parent.id)) {
      const siblings = primaryInfo.parent.children;
      const index = siblings.findIndex((c) => c.id === this.selectedNodeId());
      const next = siblings.slice(index + 1).find((s) => !selectedIds.has(s.id));
      const prev = siblings
        .slice(0, index)
        .reverse()
        .find((s) => !selectedIds.has(s.id));
      fallback = next?.id ?? prev?.id ?? primaryInfo.parent.id;
    }

    const deleteSet = new Set(toDelete);
    const removeNodes = (node: MindmapNode): void => {
      node.children = node.children.filter((c) => !deleteSet.has(c.id));
      node.children.forEach(removeNodes);
    };
    removeNodes(this.rootNode());

    this.bumpLayoutVersion();
    this.selectNode(fallback);
    this.editingNodeId.set(null);
  }

  beginEditing(nodeId: string, clearContent = false): void {
    const info = this.findNode(nodeId);
    if (!info) {
      return;
    }
    const node = info.node;
    this.selectNode(nodeId);
    this.editOriginal = node.content;
    this.shouldSelectAll = !clearContent;
    this.editingHistoryCaptured = false;
    this.editingNodeId.set(nodeId);
    if (clearContent) {
      this.updateNodeContent(nodeId, "");
    }
  }

  onNodeInput(nodeId: string, value: string): void {
    const limited = this.clampContent(value);
    if (limited !== value) {
      const input = this.findInputRef(nodeId);
      if (input) {
        input.value = limited;
      }
    }
    this.updateNodeContent(nodeId, limited);
    this.autoSizeInput(nodeId);
  }

  handleInlineInputKey(event: KeyboardEvent): void {
    const editingId = this.editingNodeId();
    if (!editingId) {
      return;
    }
    const inputEl = this.findInputRef(editingId);
    if (!inputEl) {
      return;
    }
    const value = inputEl.value ?? "";
    const trimmed = value.trim();
    const isCommand = value.startsWith("/");
    const commandHandler =
      trimmed in COMMANDS
        ? COMMANDS[trimmed as keyof typeof COMMANDS]
        : undefined;
    const suggestions = this.commandSuggestions();

    if (event.key === "ArrowDown" && suggestions.length) {
      event.preventDefault();
      this.moveCommandSelection(1);
      return;
    }

    if (event.key === "ArrowUp" && suggestions.length) {
      event.preventDefault();
      this.moveCommandSelection(-1);
      return;
    }

    if (event.key === "Tab") {
      if (isCommand) {
        const match = this.getCommandMatch(trimmed);
        if (match) {
          event.preventDefault();
          inputEl.value = match;
          this.updateNodeContent(editingId, match);
          this.autoSizeInput(editingId);
          return;
        }
      }
      event.preventDefault();
      this.commitEditing();
      this.addChild(this.selectedNodeId(), true);
      return;
    }

    if (event.key === "Enter") {
      if (suggestions.length) {
        const selected =
          suggestions[this.commandSelectionIndex()] ?? suggestions[0];
        if (selected && selected !== trimmed) {
          event.preventDefault();
          this.applyCommandSuggestion(selected);
          return;
        }
      }
      if (isCommand && commandHandler) {
        event.preventDefault();
        this.updateNodeContent(editingId, commandHandler());
        this.commitEditing();
        return;
      }
      event.preventDefault();
      this.commitEditing();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      this.cancelEditing();
    }
  }

  commitEditing(): void {
    if (!this.editingNodeId()) {
      return;
    }
    this.editingNodeId.set(null);
    this.editOriginal = "";
    this.shouldSelectAll = true;
    this.editingHistoryCaptured = false;
  }

  cancelEditing(): void {
    const editingId = this.editingNodeId();
    if (!editingId) {
      return;
    }
    this.updateNodeContent(editingId, this.editOriginal);
    this.editingNodeId.set(null);
    this.shouldSelectAll = true;
    this.editOriginal = "";
    this.editingHistoryCaptured = false;
  }

  private toggleCollapse(nodeId: string): void {
    const selectedIds = this.selectedNodeIds();
    const nodesToToggle =
      selectedIds.size > 1 && selectedIds.has(nodeId)
        ? [...selectedIds]
        : [nodeId];

    const hasAnyInfo = nodesToToggle.some((id) => this.findNode(id));
    if (!hasAnyInfo) return;

    this.recordSnapshot();

    for (const id of nodesToToggle) {
      const info = this.findNode(id);
      if (!info) continue;
      info.node.collapsed = !info.node.collapsed;
      if (info.node.collapsed) {
        const currentSelection = this.selectedNodeId();
        if (
          currentSelection !== id &&
          this.isDescendant(id, currentSelection)
        ) {
          this.selectNode(id);
        }
      }
    }

    this.bumpLayoutVersion();
  }

  onCollapseIndicatorClick(event: MouseEvent, nodeId: string): void {
    event.stopPropagation();
    this.toggleCollapse(nodeId);
  }

  @HostListener("window:keydown", ["$event"])
  handleKey(event: KeyboardEvent): void {
    if (this.aboutDialogOpen()) {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeAboutDialog();
      }
      return;
    }
    const inputTarget =
      event.target instanceof HTMLElement &&
      event.target.closest(
        "input, textarea, select, button, [contenteditable='true']"
      );
    if (inputTarget) {
      return;
    }

    if (this.fileMenuOpen()) {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeMenus();
      }
      return;
    }

    const modifier = event.metaKey || event.ctrlKey;
    if (modifier) {
      const lowerKey = event.key.toLowerCase();
      if (lowerKey === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          this.redo();
        } else {
          this.undo();
        }
        return;
      }
      switch (event.key) {
        case "ArrowUp":
          event.preventDefault();
          this.reorderSelectedWithinParent(-1);
          return;
        case "ArrowDown":
          event.preventDefault();
          this.reorderSelectedWithinParent(1);
          return;
        case "ArrowLeft":
          event.preventDefault();
          this.promoteSelectedNode();
          return;
        case "ArrowRight":
          event.preventDefault();
          this.demoteSelectedNode();
          return;
        case "0":
          event.preventDefault();
          this.fitToScreen();
          return;
        default:
          break;
      }
      if (lowerKey === "+" || lowerKey === "=") {
        event.preventDefault();
        this.applyZoom(KEYBOARD_ZOOM_IN);
        return;
      }
      if (lowerKey === "-") {
        event.preventDefault();
        this.applyZoom(KEYBOARD_ZOOM_OUT);
        return;
      }
      if (lowerKey === "c") {
        event.preventDefault();
        void this.copySelectedNode();
        return;
      }
      if (lowerKey === "v") {
        event.preventDefault();
        void this.pasteClipboardToSelected();
        return;
      }
      if (lowerKey === "s") {
        event.preventDefault();
        void this.handleSave();
        return;
      }
      return;
    }

    switch (event.key) {
      case "Enter":
        if (this.editingNodeId()) {
          event.preventDefault();
          this.commitEditing();
        } else {
          event.preventDefault();
          this.addSibling(true);
        }
        return;
      case "Tab":
        event.preventDefault();
        this.addChild(this.selectedNodeId(), true);
        return;
      case "Backspace":
        if (!this.editingNodeId()) {
          event.preventDefault();
          this.deleteSelected();
        }
        return;
      case "Escape":
        if (this.selectedNodeIds().size > 1) {
          event.preventDefault();
          this.selectedNodeIds.set(new Set([this.selectedNodeId()]));
          return;
        }
        if (this.editingNodeId()) {
          event.preventDefault();
          this.cancelEditing();
        }
        return;
      case "ArrowUp":
        event.preventDefault();
        this.moveBetweenSiblings(-1, event.shiftKey);
        return;
      case "ArrowDown":
        event.preventDefault();
        this.moveBetweenSiblings(1, event.shiftKey);
        return;
      case "ArrowLeft":
        event.preventDefault();
        this.goToParent();
        return;
      case "ArrowRight":
        event.preventDefault();
        this.goToFirstChild();
        return;
      case " ":
      case "Spacebar":
        event.preventDefault();
        this.toggleCollapse(this.selectedNodeId());
        return;
      case "F":
      case "f":
        if (event.shiftKey) {
          event.preventDefault();
          this.fitToScreen();
          return;
        }
        break;
      default:
        break;
    }

    if (
      event.key.length === 1 &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      event.preventDefault();
      const nodeId = this.selectedNodeId();
      this.beginEditing(nodeId, true);
      this.updateNodeContent(nodeId, event.key);
    }
  }

  private async copySelectedNode(): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      return;
    }
    const info = this.findNode(this.selectedNodeId());
    if (!info) {
      return;
    }
    const payload = JSON.stringify(this.cloneForClipboard(info.node), null, 2);
    try {
      await navigator.clipboard.writeText(payload);
    } catch (error) {
      console.error("Copy failed", error);
    }
  }

  private async pasteClipboardToSelected(): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
      return;
    }
    try {
      const raw = await navigator.clipboard.readText();
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      const node = this.rehydrateClipboardNode(parsed);
      if (!node) {
        return;
      }
      this.attachClipboardNode(node);
    } catch (error) {
      console.warn("Paste failed", error);
    }
  }

  private attachClipboardNode(node: MindmapNode): void {
    const target = this.findNode(this.selectedNodeId());
    if (!target) {
      return;
    }
    this.recordSnapshot();
    node.parentId = target.node.id;
    target.node.collapsed = false;
    target.node.children = [...target.node.children, node];
    this.bumpLayoutVersion();
    this.selectNode(node.id);
  }

  nodeHeightFor(node: MindmapNode): number {
    return this.calculateNodeHeight(node.content);
  }

  trackNode(_: number, item: LayoutNode): string {
    return item.id;
  }

  trackEdge(_: number, edge: LayoutEdge): string {
    return `${edge.from}-${edge.to}`;
  }

  nodeTransform(item: LayoutNode): string {
    const height = this.nodeHeightFor(item.node);
    const x = item.x - this.nodeWidth / 2;
    const y = item.y - height / 2;
    return `translate(${x}, ${y})`;
  }

  viewTransform(): string {
    const view = this.viewport();
    return `translate(${view.offsetX}, ${view.offsetY}) scale(${view.scale})`;
  }

  edgePath(edge: LayoutEdge): string {
    const dx = Math.max(40, Math.abs(edge.x2 - edge.x1) / 2);
    const c1x = edge.x1 + dx;
    const c2x = edge.x2 - dx;
    return `M ${edge.x1} ${edge.y1} C ${c1x} ${edge.y1}, ${c2x} ${edge.y2}, ${edge.x2} ${edge.y2}`;
  }

  handleImport(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string) as MindmapNode;
        const normalized = this.normalizeTree(parsed);
        const name = this.extractFileName(file.name);
        this.recordSnapshot();
        this.loadMapFromTree(normalized, { mapName: name, markSaved: true });
        this.savedFilePath = null;
        this.hasNamedSave = true;
        this.storeRecentMap(name, normalized);
      } catch (error) {
        console.error("Invalid mindmap JSON", error);
      }
    };
    reader.readAsText(file);
    input.value = "";
  }

  async exportJson(): Promise<void> {
    const dataStr = JSON.stringify(this.rootNode(), null, 2);
    await this.saveText(
      dataStr,
      this.exportFilename("json"),
      "application/json"
    );
  }

  async exportFreeplane(): Promise<void> {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<map version="freeplane 1.9.0">\n${this.buildFreeplaneNode(
      this.rootNode()
    )}\n</map>`;
    await this.saveText(xml, this.exportFilename("mm"), "application/xml");
  }

  async exportXMind(): Promise<void> {
    const root = this.rootNode();
    const sheetId = this.createId();
    const zip = new JSZip();
    const content = {
      sheets: [
        {
          id: sheetId,
          title: root.content || "Central Idea",
          rootTopic: this.buildXMindTopic(root)
        }
      ]
    };
    const metadata = {
      creator: "Mindmap MVP",
      created: new Date().toISOString(),
      appVersion: "1.0"
    };
    zip.file("content.json", JSON.stringify(content, null, 2));
    zip.file("metadata.json", JSON.stringify(metadata, null, 2));
    const blob = await zip.generateAsync({ type: "blob" });
    await this.saveBlob(blob, this.exportFilename("xmind"));
  }

  async exportPng(): Promise<void> {
    const payload = this.buildSvgExportPayload();
    if (!payload) {
      return;
    }
    const { markup, width, height } = payload;
    const dataUri = this.svgToDataUri(markup);
    const canvas = await this.drawSvgToCanvas(dataUri, width, height);
    if (!canvas) {
      return;
    }
    const blob = await this.canvasToBlob(canvas);
    if (blob) {
      await this.saveBlob(blob, this.exportFilename("png"));
    }
  }

  async exportSvg(): Promise<void> {
    const payload = this.buildSvgExportPayload();
    if (!payload) {
      return;
    }
    const blob = new Blob([payload.markup], {
      type: "image/svg+xml;charset=utf-8"
    });
    await this.saveBlob(blob, this.exportFilename("svg"));
  }

  private buildSvgExportPayload(): {
    markup: string;
    width: number;
    height: number;
  } | null {
    const bounds = this.computeContentBounds();
    if (!bounds) {
      return null;
    }
    const palette = this.getExportPalette();
    const svg = this.createExportSvg(bounds, palette);
    const markup = this.serializeSvg(svg);
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    return { markup, width, height };
  }

  private getExportPalette(): ExportPalette {
    return {
      nodeFill: "#ffffff",
      nodeStroke: "rgba(6,42,68,0.25)",
      nodeText: "#062a44",
      edgeColor: "rgba(6,42,68,0.4)",
      accent: "#f05f36"
    };
  }

  private createExportSvg(
    bounds: ContentBounds,
    palette: ExportPalette
  ): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("width", bounds.width.toString());
    svg.setAttribute("height", bounds.height.toString());
    svg.setAttribute(
      "viewBox",
      `${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`
    );
    svg.setAttribute("fill", "none");

    const layoutSnapshot = this.layout();
    const edgesGroup = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "g"
    );
    for (const edge of layoutSnapshot.edges) {
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path"
      );
      path.setAttribute("d", this.edgePath(edge));
      path.setAttribute("stroke", palette.edgeColor);
      path.setAttribute("stroke-width", "2");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("fill", "none");
      edgesGroup.appendChild(path);
    }
    svg.appendChild(edgesGroup);

    const nodesGroup = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "g"
    );
    for (const item of layoutSnapshot.nodes) {
      const rect = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "rect"
      );
      const nodeHeight = this.nodeHeightFor(item.node);
      const x = item.x - this.nodeWidth / 2;
      const y = item.y - nodeHeight / 2;
      rect.setAttribute("x", x.toString());
      rect.setAttribute("y", y.toString());
      rect.setAttribute("width", this.nodeWidth.toString());
      rect.setAttribute("height", nodeHeight.toString());
      rect.setAttribute("rx", "18");
      rect.setAttribute("ry", "18");
      rect.setAttribute("fill", palette.nodeFill);
      rect.setAttribute("stroke", palette.nodeStroke);
      rect.setAttribute("stroke-width", "2");
      nodesGroup.appendChild(rect);

      const textEl = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "text"
      );
      textEl.setAttribute("x", item.x.toString());
      textEl.setAttribute("y", item.y.toString());
      textEl.setAttribute("fill", palette.nodeText || "#062a44");
      textEl.setAttribute("font-size", `${EXPORT_FONT_SIZE}`);
      textEl.setAttribute("font-weight", "600");
      textEl.setAttribute("letter-spacing", "0.01em");
      textEl.setAttribute(
        "font-family",
        "Inter, 'Segoe UI', 'Helvetica Neue', sans-serif"
      );
      textEl.setAttribute("text-anchor", "middle");
      textEl.setAttribute("dominant-baseline", "middle");
      const lines = this.buildExportLines(item.node.content);
      const totalHeight =
        lines.length > 0 ? (lines.length - 1) * EXPORT_LINE_HEIGHT : 0;
      const startY = item.y - totalHeight / 2;
      lines.forEach((line, index) => {
        const tspan = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "tspan"
        );
        tspan.setAttribute("x", item.x.toString());
        const lineY = startY + index * EXPORT_LINE_HEIGHT;
        tspan.setAttribute("y", lineY.toString());
        tspan.textContent = line || " ";
        textEl.appendChild(tspan);
      });
      nodesGroup.appendChild(textEl);

      if (item.node.children.length && item.node.collapsed) {
        const indicator = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "circle"
        );
        const cx = x + this.nodeWidth - 18;
        const cy = item.y;
        indicator.setAttribute("cx", cx.toString());
        indicator.setAttribute("cy", cy.toString());
        indicator.setAttribute("r", "10");
        indicator.setAttribute("fill", palette.nodeFill);
        indicator.setAttribute("stroke", palette.accent);
        indicator.setAttribute("stroke-width", "2");
        nodesGroup.appendChild(indicator);
      }
    }

    svg.appendChild(nodesGroup);
    return svg;
  }

  private buildExportLines(content: string): string[] {
    const text = content && content.trim().length > 0 ? content.trim() : "";
    const paragraphs = text.split(/\n+/);
    const lines: string[] = [];
    for (const paragraph of paragraphs) {
      const clean = paragraph.trim();
      if (!clean) {
        lines.push("");
        continue;
      }
      const words = clean.split(/\s+/);
      let current = "";
      for (const word of words) {
        if (!current.length) {
          current = word;
          continue;
        }
        if ((current + " " + word).length > AVERAGE_CHARS_PER_LINE) {
          lines.push(current);
          current = word;
        } else {
          current += ` ${word}`;
        }
      }
      if (current.length) {
        lines.push(current);
      }
    }
    return lines.length ? lines : [""];
  }

  private drawSvgToCanvas(
    dataUri: string,
    width: number,
    height: number
  ): Promise<HTMLCanvasElement | null> {
    return new Promise((resolve) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => {
        const drawingSurface = document.createElement("canvas");
        drawingSurface.width = width;
        drawingSurface.height = height;
        const context = drawingSurface.getContext("2d");
        if (!context) {
          resolve(null);
          return;
        }
        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        resolve(drawingSurface);
      };
      image.onerror = () => resolve(null);
      image.src = dataUri;
    });
  }

  private serializeSvg(svg: SVGSVGElement): string {
    const serializer = new XMLSerializer();
    const markup = serializer.serializeToString(svg);
    return markup.startsWith("<?xml")
      ? markup
      : `<?xml version="1.0" encoding="UTF-8"?>\n${markup}`;
  }

  private svgToDataUri(markup: string): string {
    const encoded = encodeURIComponent(markup)
      .replace(/'/g, "%27")
      .replace(/"/g, "%22");
    return `data:image/svg+xml;charset=utf-8,${encoded}`;
  }

  private selectNode(id: string, addToSelection = false): void {
    this.selectedNodeId.set(id);
    if (addToSelection) {
      this.selectedNodeIds.update((ids) => new Set([...ids, id]));
    } else {
      this.selectedNodeIds.set(new Set([id]));
    }
  }

  private moveBetweenSiblings(offset: number, addToSelection = false): void {
    const info = this.findNode(this.selectedNodeId());
    if (!info?.parent) {
      return;
    }
    const siblings = info.parent.children;
    const index = siblings.findIndex((child) => child.id === info.node.id);
    const next = siblings[index + offset];
    if (next) {
      this.selectNode(next.id, addToSelection);
    }
  }

  private goToParent(): void {
    const info = this.findNode(this.selectedNodeId());
    if (info?.parent) {
      this.selectNode(info.parent.id);
    }
  }

  private goToFirstChild(): void {
    const info = this.findNode(this.selectedNodeId());
    if (!info || info.node.collapsed) {
      return;
    }
    const child = info.node.children[0];
    if (child) {
      this.selectNode(child.id);
    }
  }

  private reorderSelectedWithinParent(offset: number): void {
    const primaryInfo = this.findNode(this.selectedNodeId());
    if (!primaryInfo?.parent) return;

    const parent = primaryInfo.parent;
    const siblings = [...parent.children];
    const selectedIds = this.selectedNodeIds();

    const selectedIndices = siblings
      .map((s, i) => (selectedIds.has(s.id) ? i : -1))
      .filter((i) => i >= 0);

    if (selectedIndices.length === 0) return;

    const minIndex = Math.min(...selectedIndices);
    const maxIndex = Math.max(...selectedIndices);

    if (offset > 0 && maxIndex >= siblings.length - 1) return;
    if (offset < 0 && minIndex <= 0) return;

    this.recordSnapshot();

    if (offset > 0) {
      for (let i = selectedIndices.length - 1; i >= 0; i--) {
        const idx = selectedIndices[i];
        if (idx < siblings.length - 1 && !selectedIds.has(siblings[idx + 1].id)) {
          [siblings[idx], siblings[idx + 1]] = [siblings[idx + 1], siblings[idx]];
        }
      }
    } else {
      for (let i = 0; i < selectedIndices.length; i++) {
        const idx = selectedIndices[i];
        if (idx > 0 && !selectedIds.has(siblings[idx - 1].id)) {
          [siblings[idx], siblings[idx - 1]] = [siblings[idx - 1], siblings[idx]];
        }
      }
    }

    parent.children = siblings;
    this.bumpLayoutVersion();
  }

  private promoteSelectedNode(): void {
    const info = this.findNode(this.selectedNodeId());
    if (!info?.parent) {
      return;
    }
    const parentInfo = this.findNode(info.parent.id);
    if (!parentInfo?.parent) {
      return;
    }
    this.recordSnapshot();
    const parent = info.parent;
    const grandparent = parentInfo.parent;
    parent.children = parent.children.filter(
      (child) => child.id !== info.node.id
    );
    const grandSiblings = [...grandparent.children];
    const insertIndex = grandSiblings.findIndex(
      (child) => child.id === parent.id
    );
    const position = insertIndex >= 0 ? insertIndex + 1 : grandSiblings.length;
    grandSiblings.splice(position, 0, info.node);
    grandparent.children = grandSiblings;
    info.node.parentId = grandparent.id;
    this.bumpLayoutVersion();
  }

  private demoteSelectedNode(): void {
    const info = this.findNode(this.selectedNodeId());
    if (!info?.parent) {
      return;
    }
    const parent = info.parent;
    const siblings = [...parent.children];
    const index = siblings.findIndex((child) => child.id === info.node.id);
    const previous = siblings[index - 1];
    if (!previous) {
      return;
    }
    this.recordSnapshot();
    siblings.splice(index, 1);
    parent.children = siblings;
    previous.collapsed = false;
    previous.children = [...previous.children, info.node];
    info.node.parentId = previous.id;
    this.bumpLayoutVersion();
  }

  private prepareHistoryForContentChange(nodeId: string): void {
    if (this.editingNodeId() === nodeId) {
      if (!this.editingHistoryCaptured) {
        this.recordSnapshot();
        this.editingHistoryCaptured = true;
      }
    } else {
      this.recordSnapshot();
    }
  }

  private updateNodeContent(nodeId: string, content: string): void {
    const info = this.findNode(nodeId);
    if (!info) {
      return;
    }
    const normalized = this.clampContent(content);
    if (info.node.content === normalized) {
      return;
    }
    this.prepareHistoryForContentChange(nodeId);
    info.node.content = normalized;
    if (nodeId === this.rootNode().id) {
      const title = normalized || "Mind Map";
      this.mapTitleText.set(title);
      this.syncMapNameFromRoot(title);
    }
    this.bumpLayoutVersion();
  }

  private bumpLayoutVersion(): void {
    this.layoutVersion.update((value) => value + 1);
    if (!this.suppressDirty) {
      this.isSaved.set(false);
    }
    this.schedulePersist();
  }

  private computeLayout(root: MindmapNode): LayoutResult {
    const positions = new Map<string, LayoutNode>();
    let cursorY = 0;

    const assign = (
      node: MindmapNode,
      depth: number,
      parentId?: string
    ): { top: number; bottom: number; center: number } => {
      const height = this.nodeHeightFor(node);
      const visibleChildren = node.collapsed ? [] : node.children;
      let center: number;
      let top: number;
      let bottom: number;

      if (visibleChildren.length === 0) {
        top = cursorY;
        center = top + height / 2;
        bottom = top + height;
      } else {
        const childBounds = visibleChildren.map((child) =>
          assign(child, depth + 1, node.id)
        );
        top = childBounds[0].top;
        bottom = childBounds[childBounds.length - 1].bottom;
        center =
          (childBounds[0].center + childBounds[childBounds.length - 1].center) /
          2;
        const nodeTop = center - height / 2;
        const nodeBottom = center + height / 2;
        top = Math.min(top, nodeTop);
        bottom = Math.max(bottom, nodeBottom);
      }
      cursorY = Math.max(cursorY, bottom + this.spacingForNode(node));

      const x = depth * H_SPACING;
      positions.set(node.id, {
        id: node.id,
        node,
        parentId,
        depth,
        x,
        y: center
      });
      return { top, bottom, center };
    };

    assign(root, 0);
    const values = Array.from(positions.values());
    const edges: LayoutEdge[] = values
      .filter((item) => !!item.parentId)
      .map((item) => {
        const parent = positions.get(item.parentId!);
        if (!parent) {
          return { from: "", to: item.id, x1: 0, y1: 0, x2: 0, y2: 0 };
        }
        return {
          from: parent.id,
          to: item.id,
          x1: parent.x + this.nodeWidth / 2,
          y1: parent.y,
          x2: item.x - this.nodeWidth / 2,
          y2: item.y
        };
      })
      .filter((edge) => edge.from);

    return { nodes: values, edges };
  }

  private computeContentBounds(padding = 48): ContentBounds | null {
    const snapshot = this.layout();
    if (!snapshot.nodes.length) {
      return null;
    }
    const rawBounds = snapshot.nodes.reduce(
      (acc, item) => {
        const height = this.nodeHeightFor(item.node);
        const halfWidth = this.nodeWidth / 2;
        const halfHeight = height / 2;
        const left = item.x - halfWidth;
        const right = item.x + halfWidth;
        const top = item.y - halfHeight;
        const bottom = item.y + halfHeight;
        return {
          minX: Math.min(acc.minX, left),
          maxX: Math.max(acc.maxX, right),
          minY: Math.min(acc.minY, top),
          maxY: Math.max(acc.maxY, bottom)
        };
      },
      {
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity
      }
    );
    const minX = rawBounds.minX - padding;
    const minY = rawBounds.minY - padding;
    const maxX = rawBounds.maxX + padding;
    const maxY = rawBounds.maxY + padding;
    return {
      minX,
      minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  private loadMapFromTree(
    tree: MindmapNode,
    options: { mapName?: string; markSaved?: boolean } = {}
  ): void {
    const normalized = this.normalizeTree(tree);
    this.runWithoutDirty(() => {
      this.rootNode.set(normalized);
      this.mapTitleText.set(normalized.content || "Mind Map");
      this.selectNode(normalized.id);
      this.editingNodeId.set(null);
      this.viewport.set({
        offsetX: 0,
        offsetY: 0,
        scale: 1,
        userMoved: false
      });
      this.bumpLayoutVersion();
    });
    if (options.mapName) {
      this.setMapName(options.mapName, { manual: true });
    } else {
      this.enableAutoMapName();
    }
    if (options.markSaved) {
      this.isSaved.set(true);
      if (options.mapName) {
        this.hasNamedSave = true;
      }
    } else {
      this.isSaved.set(false);
    }
    this.centerCurrentSelection();
  }

  private runWithoutDirty(callback: () => void): void {
    const previous = this.suppressDirty;
    this.suppressDirty = true;
    try {
      callback();
    } finally {
      this.suppressDirty = previous;
    }
  }

  private findNode(
    nodeId: string,
    current: MindmapNode = this.rootNode(),
    parent?: MindmapNode
  ): { node: MindmapNode; parent?: MindmapNode } | undefined {
    if (current.id === nodeId) {
      return { node: current, parent };
    }
    for (const child of current.children) {
      const result = this.findNode(nodeId, child, current);
      if (result) {
        return result;
      }
    }
    return undefined;
  }

  private isDescendant(ancestorId: string, targetId: string): boolean {
    if (ancestorId === targetId) {
      return true;
    }
    const info = this.findNode(ancestorId);
    if (!info) {
      return false;
    }
    const stack = [...info.node.children];
    while (stack.length > 0) {
      const candidate = stack.pop()!;
      if (candidate.id === targetId) {
        return true;
      }
      stack.push(...candidate.children);
    }
    return false;
  }

  private cloneForClipboard(node: MindmapNode): ClipboardNode {
    return {
      id: node.id,
      content: node.content,
      collapsed: node.collapsed,
      children: node.children.map((child) => this.cloneForClipboard(child))
    };
  }

  private rehydrateClipboardNode(
    payload: unknown,
    parentId?: string
  ): MindmapNode | null {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const candidate = payload as ClipboardNode;
    const id = this.createId();
    const content =
      typeof candidate.content === "string" &&
      candidate.content.trim().length > 0
        ? candidate.content
        : "Pasted Thought";
    const normalized = this.clampContent(content);
    const children = Array.isArray(candidate.children)
      ? candidate.children
          .map((child) => this.rehydrateClipboardNode(child, id))
          .filter((child): child is MindmapNode => !!child)
      : [];
    return {
      id,
      content: normalized,
      parentId,
      children,
      collapsed: !!candidate.collapsed
    };
  }

  private calculateNodeHeight(content?: string): number {
    const text = content && content.trim().length > 0 ? content : "";
    const paragraphs = text.split(/\n+/);
    const totalLines = paragraphs.reduce((sum, paragraph) => {
      const clean = paragraph.trim();
      if (!clean) {
        return sum + 1;
      }
      const words = clean.split(/\s+/);
      let currentLine = 0;
      let lines = 1;
      for (const word of words) {
        const length = word.length;
        if (currentLine === 0) {
          currentLine = length;
          continue;
        }
        if (currentLine + length + 1 > AVERAGE_CHARS_PER_LINE) {
          lines += 1;
          currentLine = length;
        } else {
          currentLine += length + 1;
        }
      }
      return sum + lines;
    }, 0);
    const clampedLines = Math.max(1, totalLines);
    const computed = NODE_VERTICAL_PADDING + clampedLines * NODE_LINE_HEIGHT;
    return Math.max(NODE_MIN_HEIGHT, computed);
  }

  private spacingForNode(node: MindmapNode): number {
    const height = this.nodeHeightFor(node);
    const extraHeight = Math.max(0, height - NODE_MIN_HEIGHT);
    const adaptivePadding = Math.min(160, extraHeight * 0.35);
    const compactBaseline = Math.max(28, V_SPACING - 16);
    return compactBaseline + adaptivePadding;
  }

  private storeRecentMap(name: string, tree: MindmapNode): void {
    const entry: RecentMapEntry = {
      id: this.createId(),
      name: name || DEFAULT_MAP_NAME,
      tree: this.cloneTree(tree),
      openedAt: Date.now()
    };
    this.recentMaps.update((current) => {
      const filtered = current.filter((item) => item.name !== entry.name);
      const updated = [entry, ...filtered].slice(0, RECENT_LIMIT);
      this.persistRecentMaps(updated);
      return updated;
    });
  }

  private markMapSaved(): void {
    this.isSaved.set(true);
    this.storeRecentMap(this.mapName(), this.rootNode());
  }

  private persistRecentMaps(entries: RecentMapEntry[]): void {
    if (!this.canUseStorage()) {
      return;
    }
    try {
      const payload = entries.map((entry) => ({
        name: entry.name,
        openedAt: entry.openedAt,
        tree: entry.tree
      }));
      window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(payload));
    } catch (error) {
      console.warn("Failed to persist recent maps", error);
    }
  }

  private normalizeTree(node: MindmapNode, parentId?: string): MindmapNode {
    const id = node.id || this.createId();
    return {
      id,
      content: this.clampContent(node.content ?? ""),
      parentId,
      collapsed: !!node.collapsed,
      children: (node.children ?? []).map((child) =>
        this.normalizeTree(child, id)
      )
    };
  }

  private createRoot(): MindmapNode {
    return {
      id: this.createId(),
      content: "",
      children: [],
      collapsed: false
    };
  }

  private restoreRecentMaps(): RecentMapEntry[] {
    if (!this.canUseStorage()) {
      return [];
    }
    try {
      const raw = window.localStorage.getItem(RECENTS_STORAGE_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw) as Array<{
        name: string;
        openedAt: number;
        tree: MindmapNode;
      }>;
      return parsed.slice(0, RECENT_LIMIT).map((item) => ({
        id: this.createId(),
        name: item.name || DEFAULT_MAP_NAME,
        openedAt: item.openedAt ?? Date.now(),
        tree: this.normalizeTree(item.tree)
      }));
    } catch (error) {
      console.warn("Failed to restore recent maps", error);
      return [];
    }
  }

  private createNode(content: string, parentId?: string): MindmapNode {
    return {
      id: this.createId(),
      content: this.clampContent(content),
      parentId,
      children: [],
      collapsed: false
    };
  }

  private createId(): string {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `node-${Math.random().toString(36).slice(2, 9)}`;
  }

  private setMapName(name: string, options: { manual?: boolean } = {}): void {
    const normalized = name.trim() || DEFAULT_MAP_NAME;
    if (options.manual) {
      this.mapNameFollowsRoot.set(false);
    }
    this.mapName.set(normalized);
    this.persistMapName(normalized);
    this.persistMapNameAutoFlag(this.mapNameFollowsRoot());
  }

  private enableAutoMapName(): void {
    this.mapNameFollowsRoot.set(true);
    this.persistMapNameAutoFlag(true);
    this.syncMapNameFromRoot(this.mapTitleText());
  }

  private syncMapNameFromRoot(content?: string | null): void {
    if (!this.mapNameFollowsRoot()) {
      return;
    }
    const nextName =
      content && content.toString().trim().length > 0
        ? content.toString().trim()
        : DEFAULT_MAP_NAME;
    this.setMapName(nextName);
  }

  private persistMapName(name: string): void {
    if (!this.canUseStorage()) {
      return;
    }
    try {
      window.localStorage.setItem(MAP_NAME_STORAGE_KEY, name);
    } catch (error) {
      console.warn("Failed to persist map name", error);
    }
  }

  private persistMapNameAutoFlag(follows: boolean): void {
    if (!this.canUseStorage()) {
      return;
    }
    try {
      window.localStorage.setItem(
        MAP_NAME_AUTO_STORAGE_KEY,
        follows ? "1" : "0"
      );
    } catch (error) {
      console.warn("Failed to persist map naming preference", error);
    }
  }

  private restoreMapName(): string {
    if (!this.canUseStorage()) {
      return DEFAULT_MAP_NAME;
    }
    try {
      const stored = window.localStorage.getItem(MAP_NAME_STORAGE_KEY);
      return stored?.trim().length ? stored : DEFAULT_MAP_NAME;
    } catch (error) {
      console.warn("Failed to restore map name", error);
      return DEFAULT_MAP_NAME;
    }
  }

  private restoreMapNameAutoFlag(): boolean {
    if (!this.canUseStorage()) {
      return true;
    }
    try {
      const stored = window.localStorage.getItem(MAP_NAME_AUTO_STORAGE_KEY);
      if (stored === "0") {
        return false;
      }
      return true;
    } catch (error) {
      console.warn("Failed to restore map naming preference", error);
      return true;
    }
  }

  private extractFileName(rawName?: string): string {
    if (!rawName) {
      return DEFAULT_MAP_NAME;
    }
    const basename = rawName.split(/[/\\]/).pop() ?? rawName;
    const withoutExt = basename.replace(/\.[^/.]+$/, "");
    return withoutExt.trim().length ? withoutExt : DEFAULT_MAP_NAME;
  }

  private getCommandMatches(input: string): string[] {
    return Object.keys(COMMANDS).filter((cmd) => cmd.startsWith(input));
  }

  private getCommandMatch(input: string): string | null {
    const matches = this.getCommandMatches(input);
    return matches.length === 1 ? matches[0] : null;
  }

  private findInputRef(id: string): HTMLTextAreaElement | undefined {
    const refs = this.nodeInputs?.toArray() ?? [];
    const match = refs.find(
      (ref) => ref.nativeElement.dataset["nodeId"] === id
    );
    return match?.nativeElement;
  }

  private autoSizeInput(nodeId: string): void {
    queueMicrotask(() => {
      const input = this.findInputRef(nodeId);
      if (!input) {
        return;
      }
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    });
  }

  private isNodeOffscreen(
    node: LayoutNode,
    viewport: ViewportState,
    canvas: { width: number; height: number }
  ): boolean {
    const centerX = node.x * viewport.scale + viewport.offsetX;
    const centerY = node.y * viewport.scale + viewport.offsetY;
    const halfWidth = (this.nodeWidth / 2) * viewport.scale;
    const halfHeight = (this.nodeHeightFor(node.node) / 2) * viewport.scale;
    const margin = 40;
    const left = centerX - halfWidth;
    const right = centerX + halfWidth;
    const top = centerY - halfHeight;
    const bottom = centerY + halfHeight;
    return (
      right < -margin ||
      left > canvas.width + margin ||
      bottom < -margin ||
      top > canvas.height + margin
    );
  }

  private centerOnNode(node: LayoutNode, scale: number): void {
    const size = this.canvasSize();
    this.viewport.set({
      offsetX: size.width / 2 - node.x * scale,
      offsetY: size.height / 2 - node.y * scale,
      scale,
      userMoved: false
    });
  }

  private applyZoom(
    multiplier: number,
    clientX?: number,
    clientY?: number
  ): void {
    const wrapper = this.canvasWrapper?.nativeElement;
    const rect = wrapper?.getBoundingClientRect();
    this.viewport.update((view) => {
      const scale = this.clampScale(view.scale * multiplier);
      if (scale === view.scale) {
        return view;
      }
      const cx =
        clientX !== undefined && rect
          ? clientX - rect.left
          : this.canvasSize().width / 2;
      const cy =
        clientY !== undefined && rect
          ? clientY - rect.top
          : this.canvasSize().height / 2;
      const worldX = (cx - view.offsetX) / view.scale;
      const worldY = (cy - view.offsetY) / view.scale;
      const offsetX = cx - worldX * scale;
      const offsetY = cy - worldY * scale;
      return { offsetX, offsetY, scale, userMoved: true };
    });
  }

  private clampScale(value: number): number {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
  }

  private buildFreeplaneNode(node: MindmapNode): string {
    const children = node.children
      .map((child) => this.buildFreeplaneNode(child))
      .join("\n");
    const text = this.escapeXml(node.content || "");
    const idAttr = this.escapeXml(node.id);
    return `<node TEXT="${text}" ID="${idAttr}">${children}</node>`;
  }

  private buildXMindTopic(node: MindmapNode): XMindTopic {
    const topic: XMindTopic = {
      id: node.id,
      title: node.content || ""
    };
    if (node.children.length) {
      topic.children = {
        attached: node.children.map((child) => this.buildXMindTopic(child))
      };
    }
    return topic;
  }

  private escapeXml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  private async saveText(
    text: string,
    filename: string,
    mime: string
  ): Promise<void> {
    const blob = new Blob([text], { type: mime });
    await this.saveBlob(blob, filename);
  }

  private async persistCurrentMap(
    existingPath?: string | null
  ): Promise<boolean> {
    const json = JSON.stringify(this.rootNode(), null, 2);
    const fileBase = this.slugify(this.mapName()) || "mindmap";
    const blob = new Blob([json], { type: "application/json" });
    return this.saveBlob(blob, `${fileBase}.json`, {
      existingPath: existingPath ?? this.savedFilePath,
      toastLabel: `Saved ${fileBase}.json`,
      trackPath: true
    });
  }

  private async saveBlob(
    blob: Blob,
    filename: string,
    options?: {
      existingPath?: string | null;
      toastLabel?: string;
      trackPath?: boolean;
    }
  ): Promise<boolean> {
    const existingPath = options?.existingPath ?? null;
    console.log("Using Tauri:", this.shouldUseTauri());
    if (this.shouldUseTauri()) {
      const savedPath = await this.saveBlobWithTauri(
        blob,
        filename,
        existingPath
      );
      if (savedPath) {
        if (options?.trackPath) {
          this.savedFilePath = savedPath;
          this.hasNamedSave = true;
        }
        this.showExportNotice(
          options?.toastLabel ?? `Saved ${filename} to ${savedPath}`
        );
        return true;
      }
      return false;
    }
    this.downloadBlob(blob, filename);
    this.showExportNotice(options?.toastLabel ?? `Download ready: ${filename}`);
    if (options?.trackPath) {
      this.hasNamedSave = true;
      this.savedFilePath = null;
    }
    return true;
  }

  private async saveBlobWithTauri(
    blob: Blob,
    filename: string,
    existingPath: string | null = null
  ): Promise<string | null> {
    try {
      let targetPath = existingPath ?? null;
      if (!targetPath) {
        const filters = this.buildDialogFilters(filename);
        const selectedPath = await this.openTauriSaveDialog(filename, filters);
        if (!selectedPath) {
          return null;
        }
        targetPath = selectedPath;
      }
      const buffer = new Uint8Array(await blob.arrayBuffer());
      await writeFile(targetPath, buffer);
      return targetPath;
    } catch (error) {
      console.error("Tauri export failed", error);
      this.showExportNotice("Export failed. Please try again.");
      return null;
    }
  }

  private async openTauriSaveDialog(
    filename: string,
    filters?: { name: string; extensions: string[] }[]
  ): Promise<string | null> {
    try {
      return await save({
        defaultPath: filename,
        filters
      });
    } catch {
      const api = window.__TAURI__;
      if (!api?.dialog?.save) {
        return null;
      }
      try {
        return await api.dialog.save({
          defaultPath: filename,
          filters
        });
      } catch {
        return null;
      }
    }
  }

  private shouldUseTauri(): boolean {
    if (typeof window === "undefined") {
      return false;
    }
    const globalWindow = window as typeof window & {
      __TAURI_INTERNALS__?: unknown;
      __TAURI__?: unknown;
      TAURI?: unknown;
    };
    return Boolean(
      globalWindow.__TAURI_INTERNALS__ ||
        globalWindow.__TAURI__ ||
        (globalWindow as any).TAURI
    );
  }

  private canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/png");
    });
  }

  private exportFilename(ext: string): string {
    const base = this.slugify(this.mapTitleText());
    const safe = base || "mindmap";
    return `${safe}.${ext}`;
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  private buildDialogFilters(
    filename: string
  ): Array<{ name: string; extensions: string[] }> | undefined {
    const extension = this.getFileExtension(filename);
    if (!extension) {
      return undefined;
    }
    return [
      {
        name: `${extension.toUpperCase()} file`,
        extensions: [extension]
      }
    ];
  }

  private getFileExtension(filename: string): string | null {
    const parts = filename.split(".");
    if (parts.length < 2) {
      return null;
    }
    return parts.pop()?.toLowerCase() ?? null;
  }

  private showExportNotice(message: string): void {
    this.exportNotice.set(message);
    if (this.exportNoticeTimer) {
      clearTimeout(this.exportNoticeTimer);
    }
    const timer = setTimeout(() => {
      this.exportNotice.set(null);
      this.exportNoticeTimer = null;
    }, 4000);
    this.exportNoticeTimer = timer;
  }

  private slugify(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  private clampContent(value: string): string {
    if (!value) {
      return "";
    }
    if (value.length <= MAX_NODE_CHARS) {
      return value;
    }
    return value.slice(0, MAX_NODE_CHARS);
  }

  private captureSnapshot(): MindmapSnapshot {
    return {
      tree: this.cloneTree(this.rootNode()),
      selectedId: this.selectedNodeId(),
      viewport: { ...this.viewport() }
    };
  }

  private recordSnapshot(): void {
    if (this.suppressHistory) {
      return;
    }
    this.historyPast.push(this.captureSnapshot());
    if (this.historyPast.length > HISTORY_LIMIT) {
      this.historyPast.shift();
    }
    this.historyFuture = [];
  }

  private restoreSnapshot(snapshot: MindmapSnapshot): void {
    this.suppressHistory = true;
    this.runWithoutDirty(() => {
      this.rootNode.set(this.cloneTree(snapshot.tree));
      this.selectedNodeId.set(snapshot.selectedId);
      this.selectedNodeIds.set(new Set([snapshot.selectedId]));
      this.viewport.set({ ...snapshot.viewport });
      this.editingNodeId.set(null);
      this.layoutVersion.update((value) => value + 1);
      this.schedulePersist();
    });
    this.suppressHistory = false;
  }

  private undo(): void {
    if (!this.historyPast.length) {
      return;
    }
    const previous = this.historyPast.pop()!;
    const current = this.captureSnapshot();
    this.historyFuture.push(current);
    this.restoreSnapshot(previous);
  }

  private redo(): void {
    if (!this.historyFuture.length) {
      return;
    }
    const next = this.historyFuture.pop()!;
    const current = this.captureSnapshot();
    this.historyPast.push(current);
    this.restoreSnapshot(next);
  }

  private restoreInitialTree(): MindmapNode {
    if (!this.canUseStorage()) {
      return this.createRoot();
    }
    try {
      const cached = window.localStorage.getItem(STORAGE_KEY);
      if (!cached) {
        return this.createRoot();
      }
      const parsed = JSON.parse(cached) as MindmapNode;
      return this.normalizeTree(parsed);
    } catch (error) {
      console.warn("Failed to restore cached mind map", error);
      return this.createRoot();
    }
  }

  private schedulePersist(): void {
    if (!this.canUseStorage()) {
      return;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = window.setTimeout(
      () => this.persistTree(),
      PERSIST_DEBOUNCE
    );
  }

  private persistTree(): void {
    if (!this.canUseStorage()) {
      return;
    }
    try {
      const payload = JSON.stringify(this.rootNode());
      window.localStorage.setItem(STORAGE_KEY, payload);
    } catch (error) {
      console.warn("Failed to persist mind map", error);
    }
  }

  private canUseStorage(): boolean {
    return typeof window !== "undefined" && !!window.localStorage;
  }

  private cloneTree(node: MindmapNode, parentId?: string): MindmapNode {
    return {
      id: node.id,
      content: this.clampContent(node.content ?? ""),
      parentId: parentId ?? node.parentId,
      collapsed: !!node.collapsed,
      children: node.children.map((child) => this.cloneTree(child, node.id))
    };
  }
}
