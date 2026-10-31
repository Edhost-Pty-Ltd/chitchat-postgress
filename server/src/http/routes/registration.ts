import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePrimaryDevice } from '../middleware/auth.js';
import { parse } from '../validate.js';
import { Errors } from '../errors.js';
import { completeSelfRegistration, rowToProfile } from '../../db/repositories/users.js';
import { getEnv } from '../../config/env.js';
import {
  RegistrationReceiptError,
  verifySelfRegistrationReceipt,
} from '../../security/registrationReceipt.js';

const registerSchema = z
  .object({
    receipt: z.string().min(20).max(4096),
    profile: z
      .object({
        displayName: z.string().trim().min(1).max(100),
        email: z.string().email().max(254).nullable().optional(),
        website: z.string().max(512).nullable().optional(),
        about: z.string().max(2000).nullable().optional(),
      })
      .strict(),
  })
  .strict();

export async function registerRegistrationRoutes(app: FastifyInstance): Promise<void> {
  // POST /me/register — the only way a phone-verified session becomes an
  // account. It does NOT accept a client claim that the face check passed: it
  // requires Django's signed, short-lived receipt, minted after on-device face
  // enrollment plus a live 1:1 verification. The phone number comes from the
  // verified Firebase token, never from the request body.
  app.post(
    '/me/register',
    { preHandler: [requireAuth, requirePrimaryDevice] },
    async (request, reply) => {
      const identity = request.identity!;
      const { receipt, profile } = parse(registerSchema, request.body);

      let proof;
      try {
        proof = verifySelfRegistrationReceipt(
          receipt,
          getEnv().FACE_VERIFICATION_RECEIPT_SECRET,
        );
      } catch (err) {
        if (err instanceof RegistrationReceiptError) {
          throw Errors.forbidden('Face enrollment could not be confirmed');
        }
        throw err;
      }
      if (proof.sub !== identity.userId) {
        // Same response as a bad signature: do not reveal which part differed.
        throw Errors.forbidden('Face enrollment could not be confirmed');
      }
      if (!identity.phoneNumber) {
        throw Errors.badRequest('A verified phone number is required to register');
      }

      const result = await completeSelfRegistration(identity.userId, identity.phoneNumber, {
        displayName: profile.displayName,
        email: profile.email ?? null,
        website: profile.website ?? null,
        about: profile.about ?? null,
      });
      if (result.state === 'phone_taken') {
        throw Errors.conflict('Phone number already in use');
      }

      request.log.info({ userId: identity.userId, state: result.state }, 'self registration');
      return reply.code(result.state === 'created' ? 201 : 200).send({
        ...rowToProfile(result.row),
        alreadyRegistered: result.state === 'already_registered',
      });
    },
  );
}
