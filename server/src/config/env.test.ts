import { describe, it, expect } from 'vitest';
import { loadEnv, EnvError } from './env.js';

// Feature: firebase-to-sockets-redis-postgres-migration, Property 26:
// Missing configuration is reported by name.

const complete: NodeJS.ProcessEnv = {
  PORT: '4000',
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'bucket',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_FORCE_PATH_STYLE: 'true',
  FIREBASE_SERVICE_ACCOUNT_PATH: './sa.json',
  CORS_ORIGINS: 'http://localhost:8081',
};

describe('loadEnv', () => {
  it('parses a complete environment', () => {
    const env = loadEnv(complete);
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('test');
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:8081']);
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('names a single missing required variable', () => {
    const { DATABASE_URL, ...rest } = complete;
    void DATABASE_URL;
    try {
      loadEnv(rest);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      const e = err as EnvError;
      expect(e.missing).toContain('DATABASE_URL');
      expect(e.message).toContain('DATABASE_URL');
    }
  });

  it('names every missing required variable', () => {
    const { DATABASE_URL, REDIS_URL, S3_BUCKET, ...rest } = complete;
    void DATABASE_URL;
    void REDIS_URL;
    void S3_BUCKET;
    try {
      loadEnv(rest);
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as EnvError;
      expect(e.missing).toEqual(
        expect.arrayContaining(['DATABASE_URL', 'REDIS_URL', 'S3_BUCKET']),
      );
    }
  });

  it('requires a Firebase service account via path or json', () => {
    const { FIREBASE_SERVICE_ACCOUNT_PATH, ...rest } = complete;
    void FIREBASE_SERVICE_ACCOUNT_PATH;
    try {
      loadEnv(rest);
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as EnvError;
      expect(e.missing).toContain('FIREBASE_SERVICE_ACCOUNT_PATH');
      expect(e.missing).toContain('FIREBASE_SERVICE_ACCOUNT_JSON');
    }
  });

  it('accepts a Firebase service account provided as raw JSON', () => {
    const { FIREBASE_SERVICE_ACCOUNT_PATH, ...rest } = complete;
    void FIREBASE_SERVICE_ACCOUNT_PATH;
    const env = loadEnv({ ...rest, FIREBASE_SERVICE_ACCOUNT_JSON: '{"project_id":"x"}' });
    expect(env.FIREBASE_SERVICE_ACCOUNT_JSON).toBeDefined();
  });
});
