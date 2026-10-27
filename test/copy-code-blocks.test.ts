/**
 * Смоук-тесты расширения. Не трогают системный буфер обмена: clipboard-writer
 * подменяется через testing.setClipboardWriter().
 *
 * Требуются ссылки на Pi-пакеты: bash scripts/dev-setup.sh
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { hyperlink, TuiAltScreen } from "@earendil-works/pi-tui";
import extension, { testing } from "../extensions/copy-code-blocks.ts";

const SAMPLE = [
  "Вот код:",
  "",
  "```js",
  "class A {",
  "  constructor({ max = 100 } = {}) {",
  "    this.max = max;",
  "  }",
  "}",
  "```",
  "",
  "И второй:",
  "```bash",
  "echo hi",
  "```",
].join("\n");

interface MouseRaw {
  button: number;
  x: number;
  y: number;
  release: boolean;
}

const PROTO = TuiAltScreen.prototype as unknown as Record<string | symbol, unknown>;
const REAL_HANDLE = PROTO.handleMouseEvent;

/** Вызвать текущий (возможно запатченный) обработчик клика с фейковым TUI. */
function dispatchClick(tui: object, raw: MouseRaw): void {
  const handle = PROTO.handleMouseEvent as (this: unknown, raw: MouseRaw) => void;
  handle.call(tui, raw);
}

/** Вернуть прототип к исходному виду (после предыдущих тестов там может остаться стаб). */
function restoreProto(): void {
  PROTO.handleMouseEvent = REAL_HANDLE;
  delete PROTO[Symbol.for("pi.copy-code-blocks.patch")];
}

/** Подменить «штатный» обработчик на счётчик вызовов до установки хука. */
function stubOriginalHandler(): () => number {
  let calls = 0;
  restoreProto();
  PROTO.handleMouseEvent = () => {
    calls++;
  };
  return () => calls;
}

function makeHooks() {
  const hooks: Record<string, unknown> = {};
  const events: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  const pi = {
    registerMarkdownTransformer: (f: unknown) => (hooks.transform = f),
    registerCommand: (name: string, options: unknown) => (hooks.command = { name, options }),
    registerShortcut: (key: string, options: unknown) => (hooks.shortcut = { key, options }),
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => (events[event] = handler),
  };
  extension(pi as never);
  return { hooks, events };
}

function makeContext(branch: unknown[]) {
  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
      select: async (_title: string, labels: string[]) => labels[0],
    },
    sessionManager: { getBranch: () => branch },
  };
  return { ctx, notifications };
}

function assistantBranch(markdown: string) {
  return [
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: markdown }] } },
  ];
}

/** Фейковый TuiAltScreen: только то, что читает хук. */
function fakeTui(lines: string[], overlayOpen = false) {
  const flashes: string[] = [];
  const tui = {
    getScreenLines: () => lines,
    hasOverlay: () => overlayOpen,
    flash: (message: string) => {
      flashes.push(message);
    },
  };
  return { tui, flashes };
}

function captureClipboard(): string[] {
  const copied: string[] = [];
  testing.setClipboardWriter(async (text) => {
    copied.push(text);
  });
  return copied;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("markdown-трансформер добавляет кнопку под каждый закрытый блок", () => {
  const { hooks } = makeHooks();
  const transform = hooks.transform as (md: string, ctx: unknown) => string;

  const rendered = transform(SAMPLE, { messageType: "assistant", isStreaming: false, availableWidth: 100 });
  const ids = [...rendered.matchAll(/picopy:([0-9a-z]{6})/g)].map((m) => m[1]);

  assert.equal(ids.length, 2, "должно появиться две кнопки");
  assert.match(rendered, /\[📋 copy · js · 5L\]\(picopy:/);
  assert.match(rendered, /\[📋 copy · bash · 1L\]\(picopy:/);
  assert.equal(new Set(ids).size, 2, "id блоков различаются");
});

test("чужие типы сообщений и текст без кода не меняются", () => {
  const { hooks } = makeHooks();
  const transform = hooks.transform as (md: string, ctx: unknown) => string;

  assert.equal(
    transform(SAMPLE, { messageType: "user", isStreaming: false, availableWidth: 100 }),
    SAMPLE,
  );
  assert.equal(
    transform("просто текст", { messageType: "assistant", isStreaming: false, availableWidth: 100 }),
    "просто текст",
  );
});

test("незакрытый блок во время стриминга остаётся как есть", () => {
  const streaming = "```js\nlet a = 1;";
  assert.equal(testing.scan(streaming, true).markdown, streaming);
});

test("id стабилен между перерендерами, код в реестре чистый", () => {
  const first = testing.scan(SAMPLE, false);
  const second = testing.scan(SAMPLE, true);
  assert.deepEqual(
    first.blocks.map((b) => b.id),
    second.blocks.map((b) => b.id),
  );

  const jsBlock = first.blocks.find((b) => b.lang === "js");
  assert.ok(jsBlock);
  assert.ok(!jsBlock.code.includes("```"), "в код не попадают fence-строки");
  assert.ok(!jsBlock.code.includes("\r"), "в коде нет CRLF");
  assert.equal(jsBlock.preview, "class A {");
});

test("клик по OSC8-кнопке копирует блок и не зовёт штатный обработчик", async () => {
  const copied = captureClipboard();
  testing.clearRegistry();
  const id = testing.scan(SAMPLE, false).blocks[0]?.id;
  assert.ok(id);

  const originalCalls = stubOriginalHandler();
  const uninstall = testing.installMouseHook();

  const { tui, flashes } = fakeTui(["  " + hyperlink("📋 copy · js · 5L", `picopy:${id}`)]);
  dispatchClick(tui, { button: 0, x: 5, y: 0, release: false });
  dispatchClick(tui, { button: 0, x: 5, y: 0, release: true });
  await settle();

  assert.equal(copied.length, 1, "ровно одно копирование");
  assert.ok(copied[0]?.startsWith("class A {"));
  assert.deepEqual(flashes, ["📋 js: 5 lines copied"]);
  assert.equal(originalCalls(), 0, "событие должно быть потреблено хуком");

  uninstall();
  testing.resetClipboardWriter();
});

test("клик мимо кнопки и клик под оверлеем уходят в штатную обработку", () => {
  testing.clearRegistry();
  testing.scan(SAMPLE, false);

  const originalCalls = stubOriginalHandler();
  const uninstall = testing.installMouseHook();

  const { tui } = fakeTui(["  обычный текст без кнопок"]);
  dispatchClick(tui, { button: 0, x: 3, y: 0, release: false });
  assert.equal(originalCalls(), 1);

  const id = testing.scan(SAMPLE, false).blocks[0]?.id;
  const { tui: overlayTui } = fakeTui(["  " + hyperlink("📋 copy · js · 5L", `picopy:${id}`)], true);
  dispatchClick(overlayTui, { button: 0, x: 5, y: 0, release: false });
  assert.equal(originalCalls(), 2, "под оверлеем хук не срабатывает");

  uninstall();
});

test("fallback для терминалов без гиперссылок читает id из текста строки", async () => {
  const copied = captureClipboard();
  testing.clearRegistry();
  const id = testing.scan(SAMPLE, false).blocks[1]?.id; // bash-блок
  assert.ok(id);

  const originalCalls = stubOriginalHandler();
  const uninstall = testing.installMouseHook();

  const { tui } = fakeTui([`  📋 copy · bash · 1L (picopy:${id})`]);
  dispatchClick(tui, { button: 0, x: 6, y: 0, release: false });
  dispatchClick(tui, { button: 0, x: 6, y: 0, release: true });
  await settle();

  assert.deepEqual(copied, ["echo hi"]);
  assert.equal(originalCalls(), 0);

  uninstall();
  testing.resetClipboardWriter();
});

test("release без press по той же клетке ничего не копирует", async () => {
  const copied = captureClipboard();
  testing.clearRegistry();
  const id = testing.scan(SAMPLE, false).blocks[0]?.id;
  assert.ok(id);

  stubOriginalHandler();
  const uninstall = testing.installMouseHook();

  const { tui } = fakeTui(["  " + hyperlink("📋 copy · js · 5L", `picopy:${id}`)]);
  dispatchClick(tui, { button: 0, x: 20, y: 0, release: true }); // release из другой клетки
  await settle();
  assert.deepEqual(copied, []);

  uninstall();
  testing.resetClipboardWriter();
});

test("session_start ставит хук, session_shutdown откатывает прототип", async () => {
  const { hooks, events } = makeHooks();
  assert.equal(typeof hooks.transform, "function");
  assert.equal((hooks.command as { name: string }).name, "copycode");
  assert.equal((hooks.shortcut as { key: string }).key, "ctrl+alt+c");
  assert.equal(typeof events.session_start, "function");
  assert.equal(typeof events.session_shutdown, "function");

  const { ctx } = makeContext([]);
  restoreProto();
  await events.session_start?.({}, ctx);
  assert.notEqual(PROTO.handleMouseEvent, REAL_HANDLE, "хук должен заменить обработчик");

  await events.session_shutdown?.({}, ctx);
  assert.equal(PROTO.handleMouseEvent, REAL_HANDLE, "хук должен быть снят");
});

test("/copycode копирует выбранный блок из последнего ответа", async () => {
  const copied = captureClipboard();
  testing.clearRegistry();

  const { hooks } = makeHooks();
  const handler = (hooks.command as { options: { handler: (args: string, ctx: unknown) => Promise<void> } })
    .options.handler;
  const { ctx, notifications } = makeContext(assistantBranch(SAMPLE));

  await handler("", ctx);
  assert.equal(copied.length, 1);
  assert.ok(copied[0]?.startsWith("class A {"), "по умолчанию берётся первый блок");
  assert.match(notifications[0] ?? "", /Скопировано 5 строк/);

  copied.length = 0;
  await handler("2", ctx);
  assert.deepEqual(copied, ["echo hi"]);

  copied.length = 0;
  const { ctx: emptyCtx, notifications: emptyNotes } = makeContext(assistantBranch("без кода"));
  await handler("", emptyCtx);
  assert.deepEqual(copied, []);
  assert.match(emptyNotes.at(-1) ?? "", /нет блоков кода/);

  testing.resetClipboardWriter();
});

test("хоткей открывает тот же выбор блоков", async () => {
  const copied = captureClipboard();
  testing.clearRegistry();

  const { hooks } = makeHooks();
  const handler = (hooks.shortcut as { options: { handler: (ctx: unknown) => Promise<void> } }).options.handler;
  const { ctx } = makeContext(assistantBranch(SAMPLE));

  await handler(ctx);
  assert.ok(copied[0]?.startsWith("class A {"));

  testing.resetClipboardWriter();
});
