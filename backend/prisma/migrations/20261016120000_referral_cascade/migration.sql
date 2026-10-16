-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "referralId" TEXT;

-- AlterTable
ALTER TABLE "Referral" ADD COLUMN     "noShowCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "patientProfileId" TEXT NOT NULL,
ADD COLUMN     "referringDoctorId" TEXT NOT NULL,
ADD COLUMN     "referringDoctorNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "resultingAppointmentId" TEXT,
ADD COLUMN     "targetDoctorId" TEXT NOT NULL,
ADD COLUMN     "targetSpecialtyId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Referral_resultingAppointmentId_key" ON "Referral"("resultingAppointmentId");

-- CreateIndex
CREATE INDEX "Referral_patientProfileId_idx" ON "Referral"("patientProfileId");

-- CreateIndex
CREATE INDEX "Referral_referringDoctorId_idx" ON "Referral"("referringDoctorId");

-- CreateIndex
CREATE INDEX "Referral_targetDoctorId_idx" ON "Referral"("targetDoctorId");

-- CreateIndex
CREATE INDEX "Referral_status_idx" ON "Referral"("status");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referringDoctorId_fkey" FOREIGN KEY ("referringDoctorId") REFERENCES "DoctorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_targetDoctorId_fkey" FOREIGN KEY ("targetDoctorId") REFERENCES "DoctorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_resultingAppointmentId_fkey" FOREIGN KEY ("resultingAppointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

