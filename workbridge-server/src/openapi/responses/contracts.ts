import { z } from '../../lib/zod';
import {
  approvalTypeEnum,
  contractStatusEnum,
  count,
  dateTime,
  id,
  legacyWon,
  milestoneStatusEnum,
  paginationMeta,
  paymentStatusEnum,
  projectStatusEnum,
  roleEnum,
  submissionDecisionEnum,
  userCard,
  won,
} from './common';

/** A `Contract` row. */
export const contractFields = {
  id,
  projectId: id,
  applicationId: id,
  clientId: id,
  freelancerId: id,
  amount: legacyWon,
  startDate: dateTime,
  endDate: dateTime,
  clientSigned: z.boolean(),
  freelancerSigned: z.boolean(),
  status: contractStatusEnum,
  completedAt: dateTime.nullable(),
  createdAt: dateTime,
};

export const contract = z.object(contractFields).openapi('Contract');

/** A `Payment` row. */
export const payment = z
  .object({
    id,
    contractId: id,
    milestoneId: id,
    clientId: id,
    amount: won,
    status: paymentStatusEnum,
    paymentKey: z.string().nullable(),
    orderId: z.string(),
    createdAt: dateTime,
  })
  .openapi('Payment');

/** A stored attachment: exactly these keys. */
export const attachment = z
  .object({
    id,
    url: z.string().nullable().openapi({
      description:
        '15분 동안 유효한 서명 다운로드 URL(비공개 버킷). 오래된 첨부는 공개 URL 그대로. 서명에 실패하면 `null` — '
        + '내려받을 때는 첨부 다운로드 경로로 새 URL을 받는다.',
    }),
    fileName: z.string(),
    mimeType: z.string(),
    size: z.number().int().min(0).openapi({ description: '바이트' }),
    createdAt: dateTime,
  })
  .openapi('Attachment');

/** A `MilestoneSubmission` row with its attachments. `decision: null` = awaiting review. */
export const submission = z
  .object({
    id,
    milestoneId: id,
    round: z.number().int().min(1),
    message: z.string(),
    links: z.array(z.string()),
    decision: submissionDecisionEnum.nullable(),
    decisionReason: z.string().nullable(),
    decidedAt: dateTime.nullable(),
    decidedById: id.nullable().openapi({ description: '자동 승인이면 `null`' }),
    autoDecided: z.boolean(),
    submittedAt: dateTime,
    attachments: z.array(attachment),
  })
  .openapi('MilestoneSubmission');

/** `fee = floor(gross × 10%)`, `vat = floor(fee × 10%)`, `net = gross − fee − vat`. */
export const payoutBreakdown = z
  .object({ gross: won, fee: won, vat: won, net: won })
  .openapi('PayoutBreakdown');

/** `serializeMilestone`: the row plus `payment`, `latestSubmission` and `payoutPreview`. */
export const milestoneFields = {
  id,
  contractId: id,
  sequence: z.number().int().min(1),
  title: z.string(),
  description: z.string().nullable(),
  amount: won,
  dueDate: dateTime.openapi({ description: '마감일의 KST 23:59:59.999' }),
  status: milestoneStatusEnum,
  fundedAt: dateTime.nullable(),
  submittedAt: dateTime.nullable(),
  autoApproveAt: dateTime.nullable().openapi({ description: '`SUBMITTED`일 때만 값이 있다' }),
  approvedAt: dateTime.nullable(),
  approvalType: approvalTypeEnum.nullable(),
  revisionCount: count,
  createdAt: dateTime,
  updatedAt: dateTime,
  payment: payment.nullable(),
  latestSubmission: submission.nullable(),
  payoutPreview: payoutBreakdown.openapi({ description: '승인됐으면 정산 항목의 값, 아니면 지금 수수료율로 계산한 값' }),
};

export const milestone = z.object(milestoneFields).openapi('Milestone');

/** The contract's milestone totals (`milestoneSummary`). */
export const milestoneSummary = z
  .object({
    count,
    contractAmount: won,
    fundedAmount: won,
    approvedAmount: won,
    approvedCount: count,
  })
  .openapi('MilestoneSummary');

const reviewWithParties = z.object({
  id,
  contractId: id,
  reviewerId: id,
  revieweeId: id,
  rating: z.number().int().min(1).max(5),
  content: z.string(),
  tags: z.array(z.string()),
  createdAt: dateTime,
  reviewer: userCard,
  reviewee: userCard,
});

/** `serializeContract`: `GET /api/contracts/:id` and the sign route. */
export const contractDetail = z
  .object({
    ...contractFields,
    project: z.object({
      id,
      title: z.string(),
      description: z.string(),
      category: z.string(),
      status: projectStatusEnum,
    }),
    client: z.object({
      id,
      name: z.string(),
      email: z.string(),
      companyName: z.string().nullable(),
      profileImage: z.string().nullable(),
    }),
    freelancer: z.object({
      id,
      name: z.string(),
      email: z.string(),
      skills: z.array(z.string()),
      profileImage: z.string().nullable(),
    }),
    milestones: z.array(milestone),
    reviews: z.array(reviewWithParties),
    milestoneSummary,
  })
  .openapi('ContractDetail');

/** `listContracts`: the caller's contracts, each with its unread message count. */
export const contractList = z.object({
  contracts: z.array(
    z
      .object({
        id,
        status: contractStatusEnum,
        amount: legacyWon,
        startDate: dateTime,
        endDate: dateTime,
        completedAt: dateTime.nullable(),
        clientSigned: z.boolean(),
        freelancerSigned: z.boolean(),
        createdAt: dateTime,
        myRole: roleEnum,
        project: z.object({ id, title: z.string(), status: projectStatusEnum }),
        counterpart: userCard,
        milestoneSummary,
        unreadMessageCount: count,
      })
      .openapi('ContractListItem'),
  ),
  meta: paginationMeta,
});

/** `GET /api/contracts/:id/milestones`. */
export const contractMilestones = z.object({ milestones: z.array(milestone), milestoneSummary });

/** `PUT /api/contracts/:id/milestones`: the contract's changed fields (signatures reset) and the new plan. */
export const replacedPlan = z.object({
  contract: z.object({
    id,
    status: contractStatusEnum,
    amount: legacyWon,
    endDate: dateTime,
    clientSigned: z.boolean(),
    freelancerSigned: z.boolean(),
  }),
  milestones: z.array(milestone),
});

/** `GET /api/contracts/:id/conversation`: the conversation id and the caller's unread count. */
export const contractConversation = z.object({ id, unreadCount: count });

/** `GET /api/milestones/:id`. */
export const milestoneDetail = z.object({
  ...milestoneFields,
  submissions: z.array(submission).openapi({ description: '회차 내림차순' }),
  contract: z.object({
    id,
    status: contractStatusEnum,
    amount: legacyWon,
    clientId: id,
    freelancerId: id,
    project: z.object({ id, title: z.string() }),
  }),
});

/** A new submission round and the milestone it moved to `SUBMITTED`. */
export const submissionCreated = z.object({ milestone, submission });

/** A manual approval. */
export const milestoneApproved = z.object({
  milestone,
  contract: z.object({ id, status: contractStatusEnum, completedAt: dateTime.nullable() }),
});

/** A revision request. */
export const milestoneRejected = z.object({ milestone });

/** `POST /api/payments`: the payment to open the TossPayments window with. */
export const paymentOrder = z.object({ orderId: z.string(), amount: won, paymentId: id });

/** `GET /api/payments`: the caller's payments with their contract and milestone. */
export const paymentWithContext = z.object({
  ...payment.shape,
  contract: z.object({
    ...contractFields,
    project: z.object({ id, title: z.string() }),
    freelancer: z.object({ id, name: z.string() }),
  }),
  milestone: z.object({ id, sequence: z.number().int(), title: z.string() }),
});

/** `POST /api/conversations/:id/uploads`, `POST /api/milestones/:id/uploads`. */
export const uploadsIssued = z.object({
  uploads: z.array(
    z.object({
      id: id.openapi({ description: '메시지·제출을 만들 때 `uploadIds`에 넣는다' }),
      fileName: z.string(),
      mimeType: z.string(),
      size: z.number().int().min(0).openapi({ description: '바이트(브라우저가 알린 값)' }),
      uploadUrl: z.string().openapi({
        description: '서명 업로드 URL. 파일 본문을 `PUT`하고 `Content-Type`에 `mimeType`을 넣는다. 한 번만 쓸 수 있다.',
      }),
      expiresAt: dateTime.openapi({ description: '업로드 URL과 이 업로드가 만료되는 시각(2시간)' }),
    }),
  ).openapi({ description: '요청한 파일 순서' }),
});

/** The download routes of message and submission attachments. */
export const attachmentDownload = z.object({
  url: z.string().openapi({ description: '원래 파일 이름으로 내려받는 서명 URL(60초). 오래된 첨부는 공개 URL' }),
  expiresAt: dateTime.nullable().openapi({ description: '만료 시각. 오래된 공개 URL이면 `null`' }),
});
