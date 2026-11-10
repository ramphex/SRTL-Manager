import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { cacheAccount, clearAccountData, showSignedOut, signedOutState } from "../src/client/accountCache";

const me = { authenticated: true, setupRequired: false, user: { id: 3, username: "alex_03", role: "admin" as const, mustChangePassword: false } };

describe("account-scoped cache", () => {
  it("names the account the cache belongs to", () => {
    expect(cacheAccount(undefined)).toBeUndefined();
    expect(cacheAccount(signedOutState)).toBeNull();
    expect(cacheAccount(me)).toBe(3);
    expect(cacheAccount({ ...me, user: { ...me.user, id: 4 } })).toBe(4);
  });

  it("drops every query and mutation except the session check", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["me"], me);
    queryClient.setQueryData(["app-version"], { currentVersion: "0.1.5" });
    queryClient.setQueryData(["job", 12], { id: 12, options: { path: "/mnt/plex/movies/Alpha.Bravo (2020)" } });
    await queryClient.getMutationCache().build(queryClient, { mutationFn: async (input: { username: string; password: string }) => input.username }).execute({ username: "alex_03", password: "fixture-password-123" });
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);

    clearAccountData(queryClient);

    expect(queryClient.getQueryCache().getAll().map((query) => query.queryKey)).toEqual([["me"]]);
    expect(queryClient.getMutationCache().getAll()).toEqual([]);
    expect(queryClient.getQueryData(["me"])).toEqual(me);
  });

  it("shows the signed-out state at once on sign-out, then asks the server", async () => {
    const queryClient = new QueryClient();
    let checks = 0;
    queryClient.setQueryData(["me"], me);
    const observer = new QueryObserver(queryClient, { queryKey: ["me"], staleTime: Infinity, queryFn: async () => { checks += 1; return signedOutState; } });
    const unsubscribe = observer.subscribe(() => undefined);
    const pending = showSignedOut(queryClient);
    expect(cacheAccount(queryClient.getQueryData(["me"]))).toBeNull();
    await pending;
    expect(checks).toBe(1);
    expect(observer.getCurrentResult().data).toEqual(signedOutState);
    unsubscribe();
  });
});
