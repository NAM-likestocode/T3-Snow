import { createFileRoute } from "@tanstack/react-router";

import { VoiceSettings } from "../components/settings/VoiceSettings";

function SettingsVoiceRoute() {
  return <VoiceSettings />;
}

export const Route = createFileRoute("/_chat/settings/voice")({
  component: SettingsVoiceRoute,
});
