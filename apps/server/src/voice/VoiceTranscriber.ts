/**
 * VoiceTranscriber - cloud dictation through Deepgram (T3-Snow).
 *
 * Clients that choose the Deepgram engine send the recorded clip here; the
 * environment calls Deepgram with the API key kept in its secret store, so
 * the key never reaches a client and every device paired with this
 * environment can use it. Local Whisper dictation never comes here.
 *
 * @module voice/VoiceTranscriber
 */
import type { VoiceStatus, VoiceTranscribeInput, VoiceTranscribeResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const DEEPGRAM_KEY_SECRET = "voice-deepgram-api-key";
const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";
const DEEPGRAM_MODEL = "nova-3";
/** Deepgram answers a 10-minute clip well within this. */
const REQUEST_TIMEOUT = "2 minutes";

export class VoiceTranscriber extends Context.Service<
  VoiceTranscriber,
  {
    readonly status: Effect.Effect<VoiceStatus>;
    readonly setDeepgramKey: (apiKey: string | null) => Effect.Effect<VoiceStatus>;
    readonly transcribe: (input: VoiceTranscribeInput) => Effect.Effect<VoiceTranscribeResult>;
  }
>()("t3/voice/VoiceTranscriber") {}

const DeepgramResponse = Schema.Struct({
  results: Schema.Struct({
    channels: Schema.Array(
      Schema.Struct({
        alternatives: Schema.Array(Schema.Struct({ transcript: Schema.String })),
      }),
    ),
  }),
});

/** Query string for one request: detect the language unless one is chosen. */
export function buildDeepgramUrl(language: string): string {
  const params = new URLSearchParams({ model: DEEPGRAM_MODEL, smart_format: "true" });
  const code = language.trim();
  if (code) params.set("language", code);
  else params.set("detect_language", "true");
  return `${DEEPGRAM_LISTEN_URL}?${params.toString()}`;
}

/** A short, human reason for a failed Deepgram call. */
export function describeDeepgramFailure(status: number | null): string {
  if (status === 401 || status === 403) {
    return "Deepgram rejected the API key. Check it in Settings → Voice.";
  }
  if (status === 402) return "Your Deepgram account is out of credit.";
  if (status === 429) return "Deepgram is rate limiting; try again in a moment.";
  if (status !== null && status >= 500) return "Deepgram is having trouble; try again soon.";
  return "Couldn't reach Deepgram. Check the internet connection of the computer running T3 Code.";
}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;

  const readKey = Effect.suspend(() => secrets.get(DEEPGRAM_KEY_SECRET)).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes).trim())),
    Effect.map(Option.filter((key) => key.length > 0)),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

  const status: VoiceTranscriber["Service"]["status"] = readKey.pipe(
    Effect.map((key) => ({ deepgramKeySet: Option.isSome(key) })),
  );

  const setDeepgramKey: VoiceTranscriber["Service"]["setDeepgramKey"] = (apiKey) =>
    (apiKey && apiKey.trim()
      ? secrets.set(DEEPGRAM_KEY_SECRET, new TextEncoder().encode(apiKey.trim()))
      : secrets.remove(DEEPGRAM_KEY_SECRET)
    ).pipe(
      Effect.andThen(status),
      Effect.catchCause((cause) =>
        Effect.logWarning("voice: could not update the Deepgram key", { cause }).pipe(
          Effect.andThen(status),
          Effect.map((current) => ({
            ...current,
            message: "Couldn't update the key in this environment's secret store.",
          })),
        ),
      ),
    );

  const transcribe: VoiceTranscriber["Service"]["transcribe"] = (input) =>
    Effect.gen(function* () {
      const key = yield* readKey;
      if (Option.isNone(key)) {
        return { text: null, message: "Add a Deepgram API key in Settings → Voice first." };
      }
      const audio = Buffer.from(input.audioBase64, "base64");
      if (audio.length === 0) return { text: null, message: "The recording was empty." };
      const outcome = yield* httpClient
        .execute(
          HttpClientRequest.post(buildDeepgramUrl(input.language)).pipe(
            HttpClientRequest.setHeader("authorization", `Token ${key.value}`),
            HttpClientRequest.bodyUint8Array(audio, input.mimeType || "audio/webm"),
          ),
        )
        .pipe(
          Effect.flatMap((response) =>
            response.status >= 200 && response.status < 300
              ? HttpClientResponse.schemaBodyJson(DeepgramResponse)(response).pipe(
                  Effect.map((body): VoiceTranscribeResult => ({
                    text: body.results.channels[0]?.alternatives[0]?.transcript.trim() ?? "",
                  })),
                )
              : Effect.succeed<VoiceTranscribeResult>({
                  text: null,
                  message: describeDeepgramFailure(response.status),
                }),
          ),
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.catchCause((cause) =>
            Effect.logWarning("voice: Deepgram request failed", { cause }).pipe(
              Effect.as<VoiceTranscribeResult>({
                text: null,
                message: describeDeepgramFailure(null),
              }),
            ),
          ),
        );
      return outcome;
    });

  return VoiceTranscriber.of({ status, setDeepgramKey, transcribe });
});

export const layer = Layer.effect(VoiceTranscriber, make);
