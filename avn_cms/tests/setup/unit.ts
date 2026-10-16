// Unit tests never touch a real database: give config harmless values so modules that read
// it at import time load. Integration tests use tests/setup/integration.ts instead.
process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] ??= 'postgresql://unit:unit@127.0.0.1:1/unit_test';
process.env['DATABASE_OWNER_URL'] ??= 'postgresql://unit:unit@127.0.0.1:1/unit_test';
process.env['SESSION_SECRET'] ??= Buffer.alloc(32, 1).toString('base64');
process.env['ENCRYPTION_KEY'] ??= Buffer.alloc(32, 2).toString('base64');
delete process.env['REDIS_URL'];
