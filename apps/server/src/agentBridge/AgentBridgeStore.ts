import * as AgentBridgeHub from "@t3tools/provider-agent-bridge/server/AgentBridgeHub";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const StateJson = Schema.fromJsonString(AgentBridgeHub.AgentBridgeHubState);
const decodeState = Schema.decodeUnknownEffect(StateJson);
const encodeState = Schema.encodeEffect(StateJson);

/** Keeps open hosted-agent tasks and check-in times across server restarts. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const filePath = path.join(config.stateDir, "agent-bridge.json");
    return AgentBridgeHub.layerWithStore({
      load: Effect.gen(function* () {
        if (!(yield* fs.exists(filePath))) return undefined;
        return yield* decodeState(yield* fs.readFileString(filePath));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not read saved agent bridge tasks", { cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      ),
      save: (state) =>
        encodeState(state).pipe(
          Effect.flatMap((contents) => writeFileStringAtomically({ filePath, contents })),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not save agent bridge tasks", { cause }),
          ),
        ),
    });
  }),
);
