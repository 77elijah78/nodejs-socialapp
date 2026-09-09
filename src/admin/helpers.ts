export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const parseNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const parseDate = (value: unknown): Date | undefined => {
  if (!value || typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

export const parseBoolean = (value: unknown): boolean | undefined => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return undefined;
};

export const buildSearchMode = (search?: string) => search?.trim() || undefined;
