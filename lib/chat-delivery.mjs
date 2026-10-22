// Pairing and chat delivery are distinct. Never suggest another provider's
// onboarding flow for an external Link or imply that a local proxy is that agent.
export function unavailableChatMessage(agent) {
  if (['agent-link', 'ilands-link'].includes(agent?.transport)) {
    return `${agent.name || 'This agent'} uses a paired external Link. This action cannot request an external reply. Open a chat room with this paired agent to send through its Link. No message was delivered to the external agent.`;
  }
  return `${agent?.name || 'This agent'} has no supported room chat connection. Choose a local-model agent or configure a supported chat connector. No external message was delivered.`;
}
