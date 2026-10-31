import { describe, expect, it } from "@effect/vitest";

import { signOAuth1 } from "./oauth1.ts";

describe("signOAuth1", () => {
  // "Creating a signature" in X's OAuth 1.0a documentation.
  it("matches X's documented example signature", () => {
    const { signature, header } = signOAuth1(
      {
        consumerKey: "xvz1evFS4wEEPTGEFPHBog",
        consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
        accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
        accessTokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
      },
      {
        method: "post",
        url: "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
        bodyParams: { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
        nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
        timestampSeconds: 1318622958,
      },
    );
    expect(signature).toBe("hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
    expect(header).toBe(
      'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1.0"',
    );
  });
});
