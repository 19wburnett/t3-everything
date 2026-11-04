import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import { collectToolFilePaths } from "@t3tools/shared/toolActivity";

/** What the Design tab can show for a file a thread made or touched. */
export type DesignKind = "page" | "image" | "pdf" | "deck" | "document" | "spreadsheet";

export interface ThreadDesign {
  readonly path: string;
  readonly name: string;
  readonly kind: DesignKind;
  /** Ordinal of the latest touch, newest first. */
  readonly lastOrdinal: number;
}

const KIND_BY_EXTENSION: Readonly<Record<string, DesignKind>> = {
  html: "page",
  htm: "page",
  svg: "image",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  pdf: "pdf",
  pptx: "deck",
  docx: "document",
  xlsx: "spreadsheet",
};

// Skills often write decks and documents from a script, so outputs are only visible in the command.
const DESIGN_EXTENSION = String.raw`\.(?:html?|svg|png|jpe?g|webp|gif|pdf|pptx|docx|xlsx)`;
const COMMAND_PATH = new RegExp(
  String.raw`"([^"\n]*?${DESIGN_EXTENSION})"|'([^'\n]*?${DESIGN_EXTENSION})'|(?:^|[\s=(>])((?:\/|\.{1,2}\/)?[\w@%+.,-]+(?:\/[\w@%+.,-]+)*${DESIGN_EXTENSION})(?=$|[\s):;,|&<>])`,
  "gi",
);
const GENERATED_DIR = /(^|\/)(node_modules|\.git|dist|build|\.next|coverage)\//;

function designKindOf(path: string): DesignKind | null {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return extension === undefined ? null : (KIND_BY_EXTENSION[extension] ?? null);
}

function absolutePath(path: string, workspaceRoot: string): string {
  const normalized = path.replaceAll("\\", "/");
  const joined = normalized.startsWith("/") ? normalized : `${workspaceRoot}/${normalized}`;
  const segments: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function itemPaths(item: ThreadStructureTurnItem): ReadonlyArray<string> {
  switch (item.type) {
    case "file_change":
      return [item.fileName];
    case "dynamic_tool":
      return collectToolFilePaths(item.input);
    case "command_execution":
      return [...`${item.input}\n${item.output ?? ""}`.matchAll(COMMAND_PATH)].flatMap((match) => {
        const path = match[1] ?? match[2] ?? match[3];
        return path === undefined || path.includes("://") ? [] : [path];
      });
    default:
      return [];
  }
}

/** Pages, images, decks and documents the thread wrote or ran commands on, newest first. */
export function deriveThreadDesigns(
  rows: ReadonlyArray<{ readonly item: ThreadStructureTurnItem }>,
  workspaceRoot: string,
): ReadonlyArray<ThreadDesign> {
  const designs = new Map<string, ThreadDesign>();
  for (const { item } of rows) {
    for (const raw of itemPaths(item)) {
      const kind = designKindOf(raw);
      if (kind === null) continue;
      const path = absolutePath(raw, workspaceRoot);
      if (GENERATED_DIR.test(path)) continue;
      const previous = designs.get(path);
      designs.set(path, {
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        kind,
        lastOrdinal: Math.max(previous?.lastOrdinal ?? 0, item.ordinal),
      });
    }
  }
  return [...designs.values()].toSorted((a, b) => b.lastOrdinal - a.lastOrdinal);
}
