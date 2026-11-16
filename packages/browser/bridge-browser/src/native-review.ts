/** Native human acknowledgement is authority to continue, never success evidence. */
import { z } from 'zod'
export const NATIVE_RECOVERY_PREPARE = 'bridge.browserRecovery.prepare'
export const NATIVE_RECOVERY_CONFIRM = 'bridge.browserRecovery.confirm'
export const reviewId = z.string().min(1).max(200).refine(value => value.trim() === value)
export const nativeReviewSchema = z.strictObject({
  source: z.literal('native-user'), reviewId, reviewedAt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  observationRequestId: reviewId, decision: z.enum(['applied', 'not-applied']),
})
export type NativeReview = z.infer<typeof nativeReviewSchema>
export const recoveryItemSchema = z.strictObject({ key: reviewId, kind: z.enum(['write', 'fact', 'recovery']), label: reviewId })
export const recoveryOfferSchema = z.strictObject({
  reviewId, expiresAt: z.number().int().min(1), observationRequestId: reviewId,
  items: z.array(recoveryItemSchema).max(64),
})
export type RecoveryOffer = z.infer<typeof recoveryOfferSchema>
export const recoveryDecisionsSchema = z.array(z.strictObject({ key: reviewId, decision: z.enum(['applied', 'not-applied', 'checked']) })).max(64)
export type RecoveryDecisions = z.infer<typeof recoveryDecisionsSchema>
export const recoveryCommitSchema = z.strictObject({ reviewed: z.literal(true), resumed: z.literal(false), completed: z.literal(false) })
export type RecoveryReply = RecoveryOffer | z.infer<typeof recoveryCommitSchema>
