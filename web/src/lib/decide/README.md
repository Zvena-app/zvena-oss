# Pulse and reactions

How zvena's sections learn about each other's changes, and how they react.

## Pulse (`src/lib/pulse`)

One live channel per workspace.

- **Server.** After a write has committed: `emit(ws, { type, ref | refs, by, origin })`. Types: `PULSE_TYPES`.
- **Browser.** `pulse().join(ws)` and `pulse().on(type, fn)`. On an event, a section pulls through its own API. `hello` means the stream reconnected: pull everything.
- **Payload.** Ids only, never content. Permissions were checked by the section's API, so the channel only needs "may read this workspace".
- **Own echo.** A write carries `pulseHeaders()`, so the tab that made it is not poked about it.
- **No stream** (offline, too many tabs, a buffering proxy): a section polls on its own timer; `pulse().live()` says whether it needs to.

## Reactions (`src/lib/decide`)

"When → if → then", kept per workspace.

| Part | Options |
|---|---|
| **When** | `metric`: a live number arrived (`/api/pulse/ingest` with a secret, or typed in); `notes`: a Docs database row was saved |
| **If** | `always`; `compare`: exact and instant, no AI; `ask`: a yes/no question to the decision model |
| **Then** | `notes.done`: status to "Done" (or the checkbox on); `notes.set`: a property by name |

- **On the edge.** A reaction fires when its condition *becomes* true, not on every new number.
- **Chains.** A chain stops at depth 3; a reaction never fires on its own write.
- **Log.** Every decision goes to `dz_decisions`: ids, verdict, confidence, model, timing; never content. Kept 90 days.

### The decision model (optional)

An optional decision model — an RLHF architecture and model — answers typed questions for suggestions and automations. Server-side only, and off unless configured.

- **On/off.** Works once both `ZVENA_AI_URL` and `ZVENA_AI_KEY` are set, in every workspace whose owner has not turned it off (`/api/decide {op:"smart", on:false|true}`, Projects → Settings → Smart suggestions). A workspace nobody switched follows `ZVENA_AI_DEFAULT` (`on` by default; `off` makes it opt-in).
- **One gate.** `ask(ws, …)` checks the workspace's switch itself, before sending and again when the answer arrives (an answer that comes back after the owner turned it off is dropped). Without a registered gate (`setWorkspaceGate`, done by `engine.ts`) nothing is sent.
- **What leaves.** Only the fields listed in the reaction's `fields`, minus any that name a person (an issue's Assignee; person, created/edited-by, e-mail and phone columns). What every Projects call sends is listed in `smart.ts`; operators list it in their Privacy Policy (DEPLOY.md, section 18).
- **Confidence.** `≥ auto`: acts at once. `≥ suggest`: a suggestion a person confirms (`resolve`; tabs get a `decision` event). Below: nothing happens.
- **Never slows the product.** A 1.5 s budget, one retry on 429/529, a 10-minute cache of identical questions, a one-minute breaker after 5 failures in a row. Model down = the reaction does not fire.
- **For sections.** `smart.ts` has typed `noul` / `choice` / `score` questions (e.g. Projects: an issue's priority as a `score`, its kind as a `choice`).

### Plugging in a section

1. **Pulse.** After a write: `emit(ws, { type: "<section>", ref, by, origin: originOf(req) })`.
2. **Model.** `model.ts`: a `When` kind and `Action`s, with their checks in `clean*`.
3. **Adapter.** `adapters.ts`: the subject's facts in `subjectsFor`, the action in `runAction`, through the section's own write path (permissions, history and the pulse then just work).
