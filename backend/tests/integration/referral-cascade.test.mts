// Integration tests for the referral cascade rules (issue #67, PRD §8.2.3)
// and the minimal appointment-lifecycle / referral accept-decline
// foundation they react to (issues #3 and #7, not yet merged when this
// landed — folded in here because a cascade with nothing to cascade is
// untestable).
//
// Each transition pair gets its own real HTTP round trip against a real
// Postgres:
//   referral-origin appointment cancelled  → referral back to pending
//   referral-origin appointment no_show    → pending + counted; twice → expired
//   referral-origin appointment completed  → referral completed
// plus idempotency (hook fired twice), re-booking reuse of the snapshot
// (FR-8), decline, access control, and the concurrency gate on accept.
//
// Self-contained: same embedded-Postgres pattern as booking.test.mts —
// own throwaway cluster on port 5438 (5433/5435/5436/5437 are taken by the
// other integration files), migrations applied on start.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5438;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-referral-cascade-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

const emailedTokens = new Map<string, string>();

/** Signup → read the verification link out of the captured email →
 * redeem it. Booking-adjacent mutations (referral create/accept) require
 * a verified address (issue #34's guard), so every actor here verifies. */
async function signupVerified(app: App, role: 'patient' | 'doctor', label: string) {
  const email = `${label}-${runId}@example.com`;
  const res = await request(app).post('/auth/signup').send({
    role,
    email,
    password: 'longenough123',
    fullName: `Cascade ${label}`,
  });
  expect(res.status).toBe(200);
  const token = emailedTokens.get(email);
  expect(token, `no verification email captured for ${email}`).toBeTruthy();
  const verified = await request(app).post('/auth/verify-email').send({ token });
  expect(verified.status).toBe(200);
  return res.body.accessToken as string;
}

describe('referral cascade on referral-origin appointment transitions', () => {
  let app: App;
  let prisma: Prisma;

  let referringDoctorToken: string; // doctor A — creates referrals
  let referringDoctorProfileId: string;
  let specialistToken: string; // doctor B — target of referrals
  let specialistProfileId: string;
  let patientToken: string;
  let patientProfileId: string;
  let otherPatientToken: string;

  let slotIds: string[]; // open slots of the specialist, plenty for every accept below
  let slotCursor = 0;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    // Must be set before the app module (and its PrismaClient) loads —
    // same reasoning as email-verification.test.mts.
    process.env.DATABASE_URL = databaseUrl;

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const authServices = await import('../../src/modules/auth/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;

    authServices.setEmailSender(async (message) => {
      const match = /[?&]token=([^&\s]+)/.exec(message.text);
      if (match) emailedTokens.set(message.to, decodeURIComponent(match[1]));
    });

    referringDoctorToken = await signupVerified(app, 'doctor', 'referring-doc');
    specialistToken = await signupVerified(app, 'doctor', 'specialist-doc');
    patientToken = await signupVerified(app, 'patient', 'cascade-patient');
    otherPatientToken = await signupVerified(app, 'patient', 'cascade-other-patient');

    const referringMe = await request(app)
      .get('/doctors/me')
      .set('Authorization', `Bearer ${referringDoctorToken}`);
    referringDoctorProfileId = referringMe.body.id as string;

    const specialistMe = await request(app).get('/doctors/me').set('Authorization', `Bearer ${specialistToken}`);
    specialistProfileId = specialistMe.body.id as string;

    const patientMe = await request(app).get('/patients/me').set('Authorization', `Bearer ${patientToken}`);
    patientProfileId = patientMe.body.id as string;

    // Two future days of 30-minute slots with the specialist — enough
    // open slots that every accept cycle below gets a fresh one (and a
    // cancelled slot can go back on the shelf without colliding).
    for (const dayOffset of [1, 2]) {
      const date = new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const generate = await request(app)
        .post(`/availability/doctors/${specialistProfileId}/slots/generate`)
        .set('Authorization', `Bearer ${specialistToken}`)
        .send({ date, startHour: 8, endHour: 16, slotLengthMinutes: 30 });
      expect(generate.status).toBe(201);
      expect(generate.body.created).toBeGreaterThan(0);
    }

    const slots = await request(app).get(`/availability/doctors/${specialistProfileId}/slots`);
    expect(slots.body.length).toBeGreaterThanOrEqual(10);
    slotIds = slots.body.map((slot: { id: string }) => slot.id);
  });

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function nextSlotId() {
    const id = slotIds[slotCursor++];
    expect(id, 'ran out of pre-generated specialist slots').toBeTruthy();
    return id;
  }

  async function createReferral(snapshotNotes: string) {
    const res = await request(app)
      .post('/referrals')
      .set('Authorization', `Bearer ${referringDoctorToken}`)
      .send({ patientProfileId, targetDoctorId: specialistProfileId, snapshotNotes });
    expect(res.status).toBe(201);
    return res.body as { id: string; status: string; snapshotNotes: string };
  }

  async function acceptReferral(referralId: string, availabilitySlotId: string) {
    return request(app)
      .post(`/referrals/${referralId}/accept`)
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ availabilitySlotId });
  }

  async function getReferralRow(id: string) {
    const row = await prisma.referral.findUnique({ where: { id } });
    expect(row).toBeTruthy();
    return row!;
  }

  async function getAppointmentRow(id: string) {
    const row = await prisma.appointment.findUnique({ where: { id } });
    expect(row).toBeTruthy();
    return row!;
  }

  it('accept books a referral-origin appointment and links it both ways', async () => {
    const referral = await createReferral('Murmur on exam, please evaluate. — Dr A');

    const acceptRes = await acceptReferral(referral.id, nextSlotId());
    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.status).toBe('accepted');
    expect(acceptRes.body.resultingAppointmentId).toBeTruthy();

    const appointment = await getAppointmentRow(acceptRes.body.resultingAppointmentId);
    expect(appointment.status).toBe('scheduled');
    expect(appointment.origin).toBe('referral');
    expect(appointment.referralId).toBe(referral.id);
    expect(appointment.doctorProfileId).toBe(specialistProfileId);
    expect(appointment.patientProfileId).toBe(patientProfileId);
  });

  it('cancelled referral-origin appointment returns the referral to pending, releases the slot, and re-accept reuses the snapshot (FR-8)', async () => {
    const notes = 'Chest tightness on exertion, family history of CAD. — Dr A';
    const referral = await createReferral(notes);

    const firstAccept = await acceptReferral(referral.id, nextSlotId());
    expect(firstAccept.status).toBe(200);
    const firstAppointmentId = firstAccept.body.resultingAppointmentId as string;
    const firstSlotId = (await getAppointmentRow(firstAppointmentId)).availabilitySlotId;

    // The patient cancels — PRD §8.2.3's first transition pair.
    const cancelRes = await request(app)
      .patch(`/appointments/${firstAppointmentId}/cancel`)
      .set('Authorization', `Bearer ${patientToken}`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('cancelled');

    // Cascade: referral is pending again, re-bookable, nothing dangling.
    const afterCancel = await getReferralRow(referral.id);
    expect(afterCancel.status).toBe('pending');
    expect(afterCancel.resultingAppointmentId).toBeNull();
    expect(afterCancel.noShowCount).toBe(0);
    expect(afterCancel.snapshotNotes).toBe(notes); // untouched

    // The freed future slot goes back on the shelf.
    const releasedSlot = await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: firstSlotId } });
    expect(releasedSlot.status).toBe('open');

    // History survives: the cancelled appointment still points at the referral.
    const cancelled = await getAppointmentRow(firstAppointmentId);
    expect(cancelled.referralId).toBe(referral.id);

    // Re-accept: new appointment, same snapshot — no re-intake anywhere.
    const secondAccept = await acceptReferral(referral.id, nextSlotId());
    expect(secondAccept.status).toBe(200);
    expect(secondAccept.body.status).toBe('accepted');
    expect(secondAccept.body.resultingAppointmentId).not.toBe(firstAppointmentId);
    expect(secondAccept.body.snapshotNotes).toBe(notes);

    // Doctor completes the re-booked visit → referral completes (FR-9's
    // terminal happy path; keeps completion metrics honest).
    const secondAppointmentId = secondAccept.body.resultingAppointmentId as string;
    const completeRes = await request(app)
      .patch(`/appointments/${secondAppointmentId}/status`)
      .set('Authorization', `Bearer ${specialistToken}`)
      .send({ status: 'completed' });
    expect(completeRes.status).toBe(200);

    const afterComplete = await getReferralRow(referral.id);
    expect(afterComplete.status).toBe('completed');
    expect(afterComplete.resultingAppointmentId).toBe(secondAppointmentId);

    // Terminal: a completed appointment can't be moved again, and neither
    // can the referral behind it.
    const replayRes = await request(app)
      .patch(`/appointments/${secondAppointmentId}/status`)
      .set('Authorization', `Bearer ${specialistToken}`)
      .send({ status: 'cancelled' });
    expect(replayRes.status).toBe(409);
    expect((await getReferralRow(referral.id)).status).toBe('completed');
  });

  it('first no-show returns the referral to pending and counts it; second no-show expires it and flags the referring doctor', async () => {
    const referral = await createReferral('Recurrent palpitations, Holter needed. — Dr A');

    const firstAccept = await acceptReferral(referral.id, nextSlotId());
    expect(firstAccept.status).toBe(200);
    const firstAppointmentId = firstAccept.body.resultingAppointmentId as string;

    const noShow1 = await request(app)
      .patch(`/appointments/${firstAppointmentId}/status`)
      .set('Authorization', `Bearer ${specialistToken}`)
      .send({ status: 'no_show' });
    expect(noShow1.status).toBe(200);

    const afterNoShow1 = await getReferralRow(referral.id);
    expect(afterNoShow1.status).toBe('pending'); // re-bookable, not stuck accepted
    expect(afterNoShow1.noShowCount).toBe(1);
    expect(afterNoShow1.resultingAppointmentId).toBeNull();
    expect(afterNoShow1.referringDoctorNotifiedAt).toBeNull(); // not expired yet

    // Re-book and no-show a second time.
    const secondAccept = await acceptReferral(referral.id, nextSlotId());
    expect(secondAccept.status).toBe(200);
    const secondAppointmentId = secondAccept.body.resultingAppointmentId as string;

    const noShow2 = await request(app)
      .patch(`/appointments/${secondAppointmentId}/status`)
      .set('Authorization', `Bearer ${specialistToken}`)
      .send({ status: 'no_show' });
    expect(noShow2.status).toBe(200);

    const afterNoShow2 = await getReferralRow(referral.id);
    expect(afterNoShow2.status).toBe('expired');
    expect(afterNoShow2.noShowCount).toBe(2);
    expect(afterNoShow2.referringDoctorNotifiedAt).toBeTruthy(); // the flag
    // Expired keeps the appointment that killed it as the reason.
    expect(afterNoShow2.resultingAppointmentId).toBe(secondAppointmentId);

    // An expired referral is not re-bookable.
    const reaccept = await acceptReferral(referral.id, nextSlotId());
    expect(reaccept.status).toBe(409);

    // The referring doctor sees the expiry (and the flag) in their list.
    const created = await request(app).get('/referrals/created').set('Authorization', `Bearer ${referringDoctorToken}`);
    expect(created.status).toBe(200);
    const seen = created.body.find((row: { id: string }) => row.id === referral.id);
    expect(seen.status).toBe('expired');
    expect(seen.referringDoctorNotifiedAt).toBeTruthy();
  });

  it('cascade hook is idempotent — a second application of the same outcome is a no-op', async () => {
    const referral = await createReferral('Syncope twice this month. — Dr A');
    const acceptRes = await acceptReferral(referral.id, nextSlotId());
    expect(acceptRes.status).toBe(200);
    const appointmentId = acceptRes.body.resultingAppointmentId as string;

    const referralsService = await import('../../src/modules/referrals/services/index.js');

    // Fire the cancelled cascade twice for the same appointment — the
    // second call must match nothing (conditional UPDATE) and leave the
    // referral exactly where the first call put it.
    await prisma.$transaction((tx) =>
      referralsService.applyAppointmentOutcome(tx, { appointmentId, referralId: referral.id, status: 'cancelled' }),
    );
    await prisma.$transaction((tx) =>
      referralsService.applyAppointmentOutcome(tx, { appointmentId, referralId: referral.id, status: 'cancelled' }),
    );
    let row = await getReferralRow(referral.id);
    expect(row.status).toBe('pending');
    expect(row.noShowCount).toBe(0);

    // Same for no_show: a double-fired hook must not double-count.
    const accept2 = await acceptReferral(referral.id, nextSlotId());
    expect(accept2.status).toBe(200);
    const appointment2 = accept2.body.resultingAppointmentId as string;
    await prisma.$transaction((tx) =>
      referralsService.applyAppointmentOutcome(tx, { appointmentId: appointment2, referralId: referral.id, status: 'no_show' }),
    );
    await prisma.$transaction((tx) =>
      referralsService.applyAppointmentOutcome(tx, { appointmentId: appointment2, referralId: referral.id, status: 'no_show' }),
    );
    row = await getReferralRow(referral.id);
    expect(row.status).toBe('pending');
    expect(row.noShowCount).toBe(1); // not 2
    expect(row.referringDoctorNotifiedAt).toBeNull();

    // And a completed cascade replayed is also a no-op.
    const accept3 = await acceptReferral(referral.id, nextSlotId());
    expect(accept3.status).toBe(200);
    const appointment3 = accept3.body.resultingAppointmentId as string;
    await prisma.$transaction((tx) =>
      referralsService.applyAppointmentOutcome(tx, { appointmentId: appointment3, referralId: referral.id, status: 'completed' }),
    );
    await prisma.$transaction((tx) =>
      referralsService.applyAppointmentOutcome(tx, { appointmentId: appointment3, referralId: referral.id, status: 'completed' }),
    );
    expect((await getReferralRow(referral.id)).status).toBe('completed');
  });

  it('patient can decline a pending referral; declined is terminal', async () => {
    const referral = await createReferral('Possible DVT, needs duplex. — Dr A');

    const declineRes = await request(app)
      .post(`/referrals/${referral.id}/decline`)
      .set('Authorization', `Bearer ${patientToken}`);
    expect(declineRes.status).toBe(200);
    expect(declineRes.body.status).toBe('declined');

    const declineAgain = await request(app)
      .post(`/referrals/${referral.id}/decline`)
      .set('Authorization', `Bearer ${patientToken}`);
    expect(declineAgain.status).toBe(409);

    const acceptDeclined = await acceptReferral(referral.id, nextSlotId());
    expect(acceptDeclined.status).toBe(409);
  });

  it('enforces access control and the transition state machine', async () => {
    const referral = await createReferral('Atypical chest pain, rule out. — Dr A');
    const acceptRes = await acceptReferral(referral.id, nextSlotId());
    expect(acceptRes.status).toBe(200);
    const appointmentId = acceptRes.body.resultingAppointmentId as string;

    // The referring doctor is not the treating doctor here — can't transition.
    const wrongDoctor = await request(app)
      .patch(`/appointments/${appointmentId}/status`)
      .set('Authorization', `Bearer ${referringDoctorToken}`)
      .send({ status: 'completed' });
    expect(wrongDoctor.status).toBe(403);

    // A patient can't use the doctor's transition endpoint at all.
    const patientOnDoctorRoute = await request(app)
      .patch(`/appointments/${appointmentId}/status`)
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ status: 'completed' });
    expect(patientOnDoctorRoute.status).toBe(403);

    // Another patient can't cancel someone else's appointment.
    const otherPatient = await request(app)
      .patch(`/appointments/${appointmentId}/cancel`)
      .set('Authorization', `Bearer ${otherPatientToken}`);
    expect(otherPatient.status).toBe(403);

    // A referral for someone else can't be accepted.
    const otherPatientAccept = await request(app)
      .post(`/referrals/${referral.id}/accept`)
      .set('Authorization', `Bearer ${otherPatientToken}`)
      .send({ availabilitySlotId: nextSlotId() });
    expect(otherPatientAccept.status).toBe(403);

    // Accepting with a slot that belongs to the wrong doctor is refused
    // (and the transaction rolls the slot claim back). The referring
    // doctor has no slots yet — generate one so there's a legitimately
    // bookable-but-wrong-doctor slot to point at.
    const date = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const generate = await request(app)
      .post(`/availability/doctors/${referringDoctorProfileId}/slots/generate`)
      .set('Authorization', `Bearer ${referringDoctorToken}`)
      .send({ date, startHour: 8, endHour: 9, slotLengthMinutes: 30 });
    expect(generate.status).toBe(201);
    const wrongDoctorsSlots = await request(app).get(`/availability/doctors/${referringDoctorProfileId}/slots`);
    expect(wrongDoctorsSlots.body.length).toBeGreaterThan(0);

    const wrongSlotAccept = await acceptReferral(referral.id, wrongDoctorsSlots.body[0].id);
    expect(wrongSlotAccept.status).toBe(409);
    // Referral is still accepted-with-its-own-appointment — the failed
    // accept rolled back cleanly.
    const afterWrongSlot = await getReferralRow(referral.id);
    expect(afterWrongSlot.status).toBe('accepted');
    expect(afterWrongSlot.resultingAppointmentId).toBe(appointmentId);
    const rolledBackSlot = await prisma.availabilitySlot.findUniqueOrThrow({
      where: { id: wrongDoctorsSlots.body[0].id },
    });
    expect(rolledBackSlot.status).toBe('open');

    // Invalid state machine moves: scheduled → scheduled, and doctor
    // completing twice.
    const complete1 = await request(app)
      .patch(`/appointments/${appointmentId}/status`)
      .set('Authorization', `Bearer ${specialistToken}`)
      .send({ status: 'completed' });
    expect(complete1.status).toBe(200);
    const complete2 = await request(app)
      .patch(`/appointments/${appointmentId}/status`)
      .set('Authorization', `Bearer ${specialistToken}`)
      .send({ status: 'completed' });
    expect(complete2.status).toBe(409);
  });

  it('two concurrent accepts of the same referral — exactly one wins', async () => {
    const referral = await createReferral('Asthma poorly controlled. — Dr A');
    const [a, b] = await Promise.all([acceptReferral(referral.id, nextSlotId()), acceptReferral(referral.id, nextSlotId())]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const row = await getReferralRow(referral.id);
    expect(row.status).toBe('accepted');
    // Exactly one appointment exists behind it.
    const appointments = await prisma.appointment.findMany({ where: { referralId: referral.id } });
    expect(appointments).toHaveLength(1);
    expect(row.resultingAppointmentId).toBe(appointments[0].id);
  });

  it('creating a referral validates the referenced patient and doctor', async () => {
    const missingPatient = await request(app)
      .post('/referrals')
      .set('Authorization', `Bearer ${referringDoctorToken}`)
      .send({ patientProfileId: 'no-such-patient', targetDoctorId: specialistProfileId, snapshotNotes: 'x' });
    expect(missingPatient.status).toBe(404);

    const missingDoctor = await request(app)
      .post('/referrals')
      .set('Authorization', `Bearer ${referringDoctorToken}`)
      .send({ patientProfileId, targetDoctorId: 'no-such-doctor', snapshotNotes: 'x' });
    expect(missingDoctor.status).toBe(404);
  });
});
