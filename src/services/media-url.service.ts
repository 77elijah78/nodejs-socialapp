import { prisma } from '../config/database.js';
import { canonicalUploadUrl, extractUploadMediaKey, isKnownOwnedUploadUrl, isSharedMediaUrl } from '../config/media.js';
import { ValidationError } from '../utils/errors.js';

export type MediaAssetReference = {
  id: string;
  key: string;
  url: string;
  sourceUrl: string | null;
  ownerId: string;
  mimeType: string;
  size: number;
};

export type MediaUrlNormalization = {
  values: Array<string | null>;
  /** Owned assets that may be referenced by the writer, keyed by the input URL. */
  assetsByInput: Map<string, MediaAssetReference>;
};

type NormalizeOptions = {
  rejectInvalid?: boolean;
  /** When set, only assets uploaded by this account are canonicalized. */
  ownerId?: string;
  /** Require the writer to own every owned-upload reference (used for new writes). */
  requireOwnership?: boolean;
};

async function normalize(values: readonly (string | null | undefined)[], options: NormalizeOptions): Promise<MediaUrlNormalization> {
  const strings = values.map(value => typeof value === 'string' ? value : null);
  if (options.rejectInvalid && strings.some(value => value !== null && !isSharedMediaUrl(value))) {
    throw new ValidationError('Invalid shared media URL');
  }

  const safeValues = strings.filter((value): value is string => value !== null && isSharedMediaUrl(value));
  const keys = [...new Set(safeValues.map(extractUploadMediaKey).filter((key): key is string => !!key))];
  const assets = keys.length ? await prisma.mediaAsset.findMany({
    where: { key: { in: keys } },
    select: { id: true, key: true, url: true, sourceUrl: true, ownerId: true, mimeType: true, size: true },
  }) : [];
  const byKey = new Map(assets.map(asset => [asset.key, asset]));
  const assetsByInput = new Map<string, MediaAssetReference>();
  const normalizedValues = strings.map(value => {
    if (value === null || !isSharedMediaUrl(value)) return null;
    const key = extractUploadMediaKey(value);
    const asset = key ? byKey.get(key) : undefined;
    if (!key || !asset || !isKnownOwnedUploadUrl(value, key, asset.url)) return value;
    if (options.ownerId !== undefined && asset.ownerId !== options.ownerId) {
      if (options.requireOwnership) throw new ValidationError('Media references must use files uploaded by this account');
      return value;
    }
    assetsByInput.set(value, asset);
    return canonicalUploadUrl(key);
  });
  return { values: normalizedValues, assetsByInput };
}

/**
 * Validate incoming shared URLs and rewrite owned uploads (by the writing account)
 * to this deployment's canonical media origin, so authorization never depends on
 * whichever host the client used.
 */
export function normalizeSharedMediaReferences(
  values: readonly string[],
  options: { ownerId?: string; requireOwnership?: boolean } = {},
): Promise<MediaUrlNormalization> {
  return normalize(values, { ...options, rejectInvalid: true });
}

/** Canonicalize stored owned-upload links while redacting unsafe legacy URLs. */
export function normalizeStoredMediaReferences(values: readonly (string | null | undefined)[]): Promise<MediaUrlNormalization> {
  return normalize(values, { rejectInvalid: false });
}
