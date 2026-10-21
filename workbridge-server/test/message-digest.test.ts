import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@prisma/client';

import { authed } from './helpers/api';
import { prisma } from './helpers/db';
import { jobsOf, runJobs } from './helpers/jobs';
import { makeContractScenario, makeEmailDelivery, makeMessage, makeNotificationPreference } from './helpers/factories';
import { enqueueJob } from '../src/jobs/queue';
import { setMailProvider } from '../src/lib/mail/provider';
import type { MailMessage, MailProvider } from '../src/lib/mail/provider';
import { MINUTE_MS } from '../src/lib/time';

/**
 * The unread-message digest completed by Phase 3: J8 steps 3–4 as NC16 specifies them — the
 * 60-minute throttle and the email-only `MESSAGE_UNREAD_DIGEST` through `notify()`, sent by its
 * `notification.email` job on a later runner pass. Driven by `runDueJobs({ now })` alone.
 */

class RecordingProvider implements MailProvider {
  sent: MailMessage[] = [];
  async send(message: MailMessage) {
    this.sent.push(message);
    return { providerMessageId: `rec-${this.sent.length}` };
  }
}

let provider: RecordingProvider;
let previous: MailProvider;
beforeEach(() => {
  provider = new RecordingProvider();
  previous = setMailProvider(provider);
});
afterEach(() => {
  setMailProvider(previous);
});

const T0 = new Date('2026-06-01T00:00:00.000Z').getTime();
const at = (minutes: number) => new Date(T0 + minutes * MINUTE_MS);

const digestJobs = async (recipientId: string) =>
  (await jobsOf('message.unreadDigest')).filter((j) => (j.payload as { recipientId: string }).recipientId === recipientId);
const digestDeliveries = (userId: string) =>
  prisma.emailDelivery.findMany({ where: { userId, type: 'MESSAGE_UNREAD_DIGEST' }, orderBy: { createdAt: 'asc' } });

/** MG15's enqueue as the send path does it, at a fixed time. */
const enqueueDigest = (conversationId: string, recipientId: string, runAt: Date) =>
  enqueueJob(prisma, { type: 'message.unreadDigest', payload: { conversationId, recipientId }, runAt });

describe('unread digest — send path (J8 step 4) [NC16]', () => {
  it('a message left unread: the digest run creates one email-only delivery, a later pass sends it [NC16] [J8] [J9]', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    const sent = await authed(client).post(`/api/conversations/${conversation.id}/messages`).send({ body: '확인 부탁드립니다' });
    expect(sent.status).toBe(201);
    const now = new Date(new Date(sent.body.message.createdAt).getTime() + 11 * MINUTE_MS);

    const first = await runJobs(now);

    expect(first).toMatchObject({ claimed: 1, succeeded: 1 });
    const [delivery] = await digestDeliveries(freelancer.id);
    expect(delivery).toMatchObject({
      userId: freelancer.id,
      type: 'MESSAGE_UNREAD_DIGEST',
      contextKey: `conversation:${conversation.id}`,
      notificationId: null,
      toAddress: freelancer.email,
      status: 'PENDING',
    });
    expect(delivery.createdAt.getTime()).toBe(now.getTime());
    expect(delivery.body).toContain(`/messages/${conversation.id}`); // NC16's href, not wording
    expect(await prisma.notification.count()).toBe(0); // the digest's in-app channel is locked off
    const [emailJob] = await jobsOf('notification.email');
    expect(emailJob).toMatchObject({ status: 'PENDING', payload: { deliveryId: delivery.id } });
    expect(provider.sent).toHaveLength(0); // not in the pass that created it

    const second = await runJobs(now);

    expect(second).toMatchObject({ claimed: 1, succeeded: 1 });
    expect((await digestDeliveries(freelancer.id))[0].status).toBe('SENT');
    expect(provider.sent.map((m) => m.to)).toEqual([freelancer.email]);
    expect(await digestDeliveries(client.id)).toHaveLength(0);
  });

  it('a recipient who turned the digest off gets nothing, and nothing is re-enqueued [NC16] [NC3]', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    await makeNotificationPreference(freelancer.id, 'MESSAGE_UNREAD_DIGEST', { email: false });
    await makeMessage(conversation.id, client.id, { createdAt: at(0) });
    await enqueueDigest(conversation.id, freelancer.id, at(10));

    await runJobs(at(10));
    await runJobs(at(10));

    expect(await prisma.emailDelivery.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
    expect((await digestJobs(freelancer.id)).map((j) => j.status)).toEqual(['SUCCEEDED']);
    expect(await jobsOf('notification.email')).toHaveLength(0);
  });

  it('a later message after a turned-off digest schedules its own job as usual [NC16] [MG15]', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    await makeNotificationPreference(freelancer.id, 'MESSAGE_UNREAD_DIGEST', { email: false });

    await authed(client).post(`/api/conversations/${conversation.id}/messages`).send({ body: '하나' });
    const [job] = await digestJobs(freelancer.id);
    await runJobs(job.runAt);
    await authed(client).post(`/api/conversations/${conversation.id}/messages`).send({ body: '둘' });

    expect((await digestJobs(freelancer.id)).map((j) => j.status)).toEqual(['SUCCEEDED', 'PENDING']);
  });
});

describe('unread digest — throttle path (J8 step 3) [NC16]', () => {
  it('the NC16 example: a second message within the hour is held and sent with the first 60 minutes after the last digest [NC16] [J8]', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    // Message A at t0 → digest delivery at t0 + 10.
    await makeMessage(conversation.id, client.id, { createdAt: at(0) });
    await enqueueDigest(conversation.id, freelancer.id, at(10));
    await runJobs(at(10));
    await runJobs(at(10));
    expect((await digestDeliveries(freelancer.id)).map((d) => d.status)).toEqual(['SENT']);

    // Message B at t0 + 20 schedules a job for t0 + 30, which finds the delivery 20 minutes old.
    await makeMessage(conversation.id, client.id, { createdAt: at(20) });
    await enqueueDigest(conversation.id, freelancer.id, at(30));
    const throttled = await runJobs(at(30));
    await runJobs(at(30));

    expect(throttled).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await digestDeliveries(freelancer.id)).toHaveLength(1);
    const pending = (await digestJobs(freelancer.id)).filter((j) => j.status === 'PENDING');
    expect(pending.map((j) => j.runAt.getTime())).toEqual([at(70).getTime()]);
    expect(pending[0].payload).toEqual({ conversationId: conversation.id, recipientId: freelancer.id });

    // At t0 + 70 the last digest is exactly 60 minutes old: one digest covering both messages.
    await runJobs(at(70));
    await runJobs(at(70));

    const deliveries = await digestDeliveries(freelancer.id);
    expect(deliveries.map((d) => [d.status, d.createdAt.getTime()])).toEqual([
      ['SENT', at(10).getTime()],
      ['SENT', at(70).getTime()],
    ]);
    expect(provider.sent).toHaveLength(2);
    expect((await digestJobs(freelancer.id)).every((j) => j.status === 'SUCCEEDED')).toBe(true);
  });

  it('just under 60 minutes is throttled; exactly 60 minutes sends [NC16] [MG1]', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    const contextKey = `conversation:${conversation.id}`;
    await makeEmailDelivery(freelancer, { type: 'MESSAGE_UNREAD_DIGEST', contextKey, status: 'SENT', createdAt: at(0) });
    await makeMessage(conversation.id, client.id, { createdAt: at(30) });
    await enqueueDigest(conversation.id, freelancer.id, new Date(at(60).getTime() - 1));

    await runJobs(new Date(at(60).getTime() - 1));

    expect(await digestDeliveries(freelancer.id)).toHaveLength(1);
    expect((await digestJobs(freelancer.id)).find((j) => j.status === 'PENDING')?.runAt.getTime()).toBe(at(60).getTime());

    await runJobs(at(60));

    expect(await digestDeliveries(freelancer.id)).toHaveLength(2);
  });

  it.each(['PENDING', 'FAILED', 'SKIPPED'] as const)(
    'a %s digest delivery throttles too — the newest delivery in any status counts [NC16]',
    async (status) => {
      const { client, freelancer, conversation } = await makeContractScenario();
      await makeEmailDelivery(freelancer, {
        type: 'MESSAGE_UNREAD_DIGEST',
        contextKey: `conversation:${conversation.id}`,
        status,
        createdAt: at(0),
      });
      await makeMessage(conversation.id, client.id, { createdAt: at(5) });
      await enqueueDigest(conversation.id, freelancer.id, at(15));

      await runJobs(at(15));

      expect(await digestDeliveries(freelancer.id)).toHaveLength(1);
      expect((await digestJobs(freelancer.id)).map((j) => j.status)).toEqual(['SUCCEEDED', 'PENDING']);
    },
  );

  it('the throttled re-run is not added when a PENDING digest for the pair exists [NC16] [J8]', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    await makeEmailDelivery(freelancer, { type: 'MESSAGE_UNREAD_DIGEST', contextKey: `conversation:${conversation.id}`, createdAt: at(0) });
    await makeMessage(conversation.id, client.id, { createdAt: at(5) });
    await enqueueDigest(conversation.id, freelancer.id, at(15));
    await enqueueDigest(conversation.id, freelancer.id, at(90));

    await runJobs(at(15));

    expect((await digestJobs(freelancer.id)).map((j) => [j.status, j.runAt.getTime()])).toEqual([
      ['SUCCEEDED', at(15).getTime()],
      ['PENDING', at(90).getTime()],
    ]);
  });

  it('only this conversation and recipient count: other digests do not throttle [NC16]', async () => {
    const a = await makeContractScenario();
    const b = await makeContractScenario({ contract: { freelancerId: a.freelancer.id } });
    // A recent digest for the same recipient in another conversation, and one for the other party.
    await makeEmailDelivery(a.freelancer, { type: 'MESSAGE_UNREAD_DIGEST', contextKey: `conversation:${b.conversation.id}`, createdAt: at(0) });
    await makeEmailDelivery(a.client as User, { type: 'MESSAGE_UNREAD_DIGEST', contextKey: `conversation:${a.conversation.id}`, createdAt: at(0) });
    // A non-digest email with the same context does not count either.
    await makeEmailDelivery(a.freelancer, { type: 'MILESTONE_FUNDED', contextKey: null, createdAt: at(0) });
    await makeMessage(a.conversation.id, a.client.id, { createdAt: at(1) });
    await enqueueDigest(a.conversation.id, a.freelancer.id, at(11));

    await runJobs(at(11));

    const mine = await prisma.emailDelivery.findMany({
      where: { userId: a.freelancer.id, contextKey: `conversation:${a.conversation.id}` },
    });
    expect(mine).toHaveLength(1);
    expect(mine[0].createdAt.getTime()).toBe(at(11).getTime());
  });

  it('a read before the throttled re-run leaves nothing to send [NC16] [J8]', async () => {
    const { client, freelancer, conversation } = await makeContractScenario();
    await makeEmailDelivery(freelancer, { type: 'MESSAGE_UNREAD_DIGEST', contextKey: `conversation:${conversation.id}`, createdAt: at(0) });
    const message = await makeMessage(conversation.id, client.id, { createdAt: at(5) });
    await enqueueDigest(conversation.id, freelancer.id, at(15));
    await runJobs(at(15));
    await prisma.conversationParticipant.updateMany({
      where: { conversationId: conversation.id, userId: freelancer.id },
      data: { lastReadAt: message.createdAt },
    });

    await runJobs(at(60));

    expect(await digestDeliveries(freelancer.id)).toHaveLength(1);
    expect((await digestJobs(freelancer.id)).map((j) => j.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
  });
});
