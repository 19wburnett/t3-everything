import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import { deriveThreadDesigns } from "./threadDesigns";

let ordinal = 0;
const row = (item: Record<string, unknown>) => ({
  item: { status: "completed", ordinal: ++ordinal, ...item } as unknown as ThreadStructureTurnItem,
});
const ROOT = "/home/user/work";

describe("deriveThreadDesigns", () => {
  it("collects written files and script outputs, newest first, one entry per file", () => {
    const designs = deriveThreadDesigns(
      [
        row({ type: "file_change", fileName: "site/index.html" }),
        row({ type: "file_change", fileName: "notes.md" }),
        row({
          type: "command_execution",
          input:
            'node build-deck.js --out "decks/q3 review.pptx" && soffice --convert-to pdf decks/q3.pptx',
          output: "Wrote /home/user/work/poster.png\n",
        }),
        row({ type: "dynamic_tool", input: { file_path: `${ROOT}/site/./index.html` } }),
      ],
      ROOT,
    );
    expect(designs.map((design) => [design.path, design.kind])).toEqual([
      [`${ROOT}/site/index.html`, "page"],
      [`${ROOT}/decks/q3 review.pptx`, "deck"],
      [`${ROOT}/decks/q3.pptx`, "deck"],
      [`${ROOT}/poster.png`, "image"],
    ]);
  });

  it("skips URLs, globs and generated folders", () => {
    const designs = deriveThreadDesigns(
      [
        row({
          type: "command_execution",
          input: "curl -o logo.png https://example.com/brand/logo.svg && ls *.pdf",
        }),
        row({ type: "file_change", fileName: "node_modules/pkg/readme.html" }),
        row({ type: "file_change", fileName: "../shared/brand.svg" }),
      ],
      ROOT,
    );
    expect(designs.map((design) => design.path)).toEqual([
      "/home/user/shared/brand.svg",
      `${ROOT}/logo.png`,
    ]);
  });
});
