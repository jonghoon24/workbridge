import type { NotificationType } from './types';

/**
 * Wording and links of the Phase 1 notification types (BEHAVIOR.md "Notifications" table).
 * The four pre-existing types keep their strings inline in the old controllers — intended debt.
 */

export type TemplateType = Exclude<
  NotificationType,
  'APPLICATION_CREATED' | 'APPLICATION_ACCEPTED' | 'APPLICATION_REJECTED' | 'PROJECT_STATUS_CHANGED'
>;

export interface TemplateVars {
  projectTitle?: string;
  contractId?: string;
  milestoneId?: string;
  milestoneTitle?: string;
  settlementId?: string;
  /** Whole won, pre-formatted by the caller is not required — formatted here. */
  amount?: number;
  reason?: string;
}

export interface RenderedNotification {
  title: string;
  message: string;
  href: string;
}

const won = (amount = 0) => `${amount.toLocaleString('ko-KR')}원`;
const contractHref = (v: TemplateVars) => `/contracts/${v.contractId}`;
const milestoneHref = (v: TemplateVars) => `/contracts/${v.contractId}/milestones/${v.milestoneId}`;
const settlementHref = (v: TemplateVars) => `/settlements/${v.settlementId}`;
const ms = (v: TemplateVars) => `'${v.milestoneTitle}'`;

const TEMPLATES: Record<TemplateType, (v: TemplateVars) => RenderedNotification> = {
  CONTRACT_ACTIVATED: (v) => ({
    title: '계약이 체결되었습니다',
    message: `'${v.projectTitle}' 계약에 양측이 서명했습니다. 첫 마일스톤 결제부터 진행해주세요.`,
    href: contractHref(v),
  }),
  MILESTONE_PLAN_UPDATED: (v) => ({
    title: '마일스톤 계획이 변경되었습니다',
    message: `'${v.projectTitle}' 계약의 마일스톤 계획이 바뀌어 서명이 초기화되었습니다. 다시 확인하고 서명해주세요.`,
    href: contractHref(v),
  }),
  MILESTONE_FUNDED: (v) => ({
    title: '마일스톤 결제가 완료되었습니다',
    message: `마일스톤 ${ms(v)}에 ${won(v.amount)}이 예치되었습니다. 작업을 시작해주세요.`,
    href: milestoneHref(v),
  }),
  MILESTONE_SUBMITTED: (v) => ({
    title: '산출물이 제출되었습니다',
    message: `마일스톤 ${ms(v)}의 산출물이 제출되었습니다. 검수 후 승인하거나 수정을 요청해주세요.`,
    href: milestoneHref(v),
  }),
  MILESTONE_REVISION_REQUESTED: (v) => ({
    title: '수정 요청이 도착했습니다',
    message: `마일스톤 ${ms(v)}에 수정 요청이 있습니다: ${v.reason ?? ''}`.trim(),
    href: milestoneHref(v),
  }),
  MILESTONE_APPROVED: (v) => ({
    title: '마일스톤이 승인되었습니다',
    message: `마일스톤 ${ms(v)}이 승인되었습니다. 다음 정산에 포함됩니다.`,
    href: milestoneHref(v),
  }),
  MILESTONE_AUTO_APPROVED: (v) => ({
    title: '마일스톤이 자동 승인되었습니다',
    message: `검수 기간이 지나 마일스톤 ${ms(v)}이 자동으로 승인되었습니다.`,
    href: milestoneHref(v),
  }),
  MILESTONE_AUTO_APPROVE_REMINDER: (v) => ({
    title: '곧 자동 승인됩니다',
    message: `마일스톤 ${ms(v)}이 48시간 뒤 자동 승인됩니다. 그 전에 검수해주세요.`,
    href: milestoneHref(v),
  }),
  MILESTONE_DUE_SOON: (v) => ({
    title: '마일스톤 기한이 다가옵니다',
    message: `마일스톤 ${ms(v)}의 기한이 24시간 남았습니다.`,
    href: milestoneHref(v),
  }),
  MILESTONE_OVERDUE: (v) => ({
    title: '마일스톤 기한이 지났습니다',
    message: `마일스톤 ${ms(v)}의 기한이 지났습니다. 일정을 다시 협의해주세요.`,
    href: milestoneHref(v),
  }),
  CONTRACT_COMPLETED: (v) => ({
    title: '계약이 완료되었습니다',
    message: `'${v.projectTitle}' 계약의 모든 마일스톤이 승인되었습니다. 리뷰를 남겨주세요.`,
    href: `${contractHref(v)}#review`,
  }),
  SETTLEMENT_SCHEDULED: (v) => ({
    title: '정산이 예정되었습니다',
    message: `${won(v.amount)} 정산이 예정되었습니다.`,
    href: settlementHref(v),
  }),
  SETTLEMENT_PAID: (v) => ({
    title: '정산금이 지급되었습니다',
    message: `${won(v.amount)}이 지급 계좌로 입금되었습니다.`,
    href: settlementHref(v),
  }),
  SETTLEMENT_ON_HOLD: (v) => ({
    title: '정산이 보류되었습니다',
    message: `지급 계좌가 없어 ${won(v.amount)} 정산이 보류되었습니다. 지급 계좌를 등록해주세요.`,
    href: '/settlements/account',
  }),
  SETTLEMENT_FAILED: (v) => ({
    title: '정산 지급에 실패했습니다',
    message: `${won(v.amount)} 지급이 반복해서 실패했습니다. 고객센터로 문의해주세요.`,
    href: settlementHref(v),
  }),
};

export function renderTemplate(type: TemplateType, vars: TemplateVars): RenderedNotification {
  return TEMPLATES[type](vars);
}
