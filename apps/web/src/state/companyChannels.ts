import { createCompanyChannelEnvironmentAtoms } from "@t3tools/client-runtime/state/companyChannels";

import { connectionAtomRuntime } from "../connection/runtime";

export const companyChannelEnvironment =
  createCompanyChannelEnvironmentAtoms(connectionAtomRuntime);
