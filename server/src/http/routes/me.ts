import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { parse } from '../validate.js';
import { Errors } from '../errors.js';
import {
  getUserById,
  updateProfile,
  rowToProfile,
  phoneTakenByOther,
  updatePhone,
} from '../../db/repositories/users.js';
import { getPrivacySettings, savePrivacySettings } from '../../db/repositories/privacy.js';
import { profilePatchSchema, updatePhoneSchema, privacySettingsSchema } from '../../domain/schemas/user.js';

export async function registerMeRoutes(app: FastifyInstance): Promise<void> {
  // GET /me — current user's profile (Req 4.2).
  app.get('/me', { preHandler: requireAuth }, async (request) => {
    const userId = request.identity!.userId;
    const row = await getUserById(userId);
    if (!row) throw Errors.notFound('User not found');
    return rowToProfile(row);
  });

  // PATCH /me — update profile (Req 4.3).
  app.patch('/me', { preHandler: requireAuth }, async (request) => {
    const userId = request.identity!.userId;
    const patch = parse(profilePatchSchema, request.body);
    const row = await updateProfile(userId, patch);
    return rowToProfile(row);
  });

  // PUT /me/phone — update phone after a Firebase number change; 409 if taken (Req 4.6).
  app.put('/me/phone', { preHandler: requireAuth }, async (request) => {
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
  app.put('/me/privacy', { preHandler: requireAuth }, async (request) => {
    const settings = parse(privacySettingsSchema, request.body);
    return savePrivacySettings(request.identity!.userId, settings);
  });
}
