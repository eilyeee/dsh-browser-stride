# Bridge guide

- `src/protocol.ts` is shared with the extension. When changing a wire frame,
  update both endpoints and test parsing, authentication and compatibility.
- A connection owns its queued requests, event stream, cancellation signal and
  tool responses. A replaced connection must never acquire its successor's authority.
- Browser credentials do not by themselves authorize Host management. Do not
  expose tokens in discovery, URLs, logs, model input or test fixtures containing
  real secrets.
- Preserve the distinction between dispatch, observed evidence, uncertain side
  effects and task completion. Do not retry a potentially completed write merely
  because its reply was lost.
- `src/contracts/` contains pure rules, not a live run store. Update the relevant
  explanations and focused tests when semantics change.
