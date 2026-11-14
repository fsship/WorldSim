import { z } from 'zod';

const reference = z.string().trim().min(1).max(160);
const minute = z.number().int().safe().nonnegative();
const message = z.string().trim().min(1).max(400).regex(/[\p{L}\p{N}]/u);

export const CommitmentAudienceSchema = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('person'),id:reference}).strict(),
  z.object({kind:z.literal('group'),id:reference}).strict(),
  z.object({kind:z.literal('room'),id:reference.optional()}).strict(),
]);
export type CommitmentAudience = z.infer<typeof CommitmentAudienceSchema>;

// The reviewer only extracts words that were actually exchanged. Stable world
// references and scheduling are assigned by the engine after the reply is heard.
export const ReviewedRelaySchema = z.object({
  acceptsEntireReply:z.literal(true),destination:reference,
  audience:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('person'),name:reference}).strict(),
    z.object({kind:z.literal('group'),name:reference}).strict(),
    z.object({kind:z.literal('room'),name:reference.optional()}).strict(),
  ]), message,
}).strict();
// Bind the verdict to the actual text locally, never to an excerpt generated
// by the reviewer. Only the reviewed reply can later authorize a commitment.
export const RelayAcceptanceSchema = ReviewedRelaySchema.omit({acceptsEntireReply:true}).extend({acceptance:message});
export type RelayAcceptance = z.infer<typeof RelayAcceptanceSchema>;

export const NpcCommitmentSchema = z.object({
  id:z.string().min(1),actorId:reference,destinationId:reference,audience:CommitmentAudienceSchema,
  message,requestEventId:z.string().min(1),replyEventId:z.string().min(1),
  createdAt:minute,nextAt:minute,status:z.enum(['pending','delivered','failed']),
  failureReason:z.string().trim().min(1).max(400).optional(),
}).strict();
export type NpcCommitment = z.infer<typeof NpcCommitmentSchema>;
