import { Router } from 'express';
import { authenticate, requireRole, requireVerifiedEmail } from '../../../middleware/auth';
import * as referralsController from '../controllers';

export const referralsRouter = Router();

// Creating a referral hands a patient to another doctor with clinical
// context attached, and accepting one books a real slot — both are
// mutations that need a trustworthy contact address, same bar as booking
// itself (Phase 8, issue #34's guard).
referralsRouter.post(
  '/',
  authenticate,
  requireRole('doctor'),
  requireVerifiedEmail,
  referralsController.create,
);
referralsRouter.post(
  '/:referralId/accept',
  authenticate,
  requireRole('patient'),
  requireVerifiedEmail,
  referralsController.accept,
);
referralsRouter.post(
  '/:referralId/decline',
  authenticate,
  requireRole('patient'),
  referralsController.decline,
);
referralsRouter.get('/mine', authenticate, requireRole('patient'), referralsController.listMine);
// Referring doctors see the referrals they created — including ones the
// cascade expired after repeated no-shows (referringDoctorNotifiedAt).
referralsRouter.get('/created', authenticate, requireRole('doctor'), referralsController.listCreated);
