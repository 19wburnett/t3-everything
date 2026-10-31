import { createFileRoute } from "@tanstack/react-router";

import { CompanyHubPage } from "../components/companyHub/CompanyHubPage";

function CompanyHubRoute() {
  const { projectKey } = Route.useParams();
  return <CompanyHubPage projectKey={projectKey} />;
}

export const Route = createFileRoute("/_chat/company/$projectKey")({
  component: CompanyHubRoute,
});
