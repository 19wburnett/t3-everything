import { CompanyDraft, CompanyDraftId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { parse as parseYaml } from "yaml";

export const OUTBOX_DIR = "company/outbox";

export const draftPath = (id: CompanyDraftId) => `${OUTBOX_DIR}/${id}.md`;

const DRAFT_FILE = /^([a-z0-9][a-z0-9-]{0,127})\.md$/;

/** The draft id a file in the outbox is named for, or null for files that are not drafts. */
export const draftIdFromFileName = (name: string) => {
  const match = DRAFT_FILE.exec(name);
  return match?.[1] === undefined ? null : CompanyDraftId.make(match[1]);
};

const slugify = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "") || "draft";

/** `<YYYY-MM-DD>-<slug>-<shortId>`, named after the subject or the first words. */
export const newDraftId = (createdAt: DateTime.Utc, title: string, shortId: string) =>
  CompanyDraftId.make(
    `${DateTime.formatIso(createdAt).slice(0, 10)}-${slugify(title)}-${shortId.toLowerCase()}`,
  );

const { id: _id, path: _path, body: _body, ...frontmatterFields } = CompanyDraft.fields;
const Frontmatter = Schema.Struct({
  ...frontmatterFields,
  id: Schema.optionalKey(Schema.String),
});
const FrontmatterJson = Schema.toCodecJson(Frontmatter);
const decodeFrontmatter = Schema.decodeUnknownExit(FrontmatterJson);
const encodeFrontmatter = Schema.encodeSync(FrontmatterJson);

const FIELD_ORDER = [
  "id",
  "channel",
  "account",
  "status",
  "createdBy",
  "createdAt",
  "to",
  "cc",
  "subject",
  "inReplyTo",
  "references",
  "replyToMessageId",
  "sentAt",
  "url",
  "error",
] as const;

class MalformedDraftError extends Schema.TaggedError<MalformedDraftError>()("MalformedDraftError", {
  problem: Schema.Literals(["no_frontmatter", "invalid_yaml", "invalid_fields"]),
}) {
  override get message(): string {
    switch (this.problem) {
      case "no_frontmatter":
        return "The file does not start with a --- frontmatter block.";
      case "invalid_yaml":
        return "The frontmatter is not valid YAML.";
      case "invalid_fields":
        return "The frontmatter is missing a field or has one with the wrong value.";
    }
  }
}

/** Frontmatter values are JSON, which YAML reads as is, so files stay plain to edit by hand. */
export function serializeDraft(draft: CompanyDraft): string {
  const { path: _p, body, ...fields } = draft;
  const encoded = encodeFrontmatter(fields) as Record<string, unknown>;
  const lines = FIELD_ORDER.flatMap((key) =>
    encoded[key] === undefined ? [] : [`${key}: ${JSON.stringify(encoded[key])}`],
  );
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

export type ParsedDraft =
  | { readonly _tag: "Draft"; readonly draft: CompanyDraft }
  | { readonly _tag: "Malformed"; readonly error: MalformedDraftError };

const malformed = (problem: MalformedDraftError["problem"]): ParsedDraft => ({
  _tag: "Malformed",
  error: new MalformedDraftError({ problem }),
});

export function parseDraft(id: CompanyDraftId, contents: string): ParsedDraft {
  const normalized = contents.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return malformed("no_frontmatter");
  const end = normalized.indexOf("\n---", 3);
  const afterEnd = end === -1 ? -1 : end + 4;
  if (end === -1 || (afterEnd < normalized.length && normalized[afterEnd] !== "\n")) {
    return malformed("no_frontmatter");
  }
  let raw: unknown;
  try {
    raw = parseYaml(normalized.slice(4, end + 1));
  } catch {
    return malformed("invalid_yaml");
  }
  const decoded = decodeFrontmatter(raw);
  if (Exit.isFailure(decoded)) return malformed("invalid_fields");
  const { id: _fileId, ...fields } = decoded.value;
  return {
    _tag: "Draft",
    draft: {
      ...fields,
      id,
      path: draftPath(id),
      body: normalized.slice(Math.min(afterEnd + 1, normalized.length)),
    },
  };
}
