import { HttpError } from '../../../http-error';
import * as patientsRepo from '../repositories';

export async function getMyPatientProfile(userId: string) {
  const profile = await patientsRepo.findPatientProfileByUserId(userId);
  if (!profile) throw new HttpError(404, 'No patient profile for this account.');
  return profile;
}

/** Used by the referrals module when a doctor refers a specific patient —
 * the referral flow needs to confirm the referenced patient exists before
 * the FK insert, rather than surfacing a raw constraint error. */
export async function getPatientProfileById(id: string) {
  const profile = await patientsRepo.findPatientProfileById(id);
  if (!profile) throw new HttpError(404, 'Patient profile not found.');
  return profile;
}
