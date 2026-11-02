import { z } from 'zod';

export const pushEnabled = () => process.env.PUSH_ENABLED === 'true';
export function validatePushConfig() {
  if (!pushEnabled()) return;
  if (!z.string().uuid().safeParse(process.env.EXPO_PROJECT_ID).success) throw new Error('EXPO_PROJECT_ID must be set when PUSH_ENABLED=true');
  if (process.env.NODE_ENV === 'production' && !process.env.EXPO_ACCESS_TOKEN) throw new Error('EXPO_ACCESS_TOKEN is required for production push security');
}
