import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';

/**
 * End-to-end: two real browsers on one document.
 *
 * The headless tests prove convergence of the data structure; these prove that
 * the editor binding, the provider, the server and IndexedDB are wired to each
 * other. They assert text that each browser actually rendered.
 */

/** A fresh document per test, so one run never inherits another's state. */
const newDocId = (): string => `e2e${randomBytes(6).toString('hex')}`;

async function openClient(
  context: BrowserContext,
  docId: string,
  as: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/?doc=${docId}&panes=1&as=${as}`);
  await expect(page.getByTestId('doc-id')).toHaveText(docId);
  await expect(page.getByTestId(`status-${as}`)).toHaveText('synced');
  return page;
}

const editor = (page: Page, as: string) =>
  page.getByTestId(`editor-${as}`).locator('.cm-content');

/**
 * The document text as this browser rendered it, with remote-cursor
 * decorations removed.
 *
 * `innerText` of `.cm-content` includes the peer-name labels that
 * `y-codemirror.next` draws inside the content element, plus the word-joiner
 * characters its caret widgets use. Those are presence, not document content,
 * so comparing two browsers' raw `innerText` compares whose caret is visible
 * rather than whether the documents agree.
 */
const docText = (page: Page, as: string): Promise<string> =>
  editor(page, as).evaluate((node) => {
    const clone = node.cloneNode(true) as HTMLElement;
    for (const label of clone.querySelectorAll('.cm-ySelectionInfo')) {
      label.remove();
    }
    return [...clone.querySelectorAll('.cm-line')]
      .map((line) => line.textContent ?? '')
      .join('\n')
      .replace(/[\u200b\u2060\ufeff]/g, '');
  });

/** Wait until both browsers render the same document text. */
async function expectSameText(
  a: readonly [Page, string],
  b: readonly [Page, string],
): Promise<string> {
  await expect
    .poll(async () => {
      const [left, right] = await Promise.all([
        docText(a[0], a[1]),
        docText(b[0], b[1]),
      ]);
      return left === right ? left : `MISMATCH ${JSON.stringify([left, right])}`;
    })
    .not.toContain('MISMATCH');
  return docText(a[0], a[1]);
}

async function typeInto(page: Page, as: string, value: string): Promise<void> {
  const target = editor(page, as);
  await target.click();
  await page.keyboard.press('ControlOrMeta+End');
  await target.pressSequentially(value, { delay: 10 });
}

test('two browser contexts converge on one document', async ({ browser }) => {
  const docId = newDocId();
  const alice = await browser.newContext();
  const bob = await browser.newContext();

  try {
    const alicePage = await openClient(alice, docId, 'alice');
    const bobPage = await openClient(bob, docId, 'bob');

    // Presence: each browser can see the other, which is the awareness channel
    // working end to end rather than a screenshot of two carets.
    await expect(alicePage.getByTestId('peers-alice')).toHaveText('with bob');
    await expect(bobPage.getByTestId('peers-bob')).toHaveText('with alice');

    await typeInto(alicePage, 'alice', 'Alice wrote this. ');
    await expect(editor(bobPage, 'bob')).toContainText('Alice wrote this.');

    await typeInto(bobPage, 'bob', 'Bob replied.');

    // Both panes show the merged text, and show the same merged text.
    for (const [page, as] of [
      [alicePage, 'alice'],
      [bobPage, 'bob'],
    ] as const) {
      await expect(editor(page, as)).toContainText('Alice wrote this.');
      await expect(editor(page, as)).toContainText('Bob replied.');
    }
    const merged = await expectSameText(
      [alicePage, 'alice'],
      [bobPage, 'bob'],
    );
    expect(merged).toBe('Alice wrote this. Bob replied.');

    // A remote caret is rendered, not just tracked.
    await expect(
      bobPage.getByTestId('editor-bob').locator('.cm-ySelectionCaret').first(),
    ).toBeVisible();
  } finally {
    await alice.close();
    await bob.close();
  }
});

test('edits made offline survive a reload and sync when the client returns', async ({
  browser,
}) => {
  const docId = newDocId();
  const alice = await browser.newContext();
  const bob = await browser.newContext();

  try {
    const alicePage = await openClient(alice, docId, 'alice');
    const bobPage = await openClient(bob, docId, 'bob');

    await typeInto(alicePage, 'alice', 'Shared opening. ');
    await expect(editor(bobPage, 'bob')).toContainText('Shared opening.');

    // Alice goes offline. The flag is persisted, so the reload below comes back
    // offline too — which is what makes the next assertion meaningful.
    await alicePage.getByTestId('offline-alice').click();
    await expect(alicePage.getByTestId('status-alice')).toContainText('offline');

    await typeInto(alicePage, 'alice', 'Typed while offline. ');
    await expect(editor(alicePage, 'alice')).toContainText('Typed while offline.');

    // Bob must not see it: it never reached the server.
    await bobPage.waitForTimeout(500);
    await expect(editor(bobPage, 'bob')).not.toContainText('Typed while offline.');

    // Reload. Still offline, so the only possible source of the text is the
    // local IndexedDB store.
    await alicePage.reload();
    await expect(alicePage.getByTestId('status-alice')).toContainText('offline');
    await expect(editor(alicePage, 'alice')).toContainText('Typed while offline.');
    await expect(editor(alicePage, 'alice')).toContainText('Shared opening.');
    await expect(editor(bobPage, 'bob')).not.toContainText('Typed while offline.');

    // Back online: the queue that is not a queue drains, and both converge.
    await alicePage.getByTestId('offline-alice').click();
    await expect(alicePage.getByTestId('status-alice')).toHaveText('synced');
    await expect(editor(bobPage, 'bob')).toContainText('Typed while offline.');

    const merged = await expectSameText(
      [alicePage, 'alice'],
      [bobPage, 'bob'],
    );
    expect(merged).toBe('Shared opening. Typed while offline. ');
  } finally {
    await alice.close();
    await bob.close();
  }
});

test('both clients editing while offline merge on reconnect', async ({ browser }) => {
  const docId = newDocId();
  const alice = await browser.newContext();
  const bob = await browser.newContext();

  try {
    const alicePage = await openClient(alice, docId, 'alice');
    const bobPage = await openClient(bob, docId, 'bob');

    await typeInto(alicePage, 'alice', 'base. ');
    await expect(editor(bobPage, 'bob')).toContainText('base.');

    await alicePage.getByTestId('offline-alice').click();
    await bobPage.getByTestId('offline-bob').click();
    await expect(alicePage.getByTestId('status-alice')).toContainText('offline');
    await expect(bobPage.getByTestId('status-bob')).toContainText('offline');

    await typeInto(alicePage, 'alice', 'A-offline. ');
    await typeInto(bobPage, 'bob', 'B-offline. ');
    expect(await docText(alicePage, 'alice')).not.toBe(
      await docText(bobPage, 'bob'),
    );

    await alicePage.getByTestId('offline-alice').click();
    await bobPage.getByTestId('offline-bob').click();
    await expect(alicePage.getByTestId('status-alice')).toHaveText('synced');
    await expect(bobPage.getByTestId('status-bob')).toHaveText('synced');

    for (const [page, as] of [
      [alicePage, 'alice'],
      [bobPage, 'bob'],
    ] as const) {
      await expect(editor(page, as)).toContainText('A-offline.');
      await expect(editor(page, as)).toContainText('B-offline.');
    }
    const merged = await expectSameText(
      [alicePage, 'alice'],
      [bobPage, 'bob'],
    );
    expect(merged).toContain('base.');

    // A third, brand-new browser gets the merged document from the server.
    const carol = await browser.newContext();
    try {
      const carolPage = await openClient(carol, docId, 'carol');
      await expect(editor(carolPage, 'carol')).toContainText('A-offline.');
      await expect(editor(carolPage, 'carol')).toContainText('B-offline.');
      await expectSameText([carolPage, 'carol'], [alicePage, 'alice']);
    } finally {
      await carol.close();
    }
  } finally {
    await alice.close();
    await bob.close();
  }
});

test('a document survives every client leaving', async ({ browser }) => {
  const docId = newDocId();
  const first = await browser.newContext();
  const alicePage = await openClient(first, docId, 'alice');
  await typeInto(alicePage, 'alice', 'Written, then abandoned.');
  await expect(editor(alicePage, 'alice')).toContainText('Written, then abandoned.');
  // Give the server time to receive and flush before the socket closes.
  await alicePage.waitForTimeout(500);
  await first.close();

  const second = await browser.newContext();
  try {
    const bobPage = await openClient(second, docId, 'bob');
    await expect(editor(bobPage, 'bob')).toContainText('Written, then abandoned.');
  } finally {
    await second.close();
  }
});
