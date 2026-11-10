import { z } from '../../lib/zod';
import { count, dateTime, id, paginationMeta, settlementStatusEnum, won } from './common';

/** A `Settlement` row. The account fields are a masked snapshot taken on entering `PROCESSING`. */
const settlementFields = {
  id,
  freelancerId: id,
  periodStart: dateTime.openapi({ description: '월요일 00:00 KST' }),
  periodEnd: dateTime.openapi({ description: '다음 월요일 00:00 KST(제외)' }),
  scheduledPayoutAt: dateTime,
  status: settlementStatusEnum,
  itemCount: count,
  grossAmount: won,
  feeAmount: won,
  feeVatAmount: won,
  netAmount: won,
  payoutAttempts: count,
  bankName: z.string().nullable(),
  accountNumberMasked: z.string().nullable(),
  accountHolder: z.string().nullable(),
  providerReference: z.string().nullable(),
  failureReason: z.string().nullable(),
  paidAt: dateTime.nullable(),
  createdAt: dateTime,
  updatedAt: dateTime,
};

export const settlement = z.object(settlementFields).openapi('Settlement');

export const settlementList = z.object({ settlements: z.array(settlement), meta: paginationMeta });

const bucket = z.object({ count, net: won });

/** `GET /api/settlements/summary`. Every settlement lands in exactly one of `scheduled`, `onHold`, `failed`, `paidTotal`. */
export const settlementSummary = z.object({
  unsettled: z
    .object({ count, gross: won, fee: won, vat: won, net: won })
    .openapi({ description: '승인됐지만 아직 정산에 묶이지 않은 항목' }),
  scheduled: bucket,
  onHold: bucket,
  failed: bucket.openapi({ description: '재시도를 다 쓴 실패' }),
  paidTotal: won,
  nextBatchAt: dateTime.openapi({ description: '다음 주간 정산 배치(월요일 03:00 KST)' }),
  nextPayoutAt: dateTime.nullable(),
  hasPayoutAccount: z.boolean(),
});

/** `GET /api/settlements/:id`: the settlement and its items. */
export const settlementDetail = z.object({
  ...settlementFields,
  items: z.array(
    z.object({
      id,
      milestoneId: id,
      milestoneTitle: z.string(),
      milestoneSequence: z.number().int().min(1),
      contractId: id,
      projectId: id,
      projectTitle: z.string(),
      projectDeleted: z.boolean(),
      grossAmount: won,
      feeRateBps: z.number().int().openapi({ description: '승인 때의 수수료율(1000 = 10%)' }),
      feeAmount: won,
      feeVatAmount: won,
      netAmount: won,
      approvedAt: dateTime,
    }),
  ),
});
