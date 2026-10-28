# Extension guide

- Background, content and panel are different trust boundaries. Never trust a
  page, frame, title or model output to grant permissions or select a new target.
- Check target identity and authorization immediately before side effects;
  preserve cancellation, navigation and service-worker lifecycle semantics.
- `src/background/write-queue.ts` orders live worker writes only. Preserve its
  bounded admission, cancellation and revocation semantics; do not describe it
  as durable recovery or proof of a completed business action.
- Keep credentials in trusted extension contexts and out of webpage messages,
  URLs, diagnostics and page snapshots.
- Keep Chrome and Firefox builds working or explicitly document a supported
  difference. Update localized UI strings together.
- Use controlled test pages and synthetic data. Do not exercise writes against
  a real account without an explicitly authorized test environment.
