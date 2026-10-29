import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { IndexeddbPersistence } from 'y-indexeddb';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { yCollab } from 'y-codemirror.next';
import { WebSocketProvider, type ConnectionStatus } from './provider.js';

export interface PaneOptions {
  /** Stable id: names the IndexedDB database and the offline-flag key. */
  paneId: string;
  label: string;
  docId: string;
  userId: string;
  colour: string;
  wsUrl: string;
  role?: 'read' | 'write';
}

export interface Pane {
  readonly options: PaneOptions;
  readonly doc: Y.Doc;
  readonly element: HTMLElement;
  readonly provider: WebSocketProvider;
  destroy(): void;
}

const STATUS_STYLES: Record<ConnectionStatus, string> = {
  offline: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  connecting: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  authenticating: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  synced: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  error: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
};

const offlineKey = (paneId: string): string => `collab-editor:offline:${paneId}`;

async function fetchToken(
  docId: string,
  userId: string,
  role: 'read' | 'write',
): Promise<string> {
  const res = await fetch(
    `/api/token?doc=${encodeURIComponent(docId)}&user=${encodeURIComponent(userId)}&role=${role}`,
  );
  if (!res.ok) {
    throw new Error(`token endpoint returned ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { token?: string };
  if (typeof body.token !== 'string') {
    throw new Error('token endpoint returned no token');
  }
  return body.token;
}

/**
 * One independent editor client, rendered as a panel.
 *
 * Two panes on one page are two genuinely separate clients: separate `Y.Doc`s,
 * separate client ids, separate IndexedDB databases and separate WebSocket
 * connections. Nothing is shared in memory, so convergence you can see in the
 * browser is the same convergence the headless tests assert.
 */
export async function createPane(options: PaneOptions): Promise<Pane> {
  const role = options.role ?? 'write';
  const doc = new Y.Doc();
  const text = doc.getText('body');
  const awareness = new Awareness(doc);
  awareness.setLocalStateField('user', {
    name: options.userId,
    color: options.colour,
    colorLight: `${options.colour}33`,
  });

  // Local-first: IndexedDB is loaded before the socket is opened, so a reload
  // shows your own edits immediately rather than after a round trip.
  const idb = new IndexeddbPersistence(
    `collab-editor:${options.docId}:${options.paneId}`,
    doc,
  );
  await idb.whenSynced;

  const startOffline =
    globalThis.localStorage?.getItem(offlineKey(options.paneId)) === '1';
  const token = await fetchToken(options.docId, options.userId, role);
  const undoManager = new Y.UndoManager(text);

  const provider = new WebSocketProvider({
    url: options.wsUrl,
    docId: options.docId,
    token,
    doc,
    awareness,
    startOffline,
  });

  const element = document.createElement('section');
  element.className =
    'flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-800 bg-slate-900/60';
  element.dataset.pane = options.paneId;

  const header = document.createElement('header');
  header.className =
    'flex shrink-0 items-center gap-3 border-b border-slate-800 px-3 py-2 text-xs';

  const dot = document.createElement('span');
  dot.className = 'size-2.5 shrink-0 rounded-full';
  dot.style.backgroundColor = options.colour;

  const title = document.createElement('span');
  title.className = 'font-medium text-slate-200';
  title.textContent = options.label;

  const status = document.createElement('span');
  status.className = 'rounded-full px-2 py-0.5 font-medium ring-1 ring-inset';
  status.dataset.testid = `status-${options.paneId}`;

  header.append(dot, title, status);

  const peers = document.createElement('span');
  peers.className = 'ml-auto truncate text-slate-400';
  peers.dataset.testid = `peers-${options.paneId}`;

  const offlineButton = document.createElement('button');
  offlineButton.type = 'button';
  offlineButton.className =
    'shrink-0 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 font-medium text-slate-200 hover:bg-slate-700';
  offlineButton.dataset.testid = `offline-${options.paneId}`;

  header.append(peers, offlineButton);

  const editorHost = document.createElement('div');
  editorHost.className = 'min-h-0 flex-1';
  editorHost.dataset.testid = `editor-${options.paneId}`;

  element.append(header, editorHost);

  const view = new EditorView({
    state: EditorState.create({
      doc: text.toString(),
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        yCollab(text, awareness, { undoManager }),
        EditorView.editable.of(role === 'write'),
        EditorView.theme({ '&': { backgroundColor: 'transparent' } }, { dark: true }),
      ],
    }),
    parent: editorHost,
  });

  const renderStatus = (next: ConnectionStatus, detail?: string): void => {
    status.className = `rounded-full px-2 py-0.5 font-medium ring-1 ring-inset ${STATUS_STYLES[next]}`;
    const pendingCount = provider.pendingCount;
    status.textContent =
      next === 'offline' && pendingCount > 0
        ? `offline · ${pendingCount} pending`
        : next;
    status.title = detail ?? '';
    offlineButton.textContent = provider.isOffline ? 'Go online' : 'Go offline';
  };

  const renderPeers = (): void => {
    const names = [...awareness.getStates().entries()]
      .filter(([clientId]) => clientId !== doc.clientID)
      .map(([, state]) => (state as { user?: { name?: string } }).user?.name)
      .filter((name): name is string => typeof name === 'string');
    peers.textContent = names.length === 0 ? 'no peers' : `with ${names.join(', ')}`;
  };

  provider.on('status', ({ status: next, detail }) => renderStatus(next, detail));
  provider.on('pending', () => renderStatus(provider.currentStatus));
  awareness.on('change', renderPeers);

  offlineButton.addEventListener('click', () => {
    const next = !provider.isOffline;
    provider.setOffline(next);
    // Remembered across reloads on purpose: it is what makes "reload while
    // offline" a thing you can actually try, and what the e2e test relies on
    // to prove the text came from IndexedDB rather than from the server.
    globalThis.localStorage?.setItem(offlineKey(options.paneId), next ? '1' : '0');
    renderStatus(provider.currentStatus);
  });

  renderStatus(provider.currentStatus);
  renderPeers();

  return {
    options,
    doc,
    element,
    provider,
    destroy: () => {
      view.destroy();
      provider.destroy();
      awareness.destroy();
      void idb.destroy();
      doc.destroy();
    },
  };
}
