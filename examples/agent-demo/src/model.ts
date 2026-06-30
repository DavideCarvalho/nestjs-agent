import { FakeModelProvider, type FakeScript } from '@dudousxd/nestjs-agent-testing';

/**
 * A deterministic, offline "model". It branches on the user's text to either answer directly
 * or request a tool, then summarizes the tool result on the next turn — enough to exercise the
 * whole agent loop (read tool auto-exec + action tool HITL) without any API key.
 */
const script: FakeScript = (args, turnIndex) => {
  const lastUser =
    [...args.messages].reverse().find((m) => m.role === 'user' && m.content)?.content?.toLowerCase() ??
    '';

  if (turnIndex === 0) {
    if (lastUser.includes('weather')) {
      const city = /weather in ([a-z\s]+)/i.exec(lastUser)?.[1]?.trim() ?? 'Recife';
      return {
        text: `Let me check the weather in ${city}.`,
        toolCall: { name: 'getWeather', input: { city } },
      };
    }
    if (lastUser.includes('purge') || lastUser.includes('cache')) {
      return {
        text: 'I will purge the app-config cache — that is destructive, so it needs your approval.',
        toolCall: { name: 'purgeCache', input: { key: 'app-config' } },
      };
    }
    return { text: `You said: "${lastUser}". I do not have a tool for that, but I'm here to help.` };
  }

  const toolResults = (args.messages[args.messages.length - 1]?.toolResults ?? []).map(
    (result) => result.output,
  );
  return { text: `All done — the tool returned ${JSON.stringify(toolResults)}.` };
};

export const demoModel = new FakeModelProvider(script);
