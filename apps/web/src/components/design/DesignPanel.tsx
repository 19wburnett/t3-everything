import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  FileTextIcon,
  ImageIcon,
  LayoutTemplateIcon,
  PaletteIcon,
  PresentationIcon,
  SheetIcon,
  SquareArrowOutUpRightIcon,
  type LucideIcon,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { observeResize } from "~/lib/observeResize";
import { useRightPanelStore } from "~/rightPanelStore";
import { useQuietThreadVisibleTurnItems } from "~/state/entities";
import { BrowserDocumentFrame } from "../files/BrowserDocumentFrame";
import { workspaceAssetResource } from "../files/filePreviewMode";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { deriveThreadDesigns, type DesignKind, type ThreadDesign } from "./threadDesigns";

/** Pages render at a desktop width and scale down, so an artboard shows the real layout. */
const ARTBOARD_WIDTH = 1280;

const KIND_LABELS: Record<DesignKind, string> = {
  page: "Page",
  image: "Image",
  pdf: "PDF",
  deck: "Slides",
  document: "Document",
  spreadsheet: "Spreadsheet",
};

const KIND_ICONS: Record<DesignKind, LucideIcon> = {
  page: LayoutTemplateIcon,
  image: ImageIcon,
  pdf: FileTextIcon,
  deck: PresentationIcon,
  document: FileTextIcon,
  spreadsheet: SheetIcon,
};

interface DesignPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string;
  readonly workspaceMutationId: string | null;
}

/** Everything visual the thread made, laid out as artboards. */
export function DesignPanel(props: DesignPanelProps) {
  const rows = useQuietThreadVisibleTurnItems(props.threadRef);
  const designs = deriveThreadDesigns(rows, props.workspaceRoot);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const focused = designs.find((design) => design.path === focusedPath);

  const openInFiles = (design: ThreadDesign) =>
    useRightPanelStore.getState().openFile(props.threadRef, design.path);
  const select = (design: ThreadDesign) =>
    design.kind === "page" || design.kind === "image"
      ? setFocusedPath(design.path)
      : openInFiles(design);

  if (focused) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b px-1.5">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Back to all designs"
            onClick={() => setFocusedPath(null)}
          >
            <ArrowLeftIcon />
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{focused.name}</span>
          <Button size="sm" variant="ghost" onClick={() => openInFiles(focused)}>
            <SquareArrowOutUpRightIcon />
            Open file
          </Button>
        </div>
        <DesignView {...props} design={focused} />
      </div>
    );
  }

  if (designs.length === 0) {
    return (
      <Empty size="compact">
        <EmptyMedia variant="icon">
          <PaletteIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>Nothing designed yet</EmptyTitle>
          <EmptyDescription>
            Pages, images, slides and documents this thread makes show up here. Ask for a landing
            page, a deck, a one-pager or a social graphic.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4 p-4">
        {designs.map((design) => (
          <li key={design.path}>
            <button
              type="button"
              className="group flex w-full flex-col gap-1.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              onClick={() => select(design)}
            >
              <div className="relative aspect-[16/10] w-full overflow-hidden rounded-lg border bg-muted/40 transition-colors group-hover:border-foreground/25">
                <Artboard {...props} design={design} />
              </div>
              <span className="flex min-w-0 items-baseline gap-1.5 px-0.5">
                <span className="truncate text-sm font-medium text-foreground/85">
                  {design.name}
                </span>
                <span className="shrink-0 text-2xs text-muted-foreground">
                  {KIND_LABELS[design.kind]}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function useDesignUrl(props: DesignPanelProps, path: string): string | null | "failed" {
  const assetUrl = useAssetUrlState(
    props.environmentId,
    workspaceAssetResource({
      kind: "workspace-file",
      threadRef: props.threadRef,
      draft: false,
      workspaceRoot: props.workspaceRoot,
      absolutePath: path,
    }),
  );
  if (assetUrl._tag === "Failure") return "failed";
  if (assetUrl._tag !== "Success") return null;
  // Agents rewrite designs in place; the revision makes the frame load the new bytes.
  return props.workspaceMutationId === null
    ? assetUrl.url
    : `${assetUrl.url}${assetUrl.url.includes("?") ? "&" : "?"}workspace-revision=${encodeURIComponent(props.workspaceMutationId)}`;
}

function Artboard(props: DesignPanelProps & { readonly design: ThreadDesign }) {
  const { design } = props;
  if (design.kind === "page") return <PageArtboard {...props} />;
  if (design.kind === "image") return <ImageArtboard {...props} />;
  const Icon = KIND_ICONS[design.kind];
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
      <Icon aria-hidden className="size-8" />
      <span className="text-xs">{KIND_LABELS[design.kind]}</span>
    </div>
  );
}

function ArtboardStatus(props: { readonly failed: boolean }) {
  return (
    <div className="flex size-full items-center justify-center text-xs text-muted-foreground">
      {props.failed ? "Not available" : <Spinner />}
    </div>
  );
}

function PageArtboard(props: DesignPanelProps & { readonly design: ThreadDesign }) {
  const url = useDesignUrl(props, props.design.path);
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scales the desktop-width page to the artboard's measured width
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => setScale(container.getBoundingClientRect().width / ARTBOARD_WIDTH);
    update();
    return observeResize(container, update);
  }, []);

  return (
    <div ref={containerRef} className="size-full">
      {url === null || url === "failed" ? (
        <ArtboardStatus failed={url === "failed"} />
      ) : scale > 0 ? (
        <iframe
          key={url}
          src={url}
          title={props.design.name}
          aria-hidden
          tabIndex={-1}
          loading="lazy"
          // A thumbnail only needs to lay out and run the page's own scripts.
          sandbox="allow-scripts"
          className="pointer-events-none origin-top-left border-0 bg-white"
          style={{
            width: ARTBOARD_WIDTH,
            height: (ARTBOARD_WIDTH * 10) / 16,
            transform: `scale(${scale})`,
          }}
        />
      ) : null}
    </div>
  );
}

function ImageArtboard(props: DesignPanelProps & { readonly design: ThreadDesign }) {
  const url = useDesignUrl(props, props.design.path);
  if (url === null || url === "failed") return <ArtboardStatus failed={url === "failed"} />;
  return <img src={url} alt="" loading="lazy" className="size-full object-contain" />;
}

function DesignView(props: DesignPanelProps & { readonly design: ThreadDesign }) {
  const url = useDesignUrl(props, props.design.path);
  if (url === null || url === "failed") return <ArtboardStatus failed={url === "failed"} />;
  return props.design.kind === "image" ? (
    <div className="scrollbar-gutter-both flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img src={url} alt={props.design.name} className="max-h-full max-w-full object-contain" />
    </div>
  ) : (
    <BrowserDocumentFrame src={url} documentKey={url} title={props.design.name} pdf={false} />
  );
}
