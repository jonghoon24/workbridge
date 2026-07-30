import bcrypt from 'bcryptjs';
import type { Application, Contract, Payment, Prisma, Project, User } from '@prisma/client';

import { prisma } from './db';

export const TEST_PASSWORD = 'password123';

/** Monotonic so generated emails and order ids stay unique within a run. */
let seq = 0;
const next = () => ++seq;

export const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000);

/**
 * A low bcrypt cost keeps the suite fast. `bcrypt.compare` reads the cost from the hash, so
 * login still works exactly as it does in production.
 */
async function hash(password: string) {
  return bcrypt.hash(password, 4);
}

export async function makeUser(overrides: Partial<Prisma.UserCreateInput> = {}): Promise<User> {
  const n = next();
  return prisma.user.create({
    data: {
      email: `user${n}@test.local`,
      name: `User ${n}`,
      role: 'FREELANCER',
      password: await hash(TEST_PASSWORD),
      ...overrides,
    },
  });
}

/** A CLIENT with a **complete** profile, so it passes `requireCompleteProfile`. */
export function makeClient(overrides: Partial<Prisma.UserCreateInput> = {}): Promise<User> {
  return makeUser({
    role: 'CLIENT',
    companyName: 'Test Company',
    businessField: 'IT',
    ...overrides,
  });
}

/** A FREELANCER with a **complete** profile. */
export function makeFreelancer(overrides: Partial<Prisma.UserCreateInput> = {}): Promise<User> {
  return makeUser({
    role: 'FREELANCER',
    skills: ['React', 'Node.js'],
    activityCategory: '웹 개발',
    experienceYears: 3,
    hourlyRate: 50_000,
    ...overrides,
  });
}

export function makeProject(
  clientId: string,
  overrides: Partial<Prisma.ProjectUncheckedCreateInput> = {},
): Promise<Project> {
  const n = next();
  return prisma.project.create({
    data: {
      title: `Project ${n}`,
      description: `Description for project ${n}`,
      category: '웹 개발',
      budget: 5_000_000,
      requiredSkills: ['React'],
      recruitmentStartDate: daysFromNow(-1),
      deadline: daysFromNow(30),
      status: 'OPEN',
      clientId,
      ...overrides,
    },
  });
}

export function makeApplication(
  projectId: string,
  freelancerId: string,
  overrides: Partial<Prisma.ApplicationUncheckedCreateInput> = {},
): Promise<Application> {
  return prisma.application.create({
    data: {
      projectId,
      freelancerId,
      coverLetter: 'I would like to work on this project.',
      expectedRate: 4_000_000,
      expectedDuration: '4주',
      ...overrides,
    },
  });
}

export function makeContract(
  ids: { projectId: string; applicationId: string; clientId: string; freelancerId: string },
  overrides: Partial<Prisma.ContractUncheckedCreateInput> = {},
): Promise<Contract> {
  return prisma.contract.create({
    data: {
      ...ids,
      amount: 4_000_000,
      startDate: daysFromNow(0),
      endDate: daysFromNow(30),
      ...overrides,
    },
  });
}

export function makePayment(
  contractId: string,
  clientId: string,
  overrides: Partial<Prisma.PaymentUncheckedCreateInput> = {},
): Promise<Payment> {
  return prisma.payment.create({
    data: {
      contractId,
      clientId,
      amount: 4_000_000,
      orderId: `order-${next()}`,
      ...overrides,
    },
  });
}

/**
 * The full chain most contract, payment, and review tests need: a client, a freelancer, a
 * project whose recruitment has closed, an accepted application, and the resulting contract.
 *
 * Pass `contract` overrides to place the contract in a particular state, e.g.
 * `makeContractScenario({ contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true } })`.
 */
export async function makeContractScenario(overrides: {
  project?: Partial<Prisma.ProjectUncheckedCreateInput>;
  application?: Partial<Prisma.ApplicationUncheckedCreateInput>;
  contract?: Partial<Prisma.ContractUncheckedCreateInput>;
} = {}) {
  const client = await makeClient();
  const freelancer = await makeFreelancer();
  const project = await makeProject(client.id, { status: 'CLOSED', ...overrides.project });
  const application = await makeApplication(project.id, freelancer.id, {
    status: 'ACCEPTED',
    ...overrides.application,
  });
  const contract = await makeContract(
    {
      projectId: project.id,
      applicationId: application.id,
      clientId: client.id,
      freelancerId: freelancer.id,
    },
    overrides.contract,
  );

  return { client, freelancer, project, application, contract };
}
