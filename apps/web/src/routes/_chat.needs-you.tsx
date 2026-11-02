import { createFileRoute } from "@tanstack/react-router";

import { NeedsYouPage } from "../components/needsYou/NeedsYouPage";

export const Route = createFileRoute("/_chat/needs-you")({
  component: NeedsYouPage,
});
