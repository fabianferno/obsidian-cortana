// plugin/workspace-watcher.ts - feeds the workspace trail from Obsidian's events.
//
// Clicks into the Cortana panel or a sidebar (file explorer, outline) do not count:
// the note in the main area is still what the user is looking at.

import { FileView, MarkdownView, type App, type Plugin, type WorkspaceLeaf } from 'obsidian';
import { WorkspaceTrail, visibleSnapshot, type FileKind, type WorkspaceSnapshot } from '../workspace/trail.js';

const KINDS: Record<string, FileKind> = { markdown: 'note', kanban: 'board', canvas: 'canvas', pdf: 'pdf' };

export class WorkspaceWatcher {
  private trail = new WorkspaceTrail();

  constructor(private readonly app: App) {}

  register(plugin: Plugin): void {
    const ws = this.app.workspace;
    plugin.registerEvent(ws.on('active-leaf-change', (leaf) => this.track(leaf)));
    // A leaf that opens another file does not change the active leaf.
    plugin.registerEvent(ws.on('file-open', () => this.track(ws.getMostRecentLeaf())));
    plugin.registerEvent(ws.on('editor-change', (_editor, info) => {
      if (info.file) this.trail.typed(info.file.path);
    }));
    this.track(ws.getMostRecentLeaf());
  }

  snapshot(layout: { dailyFolder: string; boardPath: string }): WorkspaceSnapshot | null {
    let heading: string | undefined;
    let selection: string | undefined;
    const view = this.app.workspace.getMostRecentLeaf()?.view;
    if (view instanceof MarkdownView && view.file && view.file.path === this.trail.activePath && view.getMode() === 'source') {
      selection = view.editor.getSelection();
      const line = view.editor.getCursor().line;
      const headings = this.app.metadataCache.getFileCache(view.file)?.headings ?? [];
      heading = headings.filter(h => h.position.start.line <= line).pop()?.heading;
    }
    return visibleSnapshot(this.trail.snapshot(Date.now(), { heading, selection, obsidianFocused: activeDocument.hasFocus() }), layout);
  }

  private track(leaf: WorkspaceLeaf | null): void {
    if (!leaf) return;
    const ws = this.app.workspace;
    const root = leaf.getRoot();
    if (root === ws.leftSplit || root === ws.rightSplit) return;
    const view = leaf.view;
    if (view instanceof FileView && view.file) this.trail.open(view.file.path, KINDS[view.getViewType()] ?? 'other');
    else this.trail.open(null);
  }
}
