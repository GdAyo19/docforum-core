import { z } from 'zod';

export const createReferralSchema = z.object({
  patientProfileId: z.string().min(1),
  // v1 requires a concrete target doctor — the routing rule for "a
  // specialty, no specific doctor" is an unresolved design gap
  // (ARCHITECTURE.md §6.1.2, issue #6), not silently defaulted here.
  targetDoctorId: z.string().min(1),
  targetSpecialtyId: z.string().min(1).optional(),
  snapshotNotes: z.string().trim().min(1),
});

export const acceptReferralSchema = z.object({
  availabilitySlotId: z.string().min(1),
});
