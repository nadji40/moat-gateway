-- An authorization names the payee, pins the account, or both, and covers an
-- invoice only when there is one.
--
-- Both were required because the first workflow was supplier invoices on
-- cards, where every payment has a bill and a named supplier. On a chain
-- neither is true: the address is the payee, a name beside it is a label
-- nothing verifies, and most payments have no invoice behind them. Requiring
-- them there did not add a check, it made callers invent values.
--
-- What still has to be true is that an authorization identifies who is
-- paid, one way or the other.
SET ROLE moat_owner;
BEGIN;

ALTER TABLE moat.payment_authorizations
    ALTER COLUMN payee DROP NOT NULL,
    ALTER COLUMN invoice_id DROP NOT NULL;

ALTER TABLE moat.payment_authorizations
    ADD CONSTRAINT payment_authorizations_identify_the_payee
    CHECK (payee IS NOT NULL OR destination IS NOT NULL);

INSERT INTO moat.schema_migrations (version, name)
VALUES (9, 'payee and invoice optional on an authorization');

COMMIT;
