import type { FastifyInstance } from 'fastify';
import { requireAuth, requirePrimaryDevice } from '../middleware/auth.js';
import { parse } from '../validate.js';
import { Errors } from '../errors.js';
import {
  getUserById,
  updateProfile,
  rowToProfile,
  rowToBusiness,
  phoneTakenByOther,
  updatePhone,
} from '../../db/repositories/users.js';
import { getPrivacySettings, savePrivacySettings } from '../../db/repositories/privacy.js';
import { isBlocked } from '../../db/repositories/blocks.js';
import { profilePatchSchema, updatePhoneSchema, privacySettingsSchema } from '../../domain/schemas/user.js';

// Owner-only writes are refused on companion devices (old `!isCompanion()` rules).
const ownerOnly = { preHandler: [requireAuth, requirePrimaryDevice] };

export async function registerMeRoutes(app: FastifyInstance): Promise<void> {
  // GET /me — current user's profile (Req 4.2).
  app.get('/me', { preHandler: requireAuth }, async (request) => {
    const userId = request.identity!.userId;
    const row = await getUserById(userId);
    if (!row) throw Errors.notFound('User not found');
    return rowToProfile(row);
  });

  // PATCH /me — update profile (Req 4.3), including the business profile.
  app.patch('/me', ownerOnly, async (request) => {
    const userId = request.identity!.userId;
    const patch = parse(profilePatchSchema, request.body);
    const row = await updateProfile(userId, patch);
    return rowToProfile(row);
  });

  // PUT /me/phone — update phone after a Firebase number change; 409 if taken (Req 4.6).
  app.put('/me/phone', ownerOnly, async (request) => {
    const userId = request.identity!.userId;
    const { phoneNumber } = parse(updatePhoneSchema, request.body);
    if (await phoneTakenByOther(userId, phoneNumber)) {
      throw Errors.conflict('Phone number already in use');
    }
    await updatePhone(userId, phoneNumber);
    return { phoneNumber };
  });

  // GET /me/privacy — read own privacy settings (Req 4.9).
  app.get('/me/privacy', { preHandler: requireAuth }, async (request) => {
    return getPrivacySettings(request.identity!.userId);
  });

  // PUT /me/privacy — update privacy settings (Req 4.10).
  app.put('/me/privacy', ownerOnly, async (request) => {
    const settings = parse(privacySettingsSchema, request.body);
    return savePrivacySettings(request.identity!.userId, settings);
  });

  // GET /users/:userId — public profile lookup used by screens that resolve
  // sender/member names and show a business's profile (catalog, hours,
  // address). Also returns the bits of the target's privacy the app needs
  // (can they be added to groups, is their photo visible) and the block state
  // between the caller and the target — the same data the Firestore client
  // used to read from users/{uid} and users/{uid}/blockedUsers.
  app.get<{ Params: { userId: string } }>(
    '/users/:userId',
    { preHandler: requireAuth },
    async (request) => {
      const viewerId = request.identity!.userId;
      const { userId: targetId } = request.params;
      const row = await getUserById(targetId);
      if (!row) throw Errors.notFound('User not found');

      const [privacy, iBlocked, blockedMe] = await Promise.all([
        getPrivacySettings(targetId),
        isBlocked(viewerId, targetId),
        isBlocked(targetId, viewerId),
      ]);
      const photoHidden = privacy.profilePhoto === 'Nobody' || blockedMe;

      return {
        id: row.id,
        phoneNumber: row.phone_number,
        displayName: row.display_name,
        about: row.about,
        avatarObjectKey: photoHidden ? null : row.avatar_object_key,
        accountType: row.account_type,
        // Public identity signal only. Reporter ids, report times, and the
        // private verification generation are never exposed here.
        identityVerified: row.identity_verified !== false,
        email: row.email,
        website: row.website,
        operationalHours: row.operational_hours,
        ...rowToBusiness(row),
        privacy: {
          groups: privacy.groups,
          profilePhoto: privacy.profilePhoto,
          lastSeen: privacy.lastSeen,
        },
        iBlocked,
        blockedMe,
      };
    },
  );
}
