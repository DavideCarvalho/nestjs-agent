/**
 * Optional read-side lookup from opaque store `actorRef`s to human display labels.
 *
 * The store keeps `actorRef` opaque by design (no FK into the host's user table — hosts own their
 * own identity schema). That's fine for enforcement and accounting, but a governance/dashboard read
 * surface showing a raw ref ("u_8f21...") instead of a name is a bad experience. Binding an
 * `ActorDirectory` lets those surfaces resolve refs to labels; leaving it unbound just means they
 * render the raw ref. Consumers inject via `AGENT_ACTOR_DIRECTORY`.
 */
export interface ActorDirectory {
  /** Resolve opaque actor refs to display labels. Missing refs may be omitted. */
  resolveDisplay(refs: readonly string[]): Promise<Record<string, string>>;
}
