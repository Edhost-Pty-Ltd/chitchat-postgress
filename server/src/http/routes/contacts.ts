import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { parse } from '../validate.js';
import { Errors } from '../errors.js';
import { contactsMatchSchema, MAX_CONTACTS } from '../../domain/schemas/user.js';
import { matchContacts } from '../../db/repositories/users.js';

export async function registerContactRoutes(app: FastifyInstance): Promise<void> {
  // POST /contacts/match — registered users matching submitted numbers,
  // privacy-filtered; 413 when more than MAX_CONTACTS numbers (Req 4.4, 4.5).
  app.post('/contacts/match', { preHandler: requireAuth }, async (request) => {
    const { phones } = parse(contactsMatchSchema, request.body);
    if (phones.length > MAX_CONTACTS) {
      throw Errors.payloadTooLarge(`At most ${MAX_CONTACTS} phone numbers per request`);
    }
    // Dedupe before querying.
    const unique = Array.from(new Set(phones));
    const matches = await matchContacts(request.identity!.userId, unique);
    return { matches };
  });
}
