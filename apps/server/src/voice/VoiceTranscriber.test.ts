import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as VoiceTranscriber from "./VoiceTranscriber.ts";

const makeHarness = Effect.fn("makeVoiceHarness")(function* (
  reply: { readonly status: number; readonly body: unknown },
  options: { readonly failWrites?: boolean } = {},
) {
  const secrets = new Map<string, Uint8Array>();
  const requests = yield* Ref.make<ReadonlyArray<{ url: string; auth: string | undefined }>>([]);
  const client = HttpClient.make((request) =>
    Ref.update(requests, (seen) => [
      ...seen,
      { url: request.url, auth: request.headers.authorization },
    ]).pipe(
      Effect.as(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(reply.body), { status: reply.status }),
        ),
      ),
    ),
  );
  const dependencies = Layer.mergeAll(
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      // Lazy, like the real store: every read sees the latest value.
      get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
      set: (name, value) =>
        options.failWrites
          ? Effect.die(new Error("disk full"))
          : Effect.sync(() => void secrets.set(name, value)),
      remove: (name) => Effect.sync(() => void secrets.delete(name)),
    }),
    Layer.succeed(HttpClient.HttpClient, client),
  );
  const voice = yield* VoiceTranscriber.VoiceTranscriber.pipe(
    Effect.provide(
      Layer.effect(VoiceTranscriber.VoiceTranscriber, VoiceTranscriber.make).pipe(
        Layer.provide(dependencies),
      ),
    ),
  );
  return { voice, requests };
});

const clip = { audioBase64: Buffer.from("opus").toString("base64"), mimeType: "audio/webm" };

describe("VoiceTranscriber", () => {
  it.effect("asks for a key first, then transcribes with it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        status: 200,
        body: { results: { channels: [{ alternatives: [{ transcript: " Hello there. " }] }] } },
      });
      expect(yield* harness.voice.transcribe({ ...clip, language: "" })).toEqual({
        text: null,
        message: "Add a Deepgram API key in Settings → Voice first.",
      });
      expect(yield* harness.voice.setDeepgramKey("  dg-secret  ")).toEqual({
        deepgramKeySet: true,
      });
      expect(yield* harness.voice.transcribe({ ...clip, language: "de" })).toEqual({
        text: "Hello there.",
      });
      const [request] = yield* Ref.get(harness.requests);
      expect(request?.auth).toBe("Token dg-secret");
      expect(yield* harness.voice.setDeepgramKey(null)).toEqual({ deepgramKeySet: false });
    }),
  );

  it.effect("explains a rejected key", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ status: 401, body: { err_msg: "Invalid credentials" } });
      yield* harness.voice.setDeepgramKey("bad");
      expect(yield* harness.voice.transcribe({ ...clip, language: "" })).toEqual({
        text: null,
        message: "Deepgram rejected the API key. Check it in Settings → Voice.",
      });
    }),
  );

  it.effect("reports a key that could not be saved", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ status: 200, body: {} }, { failWrites: true });
      expect(yield* harness.voice.setDeepgramKey("dg-secret")).toEqual({
        deepgramKeySet: false,
        message: "Couldn't update the key in this environment's secret store.",
      });
    }),
  );

  it("detects the language unless one is chosen", () => {
    expect(VoiceTranscriber.buildDeepgramUrl("")).toBe(
      "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&detect_language=true",
    );
    expect(VoiceTranscriber.buildDeepgramUrl("fr")).toBe(
      "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=fr",
    );
  });
});
