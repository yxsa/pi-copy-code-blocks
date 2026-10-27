/**
 * copy-code-blocks — кликабельная кнопка 📋 у каждого блока кода в транскрипте Pi.
 *
 * Копирует исходный текст блока: без codeBlockIndent, без переносов от soft-wrap,
 * без ANSI-последовательностей. Метки живут только в рендере транскрипта
 * (registerMarkdownTransformer), поэтому контекст модели и /export остаются чистыми.
 *
 * Клавиатура: Ctrl+Alt+C или /copycode [номер блока].
 * Мышь: клик по «📋 copy · js · 12L» под блоком (fullscreen-режим Pi).
 */

import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getOsc8LinkAtColumn, stripTerminalSequences, TuiAltScreen } from "@earendil-works/pi-tui";

const SCHEME = "picopy";
const MAX_BLOCKS = 400;

/** Типы сообщений, у которых рисуются кнопки. Добавь "user", если нужно и в своих запросах. */
const LABEL_MESSAGE_TYPES = new Set<string>(["assistant"]);

interface Block {
  id: string;
  lang: string;
  code: string;
  lines: number;
  preview: string;
}

type ClipboardWriter = (text: string) => Promise<void>;

/** id -> блок. Идемпотентно: id это хэш содержимого, поэтому перерендер не создаёт дублей. */
const registry = new Map<string, Block>();

let writeClipboard: ClipboardWriter = copyToClipboard;

function blockId(code: string, lang: string): string {
  let h = 0x811c9dc5;
  const source = `${lang}\n${code}`;
  for (let i = 0; i < source.length; i++) {
    h = Math.imul(h ^ source.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(6, "0").slice(-6);
}

function makeBlock(code: string, lang: string): Block {
  const clean = code.replace(/\n+$/, "");
  const lines = clean.length > 0 ? clean.split("\n") : [];
  const preview = (lines.find((line) => line.trim() !== "") ?? "").trim().slice(0, 48);
  return { id: blockId(clean, lang), lang, code: clean, lines: lines.length, preview };
}

function remember(block: Block): void {
  registry.set(block.id, block);
  while (registry.size > MAX_BLOCKS) {
    const oldest = registry.keys().next().value;
    if (oldest === undefined) break;
    registry.delete(oldest);
  }
}

export function clearRegistry(): void {
  registry.clear();
}

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*([^\s`~]*)\s*$/;

/**
 * Разбирает fenced-блоки markdown.
 * annotate=true — дописать под блок строку-кнопку; annotate=false — только собрать блоки.
 */
export function scan(markdown: string, annotate: boolean): { markdown: string; blocks: Block[] } {
  const blocks: Block[] = [];
  if (!markdown.includes("```") && !markdown.includes("~~~")) {
    return { markdown, blocks };
  }

  const lines = markdown.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const current = lines[i] ?? "";
    const open = FENCE_OPEN.exec(current);
    if (!open) {
      out.push(current);
      continue;
    }

    const indent = open[1] ?? "";
    const fence = open[2] ?? "```";
    const lang = open[3]?.trim() || "text";
    const closeChar = fence[0] === "~" ? "~" : "`";
    const closeRe = new RegExp(`^\\s*${closeChar}{${fence.length},}\\s*$`);

    const body: string[] = [];
    let closeIdx = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j] ?? "";
      if (closeRe.test(candidate)) {
        closeIdx = j;
        break;
      }
      body.push(candidate);
    }

    // Незакрытый блок (идёт стриминг) — выводим как есть, кнопку не добавляем.
    if (closeIdx === -1) {
      out.push(...lines.slice(i));
      break;
    }

    const block = makeBlock(body.join("\n"), lang);
    blocks.push(block);
    remember(block);

    for (let k = i; k <= closeIdx; k++) out.push(lines[k] ?? "");
    if (annotate) {
      out.push(`${indent}[📋 copy · ${lang} · ${block.lines}L](${SCHEME}:${block.id})`);
    }
    i = closeIdx;
  }

  return { markdown: out.join("\n"), blocks };
}

// --------------------------------------------------------------------------- клик мышью

interface RawMouse {
  button: number;
  x: number;
  y: number;
  release: boolean;
}

const PATCH_FLAG = Symbol.for("pi.copy-code-blocks.patch");
let ctxRef: ExtensionContext | undefined;
let press: { id: string; x: number; y: number } | undefined;

/** Какой блок кода находится под курсором (fullscreen-кадр, 0-based координаты). */
export function blockIdAt(tui: any, raw: RawMouse): string | undefined {
  const screen: string[] = typeof tui?.getScreenLines === "function" ? tui.getScreenLines() : [];
  const line = screen.at(raw.y);
  if (!line) return undefined;

  // Полноценная OSC8-ссылка: id только в href, наружу ничего не видно.
  const href = getOsc8LinkAtColumn(line, raw.x);
  if (href?.startsWith(`${SCHEME}:`)) return href.slice(SCHEME.length + 1);

  // Терминалы без гиперссылок: pi дописывает "(picopy:abc123)" в текст строки.
  const fallback = new RegExp(`${SCHEME}:([0-9a-z]{6})`).exec(stripTerminalSequences(line));
  return fallback?.[1];
}

async function copyBlock(id: string, tui: any): Promise<void> {
  const block = registry.get(id);
  if (!block) {
    ctxRef?.ui.notify(`Блок ${id} вытеснен из кеша — возьми его через /copycode`, "warning");
    return;
  }
  try {
    await writeClipboard(block.code);
    if (typeof tui?.flash === "function") tui.flash(`📋 ${block.lang}: ${block.lines} lines copied`);
    else ctxRef?.ui.notify(`📋 Скопировано ${block.lines} строк (${block.lang})`, "info");
  } catch (error) {
    ctxRef?.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

/**
 * Перехват клика до штатной обработки TuiAltScreen: иначе pi начинает text selection,
 * copyOnSelect пишет в буфер саму метку, а openUrl пытается открыть picopy: в браузере.
 */
export function installMouseHook(): () => void {
  const proto = TuiAltScreen.prototype as unknown as {
    handleMouseEvent?: (raw: RawMouse) => void;
    [key: symbol]: unknown;
  };
  if (proto[PATCH_FLAG]) return () => {};

  const original = proto.handleMouseEvent;

  proto.handleMouseEvent = function (this: any, raw: RawMouse): void {
    const left = (raw.button & 3) === 0;
    const motion = (raw.button & 32) !== 0;
    const overlayOpen = typeof this.hasOverlay === "function" ? this.hasOverlay() : false;

    if (left && !motion && !overlayOpen) {
      const id = blockIdAt(this, raw);
      if (id) {
        if (!raw.release) {
          press = { id, x: raw.x, y: raw.y };
          return; // consume
        }
        if (press?.id === id && press.x === raw.x && press.y === raw.y) void copyBlock(id, this);
        press = undefined;
        return; // consume
      }
    }
    return original?.call(this, raw);
  };
  proto[PATCH_FLAG] = true;

  return () => {
    proto.handleMouseEvent = original;
    delete proto[PATCH_FLAG];
  };
}

// ------------------------------------------------------------------- команда и хоткей

function lastAssistantMarkdown(ctx: ExtensionContext): string {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as any;
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const text = (entry.message.content ?? [])
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
      .join("\n");
    if (text.includes("```") || text.includes("~~~")) return text;
  }
  return "";
}

async function pickIndex(ctx: ExtensionContext, blocks: Block[]): Promise<number> {
  const labels = blocks.map(
    (block, i) => `${i + 1}. ${block.lang} · ${block.lines}L · ${block.preview || "(пусто)"}`,
  );
  const picked = await ctx.ui.select("Скопировать блок кода", labels);
  return picked ? labels.indexOf(picked) : -1;
}

async function pickAndCopy(ctx: ExtensionContext, arg: string): Promise<void> {
  const blocks = scan(lastAssistantMarkdown(ctx), false).blocks;
  if (blocks.length === 0) {
    ctx.ui.notify("В последнем ответе нет блоков кода", "warning");
    return;
  }

  const index = Number.parseInt(arg.trim(), 10);
  const chosen =
    Number.isFinite(index) && index >= 1 && index <= blocks.length
      ? blocks[index - 1]
      : blocks[await pickIndex(ctx, blocks)];
  if (!chosen) return;

  await writeClipboard(chosen.code);
  ctx.ui.notify(`📋 Скопировано ${chosen.lines} строк (${chosen.lang})`, "info");
}

/** Точка входа Pi-расширения. */
export default function (pi: ExtensionAPI) {
  let uninstall: () => void = () => {};

  pi.registerMarkdownTransformer((markdown, context) => {
    if (!LABEL_MESSAGE_TYPES.has(context.messageType)) return markdown;
    return scan(markdown, true).markdown;
  });

  pi.registerCommand("copycode", {
    description: "Скопировать блок кода из последнего ответа (/copycode [номер])",
    handler: async (args, ctx) => {
      ctxRef = ctx;
      await pickAndCopy(ctx, args);
    },
  });

  pi.registerShortcut("ctrl+alt+c", {
    description: "Выбрать и скопировать блок кода из последнего ответа",
    handler: async (ctx) => {
      ctxRef = ctx;
      await pickAndCopy(ctx, "");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ctxRef = ctx;
    uninstall = installMouseHook();
  });

  pi.on("session_shutdown", () => {
    uninstall();
    ctxRef = undefined;
  });
}

/** Внутренности для тестов: инъекция clipboard-writera и прямой доступ к парсеру и хуку. */
export const testing = {
  scan,
  blockIdAt,
  installMouseHook,
  clearRegistry,
  setClipboardWriter(writer: ClipboardWriter) {
    writeClipboard = writer;
  },
  resetClipboardWriter() {
    writeClipboard = copyToClipboard;
  },
  copyBlock,
  pickAndCopy,
  scheme: SCHEME,
};
