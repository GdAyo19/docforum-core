// Referrals services — the only exported surface other modules (and this
// module's own controllers) may call. Never import repositories/* from
// outside this module.
//
// NOTE: this module and appointments/services import each other (accept
// creates an appointment via the appointments service; appointment status
// changes cascade back through applyAppointmentOutcome below). The cycle
// is runtime-safe under CJS/ESM live bindings — every cross-call happens
// inside an async function, after both modules have finished loading —
// and is the smallest seam that keeps each module owning its own table
// (ARCHITECTURE.md §3 / ARCHITECTURE_ESSENTIALS.md hard rule 4).
import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import type { Prisma } from '@prisma/client';
import * as referralsRepo from '../repositories';
import * as appointmentsService from '../../appointments/services';
import * as doctorsService from '../../doctors/services';
import * as patientsService from '../../patients/services';

/** How many referral-origin no-shows it takes to give up on a referral
 * (PRD §8.2.3: "repeated no-shows → expired"). Two is a deliberately
 * boring v1 default, not a tuned threshold — revisit when real no-show
 * data exists. Lives here, not in config, so the cascade and its tests
 * read from one place. */
export const NO_SHOW_EXPIRY_THRESHOLD = 2;

export interface CreateReferralInput {
  patientProfileId: string;
  targetDoctorId: string;
  targetSpecialtyId?: string;
  snapshotNotes: string;
}

/** Doctor-initiated referral creation (issue #5 minimal path — v1 creates
 * the referral directly; re-wiring creation through a Consultation with
 * outcome `referred` stays issue #5's scope, and `sourceConsultationId`
 * with it). The snapshot guarantee (FR-7/FR-8, hard rule 3) is honoured
 * for what exists today: `snapshotNotes` is a copy taken now, never a live
 * reference to anything editable elsewhere. */
export async function createReferral(userId: string, input: CreateReferralInput) {
  const referringDoctor = await doctorsService.getMyDoctorProfile(userId);
  await doctorsService.getDoctorProfileById(input.targetDoctorId); // 404s if missing
  await patientsService.getPatientProfileById(input.patientProfileId); // 404s if missing

  return referralsRepo.createReferral(prisma, {
    patientProfileId: input.patientProfileId,
    referringDoctorId: referringDoctor.id,
    targetDoctorId: input.targetDoctorId,
    targetSpecialtyId: input.targetSpecialtyId,
    snapshotNotes: input.snapshotNotes,
  });
}

/**
 * Patient accepts a pending referral: one transaction that flips the
 * referral pending → accepted (conditional — the concurrency gate), then
 * books the pre-populated appointment against the target doctor through
 * the appointments service (slot claim + Appointment row, origin
 * 'referral'). The patient picks the slot; the appointment is
 * "pre-populated" in the FR-8 sense — no re-intake, the snapshot travels
 * on the referral — not in the sense of an auto-chosen time.
 */
export async function acceptReferral(userId: string, referralId: string, availabilitySlotId: string) {
  const patientProfile = await patientsService.getMyPatientProfile(userId);

  return prisma.$transaction(async (tx) => {
    const referral = await referralsRepo.findReferralById(tx, referralId);
    if (!referral) throw new HttpError(404, 'Referral not found.');
    if (referral.patientProfileId !== patientProfile.id) {
      throw new HttpError(403, 'This referral is not for you.');
    }
    if (referral.status !== 'pending') {
      throw new HttpError(409, 'Only a pending referral can be accepted.');
    }

    // Conditional pending → accepted FIRST: if two accepts race, exactly
    // one matches, same shape as claimOpenSlot (hard rule 2's philosophy,
    // applied to referral state).
    const claimed = await referralsRepo.updateReferralConditional(
      tx,
      { id: referralId, status: 'pending', resultingAppointmentId: null },
      { status: 'accepted' },
    );
    if (claimed.count !== 1) {
      throw new HttpError(409, 'This referral is no longer pending.');
    }

    const appointment = await appointmentsService.bookForReferral(tx, {
      patientProfileId: patientProfile.id,
      doctorProfileId: referral.targetDoctorId,
      availabilitySlotId,
      referralId,
    });

    await referralsRepo.updateReferralConditional(
      tx,
      { id: referralId, status: 'accepted', resultingAppointmentId: null },
      { resultingAppointmentId: appointment.id },
    );

    return referralsRepo.findReferralById(tx, referralId);
  });
}

/**
 * Patient declines a pending referral. Deliberately pending-only: once a
 * referral is accepted it has a live appointment behind it, and the way
 * out is cancelling that appointment — which the cascade below returns to
 * pending (re-bookable), from which declining is then possible. Keeps one
 * narrow transition instead of two overlapping exit paths.
 */
export async function declineReferral(userId: string, referralId: string) {
  const patientProfile = await patientsService.getMyPatientProfile(userId);
  const referral = await referralsRepo.findReferralById(prisma, referralId);
  if (!referral) throw new HttpError(404, 'Referral not found.');
  if (referral.patientProfileId !== patientProfile.id) {
    throw new HttpError(403, 'This referral is not for you.');
  }
  if (referral.status !== 'pending') {
    throw new HttpError(409, 'Only a pending referral can be declined.');
  }

  const updated = await referralsRepo.updateReferralConditional(
    prisma,
    { id: referralId, status: 'pending', resultingAppointmentId: null },
    { status: 'declined' },
  );
  if (updated.count !== 1) {
    throw new HttpError(409, 'This referral is no longer pending.');
  }
  return referralsRepo.findReferralById(prisma, referralId);
}

export async function listMine(userId: string) {
  const patientProfile = await patientsService.getMyPatientProfile(userId);
  return referralsRepo.listReferralsForPatient(patientProfile.id);
}

export async function listCreated(userId: string) {
  const referringDoctor = await doctorsService.getMyDoctorProfile(userId);
  return referralsRepo.listReferralsCreatedBy(referringDoctor.id);
}

/**
 * THE cascade (issue #67, PRD §8.2.3). Called by appointments/services
 * inside the same transaction as the appointment's status transition, so
 * the referral can never be left sitting `accepted` behind a dead
 * appointment:
 *
 *   completed → referral `completed` (closes FR-9's loop; keeps
 *               referral-completion metrics honest)
 *   cancelled → referral back to `pending`, re-bookable — re-accepting
 *               reuses the same snapshot, no re-intake (FR-8); the
 *               cancelled appointment keeps its own referralId link, so
 *               history survives the resultingAppointmentId being cleared
 *   no_show   → noShowCount++, referral back to `pending`; once the count
 *               reaches NO_SHOW_EXPIRY_THRESHOLD the referral is
 *               `expired` instead, with referringDoctorNotifiedAt set —
 *               the flag the referring doctor's view reads (Phase 6 can
 *               later turn it into a real notification)
 *
 * Idempotency: every write is a conditional UPDATE that only matches a
 * referral still `accepted` *and still pointing at this appointment* —
 * a hook that fires a second time after the first one moved the referral
 * matches zero rows and no-ops. The no_show counter therefore advances at
 * most once per real appointment transition, even if called twice.
 */
export async function applyAppointmentOutcome(
  db: Prisma.TransactionClient,
  input: { appointmentId: string; referralId: string; status: 'completed' | 'cancelled' | 'no_show' },
) {
  const stillAccepted = {
    id: input.referralId,
    status: 'accepted' as const,
    resultingAppointmentId: input.appointmentId,
  };

  if (input.status === 'completed') {
    await referralsRepo.updateReferralConditional(db, stillAccepted, { status: 'completed' });
    return;
  }

  if (input.status === 'cancelled') {
    await referralsRepo.updateReferralConditional(db, stillAccepted, {
      status: 'pending',
      resultingAppointmentId: null,
    });
    return;
  }

  // no_show: read the current count to decide pending-vs-expired, then
  // write conditionally. Safe under the caller's transaction: the
  // appointment row was just updated under the same tx (locking it), and
  // resultingAppointmentId is singular — no second accepted appointment
  // can be racing on this referral.
  const referral = await referralsRepo.findReferralById(db, input.referralId);
  if (!referral || referral.status !== 'accepted' || referral.resultingAppointmentId !== input.appointmentId) {
    return; // already processed (or never matched) — idempotent no-op
  }

  const noShowCount = referral.noShowCount + 1;
  if (noShowCount >= NO_SHOW_EXPIRY_THRESHOLD) {
    await referralsRepo.updateReferralConditional(db, stillAccepted, {
      status: 'expired',
      noShowCount,
      referringDoctorNotifiedAt: new Date(),
      // resultingAppointmentId intentionally kept: the appointment that
      // produced the expiring no-show stays linked as the reason.
    });
  } else {
    await referralsRepo.updateReferralConditional(db, stillAccepted, {
      status: 'pending',
      noShowCount,
      resultingAppointmentId: null,
    });
  }
}
