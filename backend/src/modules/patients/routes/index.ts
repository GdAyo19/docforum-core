import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as patientsController from '../controllers';

export const patientsRouter = Router();

// The patient's own profile — needed so a patient (and, out-of-band, the
// referring doctor flow in referrals) can reference the patientProfileId.
// Own-profile only: no cross-patient reads in v1.
patientsRouter.get('/me', authenticate, requireRole('patient'), patientsController.me);
