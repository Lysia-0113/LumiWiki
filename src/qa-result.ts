import { Type, type Static } from "typebox";

export const qaFinishSchema = Type.Object(
  {
    outcome: Type.Union([
      Type.Literal("answered"),
      Type.Literal("needs_clarification"),
      Type.Literal("insufficient_evidence"),
    ]),
    answer: Type.String({ minLength: 1, maxLength: 29999 }),
    scope: Type.Union([
      Type.Literal("general"),
      Type.Literal("context_specific"),
    ]),
    evidence: Type.Array(
      Type.Object(
        {
          kind: Type.Union([Type.Literal("doc"), Type.Literal("page")]),
          location: Type.String({ minLength: 1, maxLength: 4000 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 20 },
    ),
  },
  { additionalProperties: false },
);
export type QaFinish = Static<typeof qaFinishSchema>;
export type QaEvidence =
  | { kind: "doc"; location: string; fileId: string; sha256: string }
  | {
      kind: "page";
      location: string;
      browserId: string;
      observedAt: string;
    };
export interface QaAnswerResult extends Omit<QaFinish, "evidence"> {
  evidence: QaEvidence[];
}
export const evidenceKey = (ref: { kind: string; location: string }) =>
  `${ref.kind}:${ref.location}`;
