import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

const T3_CODE_PROFILES = ["t3code", "t3code-v2", "t3code-dev", "T3 Code (Alpha)", "T3 Code (Dev)"];

it.effect.each([
  { platform: "win32" as const, isDevelopment: false, expected: "t3everything" },
  { platform: "darwin" as const, isDevelopment: true, expected: "t3everything-dev" },
])(
  "never adopts or copies from T3 Code profiles ($platform, development: $isDevelopment)",
  (input) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-profile-" });
      for (const name of T3_CODE_PROFILES) {
        yield* fs.makeDirectory(path.join(directory, name), { recursive: true });
        yield* fs.writeFileString(path.join(directory, name, "Local State"), "T3 Code state");
      }
      const userDataPath = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: input.isDevelopment,
        platform: input.platform,
      });
      assert.equal(userDataPath, path.join(directory, input.expected));
      assert.isFalse(yield* fs.exists(path.join(userDataPath, "Local State")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
