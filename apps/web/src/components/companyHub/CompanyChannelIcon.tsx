import type { CompanyChannelKind } from "@t3tools/contracts";
import { AtSignIcon, MailIcon } from "lucide-react";

import { LinkedInIcon, XBrandIcon } from "../Icons";
import { CHANNEL_NAMES } from "./companyChannels.logic";

const ICONS = { email: MailIcon, x: XBrandIcon, linkedin: LinkedInIcon, threads: AtSignIcon };

export function CompanyChannelIcon(props: {
  readonly kind: CompanyChannelKind;
  readonly className?: string;
}) {
  const Icon = ICONS[props.kind];
  return <Icon aria-label={CHANNEL_NAMES[props.kind]} role="img" className={props.className} />;
}
