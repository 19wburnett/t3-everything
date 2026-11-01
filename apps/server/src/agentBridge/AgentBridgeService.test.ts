import { describe, expect, it } from "vite-plus/test";

import { toShareExchanges } from "./AgentBridgeService.ts";

describe("toShareExchanges", () => {
  it("answers each run of user messages with the agent replies that follow", () => {
    expect(
      toShareExchanges([
        { role: "agent", text: "Morning! Three leads replied." },
        { role: "user", text: "Show me" },
        { role: "user", text: "  " },
        { role: "user", text: "the warm ones" },
        { role: "agent", text: "Acme and Birch." },
        { role: "agent", text: "Draft replies?" },
        { role: "user", text: "Yes" },
        { role: "agent", text: "Sent." },
        { role: "user", text: "/compact" },
        { role: "agent", text: "Compacted." },
      ]),
    ).toEqual([
      { text: "(Earlier in this conversation)", replies: ["Morning! Three leads replied."] },
      { text: "Show me\n\nthe warm ones", replies: ["Acme and Birch.", "Draft replies?"] },
      { text: "Yes", replies: ["Sent.", "Compacted."] },
    ]);
  });
});
