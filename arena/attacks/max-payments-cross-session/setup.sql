-- Run against the local arena test database after applying the repository
-- migrations. The database URL must be a disposable local test database.
INSERT INTO moat.tenants (id, name)
VALUES ('local', 'local arena test tenant')
ON CONFLICT (id) DO NOTHING;
