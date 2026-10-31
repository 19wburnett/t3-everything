import { createBrowserCredentialEnvironmentAtoms } from "@t3tools/client-runtime/state/browserCredentials";

import { connectionAtomRuntime } from "../connection/runtime";

export const browserCredentialEnvironment =
  createBrowserCredentialEnvironmentAtoms(connectionAtomRuntime);
