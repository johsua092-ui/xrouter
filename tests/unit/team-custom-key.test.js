import { describe, it, expect } from "vitest";
import { createTeam } from "../../src/lib/db/repos/teamsRepo.js";
import { validateApiKey, getAllowedModelsOfKey, getApiKeyByKey } from "../../src/lib/db/repos/apiKeysRepo.js";

describe("teams custom api key & permitted models", () => {
  it("authenticates custom prefix yteam and enforces permitted models", async () => {
    const customKey = `yteam-${Date.now()}`;
    const team = await createTeam({
      name: `Unit Test Custom ${Date.now()}`,
      apiKey: customKey,
      allowedModels: ["mine"],
    });

    expect(team.apiKey).toBe(customKey);

    const valid = await validateApiKey(customKey);
    expect(valid).toBe(true);

    const keyObj = await getApiKeyByKey(customKey);
    expect(keyObj).not.toBeNull();
    expect(keyObj.name).toContain("Unit Test Custom");

    const allowed = await getAllowedModelsOfKey(customKey);
    expect(allowed).toEqual(["mine"]);
  });
});
