import './style.css';
import { createPane, type Pane } from './pane.js';
import { isValidDocId } from '../../protocol/index.js';

/** Presence colours. Kept as data, not Tailwind classes — Yjs stores them. */
const PANE_COLOURS = ['#38bdf8', '#f472b6', '#facc15'] as const;

function wsUrl(): string {
  const url = new URL('/ws', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function resolveDocId(): string {
  const requested = new URL(window.location.href).searchParams.get('doc') ?? 'demo';
  return isValidDocId(requested) ? requested : 'demo';
}

/**
 * Optional identity prefix (`?as=alice`).
 *
 * The e2e tests open the same document in two browser contexts and need each
 * one to be a distinguishable peer; without this they would both be
 * "client-a" and the presence assertions would be meaningless.
 */
function identityPrefix(): string | null {
  const requested = new URL(window.location.href).searchParams.get('as');
  if (requested === null) return null;
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(requested) ? requested : null;
}

function paneCount(): number {
  const requested = Number(
    new URL(window.location.href).searchParams.get('panes') ?? '2',
  );
  if (!Number.isInteger(requested) || requested < 1) return 2;
  return Math.min(requested, PANE_COLOURS.length);
}

async function main(): Promise<void> {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (app === null) throw new Error('#app is missing from index.html');

  const docId = resolveDocId();
  const count = paneCount();
  const identity = identityPrefix();

  app.className = 'flex h-full flex-col gap-3 p-3';
  app.innerHTML = `
    <header class="flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 class="text-sm font-semibold tracking-tight text-slate-100">collab-editor</h1>
      <p class="text-xs text-slate-400">
        document <code class="rounded bg-slate-800 px-1 py-0.5 text-slate-200" data-testid="doc-id">${docId}</code>
        — ${count} independent clients, one shared Yjs document.
        Type in either pane; take one offline and keep typing.
      </p>
    </header>
    <main id="panes" class="flex min-h-0 flex-1 flex-col gap-3 md:flex-row"></main>
    <footer class="shrink-0 text-xs text-slate-500">
      Each pane is its own <code>Y.Doc</code>, IndexedDB database and WebSocket
      connection. Offline state survives reload, so edits you make while offline
      come back from IndexedDB, not from the server.
    </footer>
  `;

  const host = app.querySelector<HTMLElement>('#panes');
  if (host === null) throw new Error('pane host missing');

  const panes: Pane[] = [];
  for (let index = 0; index < count; index += 1) {
    const letter = String.fromCharCode(65 + index);
    const name =
      identity === null
        ? `client-${letter.toLowerCase()}`
        : count === 1
          ? identity
          : `${identity}-${letter.toLowerCase()}`;
    try {
      const pane = await createPane({
        paneId: name,
        label: identity === null ? `Client ${letter}` : name,
        docId,
        userId: name,
        colour: PANE_COLOURS[index] ?? PANE_COLOURS[0],
        wsUrl: wsUrl(),
      });
      panes.push(pane);
      host.append(pane.element);
    } catch (err) {
      const failure = document.createElement('div');
      failure.className =
        'flex-1 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-xs text-rose-200';
      failure.dataset.testid = `pane-error-${letter.toLowerCase()}`;
      failure.textContent = `Client ${letter} failed to start: ${(err as Error).message}`;
      host.append(failure);
    }
  }

  window.addEventListener('beforeunload', () => {
    for (const pane of panes) pane.destroy();
  });
}

void main();
