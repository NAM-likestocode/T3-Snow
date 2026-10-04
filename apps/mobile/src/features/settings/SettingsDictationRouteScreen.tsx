import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import type { MobileVoiceEngine } from "../voice-input/voiceEngine";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSection } from "./components/SettingsSection";

/** T3-Snow: chooses which engine transcribes dictation on this device. */
export function SettingsDictationRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const deviceAvailable = getLocalVoiceTranscriber() !== null;
  const stored = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.voiceEngine
    : undefined;
  const selected: MobileVoiceEngine | null = preferencesReady
    ? (stored ?? (deviceAvailable ? "device" : "deepgram"))
    : null;
  const options: ReadonlyArray<{
    readonly engine: MobileVoiceEngine;
    readonly label: string;
    readonly description: string;
    readonly disabled: boolean;
  }> = [
    {
      engine: "device",
      label: "On this device",
      description: deviceAvailable
        ? "Private and offline. Uses your phone's own speech recognition."
        : "Not available on this phone.",
      disabled: !deviceAvailable,
    },
    {
      engine: "deepgram",
      label: "Deepgram",
      description:
        "Sends the recording to your T3 Code server, which transcribes it with the Deepgram key saved in its Settings → Voice.",
      disabled: false,
    },
  ];

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Dictation" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Transcription">
          {options.map((option, index) => (
            <SettingsChoiceRow
              key={option.engine}
              label={option.label}
              description={option.description}
              selected={selected === option.engine}
              separated={index > 0}
              disabled={!preferencesReady || option.disabled}
              onPress={() => savePreferences({ voiceEngine: option.engine })}
            />
          ))}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">
          Deepgram needs a key on the server you are connected to. Add it in T3 Code on your
          computer under Settings → Voice.
        </Text>
      </ScrollView>
    </View>
  );
}
