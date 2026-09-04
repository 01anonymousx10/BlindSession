import db from '../../config/db.js';

export default async function userRoutes(fastify, options) {
  
  // Retrieve public keys (prekey bundle) of a recipient by identity key fingerprint
  fastify.get('/:identity_key_hash', async (request, reply) => {
    const { identity_key_hash } = request.params;

    if (!identity_key_hash) {
      return reply.code(400).send({ error: 'Identity key hash is required' });
    }

    try {
      const selectQuery = `
        SELECT id, public_identity_key, public_prekey, prekey_signature
        FROM users
        WHERE identity_key_hash = $1;
      `;

      const result = await db.query(selectQuery, [identity_key_hash]);

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }

      const user = result.rows[0];

      return reply.send({
        id: user.id,
        public_identity_key: user.public_identity_key,
        public_prekey: user.public_prekey,
        prekey_signature: user.prekey_signature
      });

    } catch (err) {
      fastify.log.error('User lookup failed:', err);
      return reply.code(500).send({ error: 'Internal server error during lookup' });
    }
  });
}
