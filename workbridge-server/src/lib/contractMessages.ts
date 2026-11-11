/**
 * Conflict messages about a contract's state that several services and the legacy contract
 * controller share. Here rather than in `contracts.service.ts`, which imports the milestone
 * service: importing it back from there would be a cycle.
 */

/** Any action on a cancelled contract — cancelling it again, signing it, replacing its plan. */
export const CONTRACT_CANCELLED = 'This contract has been cancelled';

/** Cancelling a contract that both parties already signed (ACTIVE) or that is COMPLETED. */
export const CONTRACT_NOT_CANCELLABLE = 'Only a contract awaiting signatures can be cancelled';
