---
'@dudousxd/nestjs-agent-core': patch
---

A delegation cycle names the hop that closed it.

`AgentRunInput.delegationPath` is the chain that REACHED a run, so it stops short of the agent
running now — a runner appends its own name only on the way into a child. The refusal read the path
alone, which cost two things:

- **The named chain dropped the running agent.** A real `alpha → beta → alpha` handoff was refused
  as `alpha → alpha`, an edge no deployment declares and nothing an operator can find in their
  configuration.
- **An agent delegating to ITSELF from a top-level turn was not caught.** Nothing has reached such a
  run, so its path is empty and the only thing making the call a cycle is the agent's own name. The
  self-call spent a whole hop before anything noticed.

This run's agent now joins the end of the ancestry, so both the count and the message see the hop
being taken. Found by the AdonisJS sibling while porting this capability, which is what a reference
implementation is for.

The specs pinning this were passing against a `delegationPath` that contained the running agent —
a shape neither runner produces. They now use what a runner actually writes, which is why they can
fail.
