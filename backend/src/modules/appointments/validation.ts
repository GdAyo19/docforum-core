import { z } from 'zod';

export const bookSlotSchema = z.object({
  availabilitySlotId: z.string().min(1),
});

// Appointment lifecycle (issue #3 slice, PRD §4.2): only the three
// terminal transitions out of `scheduled` are valid — a completed
// appointment can't be un-completed, and a no_show can't become cancelled.
export const updateStatusSchema = z.object({
  status: z.enum(['completed', 'cancelled', 'no_show']),
});
