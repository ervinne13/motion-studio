// Shared mutable state — imported by all client modules.
// Mutation is intentional: ES module named exports are live bindings.
export const state = {
  project:       null,   // full project JSON from server
  selectedFrame: null,   // { clipId, frameIndex, timelineFrame }
};
