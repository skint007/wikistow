import { z } from 'zod';
import { sodium } from './sodium.ts';

export {
  AccountId,
  AttachmentId,
  FolderId,
  IdentityId,
  InstallationId,
  MetadataRevisionId,
  PageId,
  RevisionId,
  ShareId,
  SpaceId,
} from '@wikistow/contracts';

/**
 * A random 128-bit ID. Clients create revision and attachment IDs themselves
 * so the IDs can be bound into ciphertext before anything is uploaded.
 *
 *   const revisionId = newId(RevisionId);
 */
export function newId<S extends z.ZodType<unknown, string>>(schema: S): z.output<S> {
  const raw = sodium.to_base64(
    sodium.randombytes_buf(16),
    sodium.base64_variants.URLSAFE_NO_PADDING,
  );
  return schema.parse(raw);
}
