import type { Request, Response } from 'express';
import * as referralsService from '../services';
import { acceptReferralSchema, createReferralSchema } from '../validation';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';

export async function create(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const input = createReferralSchema.parse(req.body);
  const referral = await referralsService.createReferral(req.user.id, input);
  res.status(201).json(referral);
}

export async function accept(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { availabilitySlotId } = acceptReferralSchema.parse(req.body);
  const referral = await referralsService.acceptReferral(req.user.id, getParam(req, 'referralId'), availabilitySlotId);
  res.status(200).json(referral);
}

export async function decline(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const referral = await referralsService.declineReferral(req.user.id, getParam(req, 'referralId'));
  res.status(200).json(referral);
}

export async function listMine(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const referrals = await referralsService.listMine(req.user.id);
  res.status(200).json(referrals);
}

export async function listCreated(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const referrals = await referralsService.listCreated(req.user.id);
  res.status(200).json(referrals);
}
