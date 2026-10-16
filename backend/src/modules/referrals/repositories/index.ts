import { prisma } from '../../../db/prisma-client';
import type { Prisma, ReferralStatus } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function createReferral(
  db: DbClient,
  data: {
    patientProfileId: string;
    referringDoctorId: string;
    targetDoctorId: string;
    targetSpecialtyId?: string;
    snapshotNotes: string;
  },
) {
  return db.referral.create({ data });
}

export function findReferralById(db: DbClient, id: string) {
  return db.referral.findUnique({ where: { id } });
}

/**
 * The referral state machine's only write path: a conditional UPDATE that
 * matches the expected *current* (status, resultingAppointmentId) pair —
 * the same shape as availability's claimOpenSlot. Two callers racing on
 * the same referral (a double-fired cascade hook, a concurrent accept)
 * can never both match; the loser sees `count === 0`. This is what makes
 * the cascade rules idempotent by construction (issue #67), rather than
 * trusting callers to only fire once.
 */
export function updateReferralConditional(
  db: DbClient,
  expected: { id: string; status: ReferralStatus; resultingAppointmentId: string | null },
  data: {
    status?: ReferralStatus;
    resultingAppointmentId?: string | null;
    noShowCount?: number;
    referringDoctorNotifiedAt?: Date;
  },
) {
  return db.referral.updateMany({
    where: {
      id: expected.id,
      status: expected.status,
      resultingAppointmentId: expected.resultingAppointmentId,
    },
    data,
  });
}

export function listReferralsForPatient(patientProfileId: string) {
  return prisma.referral.findMany({
    where: { patientProfileId },
    orderBy: { createdAt: 'desc' },
  });
}

export function listReferralsCreatedBy(referringDoctorId: string) {
  return prisma.referral.findMany({
    where: { referringDoctorId },
    orderBy: { createdAt: 'desc' },
  });
}
