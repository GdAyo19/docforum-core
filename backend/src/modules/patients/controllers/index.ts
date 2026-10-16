import type { Request, Response } from 'express';
import * as patientsService from '../services';
import { HttpError } from '../../../http-error';

export async function me(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const profile = await patientsService.getMyPatientProfile(req.user.id);
  res.status(200).json(profile);
}
