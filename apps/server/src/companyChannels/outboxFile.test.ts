import { describe, expect, it } from "@effect/vitest";
import { CompanyChannelAccountId, type CompanyDraft, CompanyDraftId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { draftIdFromFileName, newDraftId, parseDraft, serializeDraft } from "./outboxFile.ts";

const id = CompanyDraftId.make("2026-10-31-re-hello-ab12cd");
const draft: CompanyDraft = {
  id,
  path: `company/outbox/${id}.md`,
  channel: "email",
  account: CompanyChannelAccountId.make("acct-1"),
  status: "failed",
  createdBy: "Muse",
  createdAt: DateTime.makeUnsafe("2026-10-31T09:00:00.000Z"),
  to: ["bob@x.test", "Ann <ann@x.test>"],
  subject: 'Re: "Hello": part 2',
  inReplyTo: "<m1@x.test>",
  references: ["<m0@x.test>", "<m1@x.test>"],
  error: "The SMTP server refused the username or app password.",
  body: "Hi Bob,\n\n---\n\nThanks!\n",
};

describe("outbox files", () => {
  it("round-trips a draft, including a body with a --- line", () => {
    const text = serializeDraft(draft);
    expect(text.startsWith('---\nid: "2026-10-31-re-hello-ab12cd"\nchannel: "email"\n')).toBe(true);
    expect(parseDraft(id, text)).toEqual({ _tag: "Draft", draft });
    expect(parseDraft(id, text.replace(/\n/g, "\r\n"))).toEqual({ _tag: "Draft", draft });
  });

  it.each([
    ["no frontmatter", "Hello", "no_frontmatter"],
    ["unterminated frontmatter", '---\nchannel: "x"\n', "no_frontmatter"],
    ["invalid YAML", "---\nchannel: [x\n---\nbody", "invalid_yaml"],
    ["unknown status", serializeDraft(draft).replace('"failed"', '"queued"'), "invalid_fields"],
    ["missing account", serializeDraft(draft).replace(/^account: .*\n/m, ""), "invalid_fields"],
  ])("reports %s", (_name, text, problem) => {
    const parsed = parseDraft(id, text);
    expect(parsed._tag === "Malformed" ? parsed.error.problem : null).toBe(problem);
  });

  it("names drafts by date, subject, and short id", () => {
    expect(
      newDraftId(DateTime.makeUnsafe("2026-10-31T23:00:00Z"), "Re: Ünïcode & Co!", "AB12CD"),
    ).toBe("2026-10-31-re-unicode-co-ab12cd");
    expect(draftIdFromFileName("2026-10-31-a-b.md")).toBe("2026-10-31-a-b");
    expect(draftIdFromFileName("Notes.md")).toBeNull();
    expect(draftIdFromFileName("../x.md")).toBeNull();
  });
});
