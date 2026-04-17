# usage maintenance

Entry: `extensions/usage.ts`

Notes:

- Network probes use bounded timeout (`PROBE_TIMEOUT_MS`).
- Handles mixed rate-limit/reset formats from providers.
- Failures should degrade to informative text, not hard extension failure.
