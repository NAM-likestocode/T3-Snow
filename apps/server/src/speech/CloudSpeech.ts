import {
  CloudSpeechApiKey,
  CloudSpeechError,
  CloudSpeechModel,
  CloudSpeechModelId,
  SettingsSecretValue,
  isSecretReference,
  type SecretReference,
  type ServerSettingsError,
  type CloudSpeechKeys,
  type CloudSpeechProvider,
  EnvironmentSpeechTranscriptionResult,
  type SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { cloudSpeechLanguages, effectiveSpeechLanguage } from "@t3tools/shared/speech";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import { applySpeechAliases, speechRecognitionWords } from "./customWords.ts";
import { removeSpeechFillerWords } from "./fillerWords.ts";
import { decodeSpeechPcm, SpeechInvalidAudioError } from "./SpeechService.ts";

const endpoints = {
  openai: { url: "https://api.openai.com/v1/audio/transcriptions", model: "gpt-transcribe" },
  xai: { url: "https://api.x.ai/v1/stt", model: "grok-voice-transcribe-2.0" },
  openrouter: { url: "https://openrouter.ai/api/v1/audio/transcriptions" },
  // T3-Snow: Deepgram's pre-recorded endpoint; options travel in the query string.
  deepgram: { url: "https://api.deepgram.com/v1/listen", model: "nova-3" },
};
const OPENROUTER_CATALOG_URL =
  "https://openrouter.ai/api/v1/models?output_modalities=transcription&zdr=true";
const isApiKey = Schema.is(CloudSpeechApiKey);
const isModelId = Schema.is(CloudSpeechModelId);
const sameCredential = Schema.toEquivalence(SettingsSecretValue);
const DeepgramResponse = Schema.Struct({
  results: Schema.Struct({
    channels: Schema.Array(
      Schema.Struct({ alternatives: Schema.Array(Schema.Struct({ transcript: Schema.String })) }),
    ),
  }),
});
const OpenRouterCatalog = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.String) })),
});

function wave(samples: Float32Array) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const tag = (at: number, value: string) =>
    new Uint8Array(buffer, at, 4).set(new TextEncoder().encode(value));
  tag(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, buffer.byteLength - 44, true);
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!;
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}

function audioBody(
  provider: "openai" | "xai",
  audio: ArrayBuffer,
  language: string,
  options: SpeechTranscriptionOptions,
) {
  const form = new FormData();
  form.set("model", endpoints[provider].model);
  if (language !== "auto") form.set(provider === "openai" ? "languages[]" : "language", language);
  for (const term of speechRecognitionWords(
    options.speechHints,
    options.speechCustomWords.map(({ term }) => term),
  )) {
    if (provider === "openai" && /[<>\r\n]/.test(term)) continue;
    form.append(provider === "openai" ? "keywords[]" : "keyterm", term);
  }
  if (provider === "xai") {
    if (language !== "auto") form.set("format", "true");
    form.set(
      "filler_words",
      String(!options.speechRemoveFillerWords || Boolean(options.speechCorrectionWord)),
    );
    if (!options.speechSilenceFiltering) form.set("vad_threshold", "0");
  }
  // xAI ignores options that follow the file part.
  form.set("file", new Blob([audio], { type: "audio/wav" }), "dictation.wav");
  return HttpClientRequest.bodyFormData(form);
}

/** T3-Snow: Deepgram takes the WAV as the raw body and its options as query parameters. */
export function deepgramUrl(language: string, options: SpeechTranscriptionOptions): string {
  const params = new URLSearchParams({ model: endpoints.deepgram.model, smart_format: "true" });
  if (language === "auto") params.set("detect_language", "true");
  else params.set("language", language);
  for (const term of speechRecognitionWords(
    options.speechHints,
    options.speechCustomWords.map(({ term }) => term),
  )) {
    params.append("keyterm", term);
  }
  return `${endpoints.deepgram.url}?${params.toString()}`;
}

function openRouterBody(model: string, audio: ArrayBuffer, language: string) {
  return HttpClientRequest.bodyJsonUnsafe({
    model,
    input_audio: { data: Buffer.from(audio).toString("base64"), format: "wav" },
    ...(language !== "auto" ? { language } : {}),
    provider: { zdr: true },
  });
}

/** T3-Snow: where the fork's earlier Deepgram dictation kept its key. */
const LEGACY_SNOW_DEEPGRAM_SECRET = "voice-deepgram-api-key";

/** T3-Snow: move a Deepgram key saved by the fork's earlier dictation into the voice settings. */
const migrateSnowDeepgramKey = Effect.fn("CloudSpeech.migrateSnowDeepgramKey")(function* (
  settings: ServerSettings.ServerSettingsService["Service"],
) {
  const store = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
  if (Option.isNone(store)) return;
  const legacy = yield* store.value.get(LEGACY_SNOW_DEEPGRAM_SECRET);
  if (Option.isNone(legacy)) return;
  const key = new TextDecoder().decode(legacy.value).trim();
  const current = (yield* settings.getSettings).cloudSpeechCredentials.deepgram;
  if (!current && isApiKey(key)) {
    yield* settings.updateSettings({ cloudSpeechCredentials: { deepgram: key } });
  }
  yield* store.value.remove(LEGACY_SNOW_DEEPGRAM_SECRET);
});

export class CloudSpeech extends Context.Service<
  CloudSpeech,
  {
    readonly configured: Effect.Effect<CloudSpeechKeys, ServerSettingsError>;
    /** OpenRouter's public transcription catalog, cached briefly on this server. */
    readonly models: Effect.Effect<ReadonlyArray<CloudSpeechModel>, CloudSpeechError>;
    readonly setKey: (
      provider: CloudSpeechProvider,
      key: Redacted.Redacted<string> | SecretReference | null,
    ) => Effect.Effect<void, ServerSettingsError>;
    readonly transcribe: (
      provider: CloudSpeechProvider,
      pcm: Uint8Array,
      options: SpeechTranscriptionOptions,
      model?: string | undefined,
    ) => Effect.Effect<string, CloudSpeechError | SpeechInvalidAudioError | ServerSettingsError>;
  }
>()("t3/speech/CloudSpeech") {}

export const layer = Layer.effect(
  CloudSpeech,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const resolver = yield* SecretResolver.SecretResolver;
    const http = yield* HttpClient.HttpClient;
    yield* migrateSnowDeepgramKey(settings).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("speech: could not move the saved Deepgram key", { cause }),
      ),
    );
    const credentials = settings.getSettings.pipe(
      Effect.map((value) => value.cloudSpeechCredentials),
    );
    const configured = credentials.pipe(
      Effect.map(({ openai, xai, openrouter, deepgram }) => ({
        openai: Boolean(openai),
        xai: Boolean(xai),
        openrouter: Boolean(openrouter),
        deepgram: Boolean(deepgram),
      })),
    );
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      http
        .execute(request)
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        );
    const fetchCatalog = Effect.fn("CloudSpeech.catalog")(function* () {
      const unavailable = () =>
        new CloudSpeechError({ provider: "openrouter", reason: "unavailable" });
      const response = yield* execute(HttpClientRequest.get(OPENROUTER_CATALOG_URL)).pipe(
        Effect.mapError(unavailable),
      );
      if (response.status < 200 || response.status >= 300) return yield* unavailable();
      const { data } = yield* HttpClientResponse.schemaBodyJson(OpenRouterCatalog)(response).pipe(
        Effect.mapError(unavailable),
      );
      return data.flatMap(({ id, name }) =>
        isModelId(id) ? [{ id, name: name?.trim() || id }] : [],
      );
    });
    // The catalog is public, so the cache holds no credential or consent state.
    const models = yield* Effect.cachedWithTTL(
      fetchCatalog().pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.fail(new CloudSpeechError({ provider: "openrouter", reason: "unavailable" })),
        }),
      ),
      (exit) => (Exit.isSuccess(exit) ? "10 minutes" : 0),
    );
    const setKey = Effect.fn("CloudSpeech.setKey")(function* (
      provider: CloudSpeechProvider,
      key: Redacted.Redacted<string> | SecretReference | null,
    ) {
      yield* settings.updateSettings({
        cloudSpeechCredentials: {
          [provider]: Redacted.isRedacted(key) ? Redacted.value(key) : (key ?? ""),
        },
      });
    });
    const transcribe = Effect.fn("CloudSpeech.transcribe")(
      function* (
        provider: CloudSpeechProvider,
        pcm: Uint8Array,
        options: SpeechTranscriptionOptions,
        model?: string,
      ) {
        const source = (yield* credentials)[provider];
        if (!source) return yield* new CloudSpeechError({ provider, reason: "missing-key" });
        if (provider === "openrouter" && (!model || !isModelId(model)))
          return yield* new CloudSpeechError({ provider, reason: "model-unavailable" });
        const samples = yield* Effect.try({
          try: () => decodeSpeechPcm(pcm),
          catch: () =>
            new SpeechInvalidAudioError({
              byteLength: pcm.byteLength,
              message: "Invalid PCM audio.",
            }),
        });
        const language = effectiveSpeechLanguage(cloudSpeechLanguages, options.speechLanguage);
        if (provider === "openrouter" && !(yield* models).some((entry) => entry.id === model))
          return yield* new CloudSpeechError({ provider, reason: "model-unavailable" });
        // A vault that locked since the last recording must not authorize a new upload.
        if (isSecretReference(source)) yield* resolver.invalidate([source]);
        const unreadable = () => new CloudSpeechError({ provider, reason: "unreadable-key" });
        const key = yield* requireSettingsSecret(resolver, source).pipe(
          Effect.mapError(unreadable),
        );
        if (!isApiKey(key)) return yield* unreadable();
        const audio = wave(samples);
        const request =
          provider === "deepgram"
            ? HttpClientRequest.post(deepgramUrl(language, options)).pipe(
                HttpClientRequest.setHeader("authorization", `Token ${key}`),
                HttpClientRequest.bodyUint8Array(new Uint8Array(audio), "audio/wav"),
              )
            : HttpClientRequest.post(endpoints[provider].url).pipe(
                HttpClientRequest.bearerToken(Redacted.make(key)),
                provider === "openrouter"
                  ? openRouterBody(model!, audio, language)
                  : audioBody(provider, audio, language, options),
              );
        const unavailable = () => new CloudSpeechError({ provider, reason: "unavailable" });
        // A catalog fetch or vault lookup may have outlived the credential it started with.
        const current = (yield* credentials)[provider];
        if (!current || !sameCredential(source, current))
          return yield* new CloudSpeechError({
            provider,
            reason: current ? "key-changed" : "missing-key",
          });
        const response = yield* execute(request).pipe(Effect.mapError(unavailable));
        if (response.status < 200 || response.status >= 300)
          return yield* new CloudSpeechError({
            provider,
            reason:
              response.status === 429
                ? "rate-limit"
                : [401, 402, 403].includes(response.status)
                  ? "rejected-key"
                  : response.status === 404 && provider === "openrouter"
                    ? "model-unavailable"
                    : "unavailable",
          });
        const text =
          provider === "deepgram"
            ? yield* HttpClientResponse.schemaBodyJson(DeepgramResponse)(response).pipe(
                Effect.map((body) => body.results.channels[0]?.alternatives[0]?.transcript ?? ""),
                Effect.mapError(unavailable),
              )
            : (yield* HttpClientResponse.schemaBodyJson(EnvironmentSpeechTranscriptionResult)(
                response,
              ).pipe(Effect.mapError(unavailable))).text;
        const corrected = applySpeechAliases(text, options.speechCustomWords);
        return (
          options.speechRemoveFillerWords
            ? removeSpeechFillerWords(corrected, language, options.speechCorrectionWord)
            : corrected
        ).trim();
      },
      (effect, provider) =>
        effect.pipe(
          Effect.timeoutOrElse({
            duration: "2 minutes",
            orElse: () => Effect.fail(new CloudSpeechError({ provider, reason: "unavailable" })),
          }),
        ),
    );
    return CloudSpeech.of({ configured, models, setKey, transcribe });
  }),
);
