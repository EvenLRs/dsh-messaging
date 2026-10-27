// Runs the production plugin against the integration fixture with real durable ledger.
process.env.DSH_AUDIT_REGRESSION_ONLY = '1'
require('./lark-integration.cjs')
